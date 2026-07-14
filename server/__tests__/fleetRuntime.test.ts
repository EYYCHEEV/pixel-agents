import { describe, expect, it } from 'vitest';

import type { StateAdapter } from '../../core/src/adapter.js';
import type { FleetSnapshot } from '../../core/src/fleet.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import {
  fleetMetaFromAgent,
  FleetRuntime,
  parseFleetSnapshot,
} from '../src/fleetRuntime.js';
import type { AgentState } from '../src/types.js';

function snapshot(overrides: Partial<FleetSnapshot> = {}): FleetSnapshot {
  return {
    protocolVersion: 1,
    providerId: 'omp',
    hostId: 'local-host',
    sourceId: 'omp-process-1',
    sentAt: 1_000,
    leaseTtlMs: 5_000,
    agents: [
      {
        sessionId: 'session-1',
        agentId: 'Main',
        role: 'main',
        projectLabel: 'pixel-agents',
        activity: 'Implementing fleet runtime',
        status: 'running',
        sequence: 1,
        updatedAt: 1_000,
      },
      {
        sessionId: 'session-1',
        agentId: 'contract-reviewer',
        parent: { sessionId: 'session-1', agentId: 'Main' },
        role: 'reviewer',
        status: 'waiting',
        sequence: 1,
        updatedAt: 1_000,
      },
    ],
    ...overrides,
  };
}

describe('FleetRuntime', () => {
  it('creates one character per stable identity and resolves parent lineage', () => {
    const store = new AgentStateStore();
    const runtime = new FleetRuntime(store);

    expect(runtime.applySnapshot(snapshot(), 1_000)).toEqual({
      created: 2,
      updated: 0,
      ignored: 0,
      disconnected: 0,
    });
    expect(store.size).toBe(2);

    const agents = [...store.values()];
    const main = agents.find((agent) => agent.fleetAgentId === 'Main');
    const child = agents.find((agent) => agent.fleetAgentId === 'contract-reviewer');
    expect(main).toBeDefined();
    expect(fleetMetaFromAgent(main!)?.isChild).toBeUndefined();
    expect(child?.leadAgentId).toBe(main?.id);
    expect(fleetMetaFromAgent(child!)).toMatchObject({
      providerId: 'omp',
      hostId: 'local-host',
      sessionId: 'session-1',
      agentId: 'contract-reviewer',
      parentAgentId: main?.id,
      isChild: true,
      status: 'waiting',
    });
  });

  it('allocates around IDs already owned by restored agents', () => {
    const store = new AgentStateStore();
    const restored = { id: 1, sessionId: 'restored-session' } as unknown as AgentState;
    store.set(restored.id, restored);
    const runtime = new FleetRuntime(store);

    runtime.applySnapshot(snapshot({ agents: [snapshot().agents[0]] }), 1_000);

    expect(store.get(1)).toBe(restored);
    expect([...store.values()].find((agent) => agent.fleetAgentId === 'Main')?.id).toBe(2);
  });

  it('reconciles parent lineage when a child arrives before its parent', () => {
    const store = new AgentStateStore();
    const runtime = new FleetRuntime(store);
    const messages: Record<string, unknown>[] = [];
    store.on('broadcast', (message) => messages.push(message));
    const [main, child] = snapshot().agents;

    runtime.applySnapshot(snapshot({ sourceId: 'child-source', agents: [child] }), 1_000);
    const childState = [...store.values()][0];
    expect(childState.leadAgentId).toBeUndefined();
    expect(fleetMetaFromAgent(childState)).toMatchObject({
      isChild: true,
      parentAgentId: undefined,
    });

    runtime.applySnapshot(
      snapshot({ sourceId: 'main-source', sentAt: 1_100, agents: [main] }),
      1_100,
    );
    const mainState = [...store.values()].find((agent) => agent.fleetAgentId === 'Main');
    expect(childState.leadAgentId).toBe(mainState?.id);
    expect(messages.at(-1)).toMatchObject({
      type: 'agentFleetUpdated',
      id: childState.id,
      fleet: { parentAgentId: mainState?.id },
    });
  });

  it('rejects stale per-agent sequence updates', () => {
    const store = new AgentStateStore();
    const runtime = new FleetRuntime(store);
    runtime.applySnapshot(snapshot(), 1_000);

    const stale = snapshot({
      sentAt: 1_100,
      agents: [
        {
          sessionId: 'session-1',
          agentId: 'Main',
          status: 'parked',
          sequence: 0,
          updatedAt: 1_100,
        },
      ],
    });
    const result = runtime.applySnapshot(stale, 1_100);

    expect(result.ignored).toBe(1);
    expect([...store.values()].find((agent) => agent.fleetAgentId === 'Main')?.fleetStatus).toBe(
      'running',
    );
  });

  it('ignores out-of-order source snapshots without renewing or replacing the lease', () => {
    const store = new AgentStateStore();
    const runtime = new FleetRuntime(store);
    runtime.applySnapshot(snapshot({ leaseTtlMs: 1_000 }), 1_000);

    const result = runtime.applySnapshot(
      snapshot({
        sentAt: 900,
        leaseTtlMs: 1_000,
        agents: [snapshot().agents[0]],
      }),
      1_500,
    );

    expect(result).toEqual({ created: 0, updated: 0, ignored: 1, disconnected: 0 });
    expect(
      [...store.values()].find((agent) => agent.fleetAgentId === 'contract-reviewer')
        ?.fleetStatus,
    ).toBe('waiting');
    expect(runtime.sweepExpired(2_001)).toBe(2);
  });

  it('keeps connected authoritative telemetry ahead of newer inferred recovery', () => {
    const store = new AgentStateStore();
    const runtime = new FleetRuntime(store);
    const main = snapshot().agents[0];
    runtime.applySnapshot(snapshot({ agents: [main] }), 1_000);

    const result = runtime.applySnapshot(
      snapshot({
        sourceId: 'recovery:omp',
        inferred: true,
        sentAt: 2_000,
        agents: [{ ...main, status: 'idle', updatedAt: 2_000 }],
      }),
      2_000,
    );

    expect(result).toMatchObject({ updated: 0, ignored: 1 });
    expect([...store.values()][0]).toMatchObject({
      sourceId: 'omp-process-1',
      fleetStatus: 'running',
      fleetInferred: false,
    });
  });

  it('lets authoritative telemetry replace recovery and recovery resume after disconnection', () => {
    const store = new AgentStateStore();
    const runtime = new FleetRuntime(store);
    const main = snapshot().agents[0];
    runtime.applySnapshot(
      snapshot({
        sourceId: 'recovery:omp',
        inferred: true,
        leaseTtlMs: 1_000,
        agents: [{ ...main, status: 'idle' }],
      }),
      1_000,
    );

    runtime.applySnapshot(
      snapshot({
        sourceId: 'omp-process-exact',
        sentAt: 900,
        leaseTtlMs: 1_000,
        agents: [{ ...main, status: 'running', updatedAt: 900 }],
      }),
      1_100,
    );
    expect([...store.values()][0]).toMatchObject({
      sourceId: 'omp-process-exact',
      fleetStatus: 'running',
      fleetInferred: false,
    });

    expect(runtime.sweepExpired(2_101)).toBe(1);
    runtime.applySnapshot(
      snapshot({
        sourceId: 'recovery:omp',
        inferred: true,
        sentAt: 2_200,
        agents: [{ ...main, status: 'idle', sequence: 2, updatedAt: 2_200 }],
      }),
      2_200,
    );
    expect([...store.values()][0]).toMatchObject({
      sourceId: 'recovery:omp',
      fleetStatus: 'idle',
      fleetInferred: true,
    });
  });

  it('does not let an expired source disconnect an identity adopted by a newer source', () => {
    const store = new AgentStateStore();
    const runtime = new FleetRuntime(store);
    const main = snapshot().agents[0];
    runtime.applySnapshot(snapshot({ leaseTtlMs: 1_000, agents: [main] }), 1_000);

    runtime.applySnapshot(
      snapshot({
        sourceId: 'omp-process-2',
        sentAt: 2_000,
        leaseTtlMs: 5_000,
        agents: [{ ...main, status: 'idle', updatedAt: 2_000 }],
      }),
      2_000,
    );

    expect(runtime.sweepExpired(2_001)).toBe(0);
    expect([...store.values()][0]).toMatchObject({
      sourceId: 'omp-process-2',
      fleetStatus: 'idle',
    });
  });

  it('restores a disconnected source from an unchanged heartbeat projection', () => {
    const store = new AgentStateStore();
    const runtime = new FleetRuntime(store);
    const heartbeat = snapshot({
      leaseTtlMs: 1_000,
      agents: [snapshot().agents[0]],
    });
    runtime.applySnapshot(heartbeat, 1_000);
    expect(runtime.sweepExpired(2_001)).toBe(1);
    expect([...store.values()][0]?.fleetStatus).toBe('disconnected');

    expect(runtime.applySnapshot({ ...heartbeat, sentAt: 2_100 }, 2_100)).toMatchObject({
      updated: 1,
      ignored: 0,
    });
    expect([...store.values()][0]?.fleetStatus).toBe('running');
  });

  it('rejects a lower sequence after a disconnected source returns', () => {
    const store = new AgentStateStore();
    const runtime = new FleetRuntime(store);
    const heartbeat = snapshot({
      leaseTtlMs: 1_000,
      agents: [snapshot().agents[0]],
    });
    runtime.applySnapshot(heartbeat, 1_000);
    expect(runtime.sweepExpired(2_001)).toBe(1);

    const stale = {
      ...heartbeat,
      sentAt: 2_100,
      agents: [{ ...heartbeat.agents[0], sequence: 0, updatedAt: 2_100 }],
    };
    expect(runtime.applySnapshot(stale, 2_100)).toMatchObject({ updated: 0, ignored: 1 });
    expect([...store.values()][0]?.fleetStatus).toBe('disconnected');
  });

  it('retains source ordering after its live lease expires', () => {
    const store = new AgentStateStore();
    const runtime = new FleetRuntime(store);
    runtime.applySnapshot(snapshot({ leaseTtlMs: 1_000 }), 1_000);
    expect(runtime.sweepExpired(2_001)).toBe(2);

    const stale = snapshot({ sentAt: 900, leaseTtlMs: 1_000 });
    expect(runtime.applySnapshot(stale, 2_100)).toEqual({
      created: 0,
      updated: 0,
      ignored: 2,
      disconnected: 0,
    });
    expect([...store.values()].every((agent) => agent.fleetStatus === 'disconnected')).toBe(true);
  });

  it('reserves persisted agent IDs before fleet allocation', () => {
    const store = new AgentStateStore();
    store.setAdapter({
      loadAgents: () => [{ id: 7 }],
    } as unknown as StateAdapter);
    const runtime = new FleetRuntime(store);

    runtime.applySnapshot(snapshot({ agents: [snapshot().agents[0]] }), 1_000);

    expect([...store.keys()]).toEqual([8]);
    expect(store.nextAgentId.current).toBe(9);
  });

  it('marks missing and expired source agents disconnected while preserving completed agents', () => {
    const store = new AgentStateStore();
    const runtime = new FleetRuntime(store);
    runtime.applySnapshot(snapshot(), 1_000);

    runtime.applySnapshot(
      snapshot({
        sentAt: 2_000,
        agents: [
          {
            sessionId: 'session-1',
            agentId: 'Main',
            status: 'completed',
            sequence: 2,
            updatedAt: 2_000,
          },
        ],
      }),
      2_000,
    );

    const child = [...store.values()].find(
      (agent) => agent.fleetAgentId === 'contract-reviewer',
    );
    expect(child?.fleetStatus).toBe('disconnected');
    expect(runtime.sweepExpired(7_001)).toBe(0);
    expect([...store.values()].find((agent) => agent.fleetAgentId === 'Main')?.fleetStatus).toBe(
      'completed',
    );
  });

  it('broadcasts durable status changes for existing agents', () => {
    const store = new AgentStateStore();
    const runtime = new FleetRuntime(store);
    const messages: Record<string, unknown>[] = [];
    store.on('broadcast', (message) => messages.push(message));
    runtime.applySnapshot(snapshot({ agents: [snapshot().agents[0]] }), 1_000);

    runtime.applySnapshot(
      snapshot({
        sentAt: 2_000,
        agents: [
          {
            ...snapshot().agents[0],
            status: 'parked',
            activity: 'Parked',
            sequence: 2,
            updatedAt: 2_000,
          },
        ],
      }),
      2_000,
    );

    expect(messages.at(-1)).toMatchObject({
      type: 'agentStatus',
      status: 'parked',
      activity: 'Parked',
    });
  });

  it('broadcasts provider metadata changes for existing agents', () => {
    const store = new AgentStateStore();
    const runtime = new FleetRuntime(store);
    const messages: Record<string, unknown>[] = [];
    store.on('broadcast', (message) => messages.push(message));
    const main = snapshot().agents[0];
    runtime.applySnapshot(snapshot({ agents: [main] }), 1_000);

    runtime.applySnapshot(
      snapshot({
        sentAt: 2_000,
        agents: [
          {
            ...main,
            role: 'coordinator',
            model: 'gpt-5.6',
            projectLabel: 'next-project',
            sequence: 2,
            updatedAt: 2_000,
          },
        ],
      }),
      2_000,
    );

    expect(messages.at(-1)).toMatchObject({
      type: 'agentFleetUpdated',
      fleet: {
        role: 'coordinator',
        model: 'gpt-5.6',
        projectLabel: 'next-project',
      },
    });
  });
});

describe('parseFleetSnapshot', () => {
  it('accepts the canonical metadata-only contract', () => {
    expect(parseFleetSnapshot(snapshot()).ok).toBe(true);
  });

  it('accepts and preserves inferred recovery metadata', () => {
    const parsed = parseFleetSnapshot(snapshot({ inferred: true }));
    expect(parsed).toMatchObject({ ok: true, value: { inferred: true } });
  });

  it('rejects a non-boolean inferred marker', () => {
    expect(parseFleetSnapshot({ ...snapshot(), inferred: 'yes' })).toEqual({
      ok: false,
      error: 'inferred must be a boolean',
    });
  });

  it('rejects sensitive or unknown producer fields', () => {
    expect(
      parseFleetSnapshot({
        ...snapshot(),
        agents: [{ ...snapshot().agents[0], prompt: 'secret prompt' }],
      }),
    ).toEqual({ ok: false, error: 'agents[0] contains unknown field: prompt' });
  });

  it('rejects duplicate stable identities', () => {
    const agent = snapshot().agents[0];
    const parsed = parseFleetSnapshot({ ...snapshot(), agents: [agent, agent] });
    expect(parsed).toEqual({ ok: false, error: 'agents[1] duplicates an agent identity' });
  });
});
