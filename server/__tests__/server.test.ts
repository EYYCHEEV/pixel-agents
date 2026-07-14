import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { FleetRuntime } from '../src/fleetRuntime.js';

// Use isolated temp HOME to avoid touching real ~/.pixel-agents/
let tmpBase: string;
let serverJsonDir: string;
let serverJsonPath: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpBase };
});

// Must import AFTER mock setup
const { PixelAgentsServer } = await import('../src/server.js');

async function postHook(
  port: number,
  token: string,
  body: string,
  providerId = 'claude',
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/hooks/${providerId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body,
  });
}

async function postFleet(port: number, token: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/api/fleet`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function connectWebSocket(port: number): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  socket.addEventListener('open', () => resolve(), { once: true });
  socket.addEventListener('error', () => reject(new Error('WebSocket connection failed')), {
    once: true,
  });
  await promise;
  return socket;
}

function waitForMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const { promise, resolve } = Promise.withResolvers<Record<string, unknown>>();
  const onMessage = (event: MessageEvent): void => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (!predicate(message)) return;
    socket.removeEventListener('message', onMessage);
    resolve(message);
  };
  socket.addEventListener('message', onMessage);
  return promise;
}

describe('PixelAgentsServer', () => {
  let server: InstanceType<typeof PixelAgentsServer>;

  beforeEach(() => {
    tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'pxl-server-test-'));
    serverJsonDir = path.join(tmpBase, '.pixel-agents');
    serverJsonPath = path.join(serverJsonDir, 'server.json');
    fs.mkdirSync(serverJsonDir, { recursive: true });
    server = new PixelAgentsServer();
  });

  afterEach(() => {
    server?.stop();
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // 1. Server starts and returns config
  it('starts and returns config with port, token, pid', async () => {
    const config = await server.start();
    expect(config.port).toBeGreaterThan(0);
    expect(config.token).toBeTruthy();
    expect(config.pid).toBe(process.pid);
    expect(config.startedAt).toBeGreaterThan(0);
  });

  // 2. Health endpoint returns 200 + uptime
  it('health endpoint returns 200 with uptime', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; uptime: number; pid: number };
    expect(body.status).toBe('ok');
    expect(body.uptime).toBeGreaterThanOrEqual(0);
    expect(body.pid).toBe(process.pid);
  });

  // 3. Hook endpoint requires auth
  it('hook endpoint returns 401 without auth', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/hooks/claude`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  // 4. Hook endpoint accepts valid auth
  it('hook endpoint returns 200 with valid auth', async () => {
    const config = await server.start();
    const res = await postHook(
      config.port,
      config.token,
      JSON.stringify({ session_id: 'test', hook_event_name: 'Stop' }),
    );
    expect(res.status).toBe(200);
  });

  // 5. Hook callback fires on valid event
  it('hook callback fires on valid event', async () => {
    const config = await server.start();
    const received: Array<{ providerId: string; event: Record<string, unknown> }> = [];
    server.onHookEvent((providerId: string, event: Record<string, unknown>) => {
      received.push({ providerId, event });
    });

    await postHook(
      config.port,
      config.token,
      JSON.stringify({ session_id: 'abc', hook_event_name: 'Stop' }),
    );

    expect(received).toHaveLength(1);
    expect(received[0].providerId).toBe('claude');
    expect(received[0].event.session_id).toBe('abc');
    expect(received[0].event.hook_event_name).toBe('Stop');
  });

  // 6. Hook endpoint rejects oversized body
  it('hook endpoint returns 413 for oversized body', async () => {
    const config = await server.start();
    const bigBody = 'x'.repeat(70_000); // > 64KB
    const res = await postHook(config.port, config.token, bigBody);
    expect(res.status).toBe(413);
  });

  // 7. Hook endpoint rejects invalid JSON
  it('hook endpoint returns 400 for invalid JSON', async () => {
    const config = await server.start();
    const res = await postHook(config.port, config.token, 'not json {{{');
    expect(res.status).toBe(400);
  });

  // 8. Hook endpoint rejects missing provider ID
  it('hook endpoint returns 400 for missing provider ID', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/api/hooks/`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}` },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });

  // 9. server.json written
  it('writes server.json with port, pid, token', async () => {
    const config = await server.start();
    const json = JSON.parse(fs.readFileSync(serverJsonPath, 'utf-8'));
    expect(json.port).toBe(config.port);
    expect(json.pid).toBe(process.pid);
    expect(json.token).toBe(config.token);
  });

  // 10. Second instance reuses existing server
  it('second instance reuses existing server and mirrors its fleet snapshots', async () => {
    const ownerStore = new AgentStateStore();
    const ownerFleet = new FleetRuntime(ownerStore);
    const config1 = await server.start({
      store: ownerStore,
      fleetRuntime: ownerFleet,
      embedded: true,
    });

    const now = Date.now();
    const response = await postFleet(config1.port, config1.token, {
      protocolVersion: 1,
      providerId: 'omp',
      hostId: 'local-host',
      sourceId: 'omp-process-1',
      sentAt: now,
      leaseTtlMs: 5_000,
      agents: [
        {
          sessionId: 'omp-session',
          agentId: 'Main',
          status: 'running',
          sequence: 1,
          updatedAt: now,
        },
      ],
    });
    expect(response.status).toBe(200);
    const replicaStore = new AgentStateStore();
    const replicaFleet = new FleetRuntime(replicaStore);
    const server2 = new PixelAgentsServer();
    const config2 = await server2.start({
      store: replicaStore,
      fleetRuntime: replicaFleet,
      embedded: true,
    });
    expect(config2.port).toBe(config1.port);
    expect(config2.pid).toBe(config1.pid);
    await vi.waitFor(() => expect([...replicaStore.values()]).toHaveLength(1));
    expect([...replicaStore.values()][0]).toMatchObject({
      sessionId: 'omp-session',
      fleetAgentId: 'Main',
      fleetStatus: 'running',
    });

    server.stop();
    await vi.waitFor(
      () => expect(server2.getConfig()?.port).not.toBe(config1.port),
      { timeout: 3_000 },
    );
    const promoted = server2.getConfig();
    expect(promoted).not.toBeNull();
    const health = await fetch(`http://127.0.0.1:${promoted!.port}/api/health`);
    expect(health.status).toBe(200);

    server2.stop();
    replicaFleet.dispose();
    ownerFleet.dispose();
  });

  // 11. server.json cleaned up on stop
  it('deletes server.json on stop', async () => {
    await server.start();
    expect(fs.existsSync(serverJsonPath)).toBe(true);
    server.stop();
    expect(fs.existsSync(serverJsonPath)).toBe(false);
  });

  // 12. server.json NOT deleted if PID mismatch
  it('does not delete server.json if PID mismatch', async () => {
    // Write fake server.json with different PID
    fs.writeFileSync(
      serverJsonPath,
      JSON.stringify({ port: 9999, pid: 999999, token: 'fake', startedAt: 0 }),
    );
    // Server never started (it would reuse), just stop
    const server2 = new PixelAgentsServer();
    server2.stop();
    expect(fs.existsSync(serverJsonPath)).toBe(true);
  });

  // 13. Unknown route returns 404
  it('unknown route returns 404', async () => {
    const config = await server.start();
    const res = await fetch(`http://127.0.0.1:${config.port}/random/path`);
    expect(res.status).toBe(404);
  });

  // 14. Hook callback does NOT fire for events missing required fields
  it('hook callback does not fire for events without session_id', async () => {
    const config = await server.start();
    const received: unknown[] = [];
    server.onHookEvent((_pid: string, event: Record<string, unknown>) => received.push(event));

    await postHook(
      config.port,
      config.token,
      JSON.stringify({ hook_event_name: 'Stop' }), // missing session_id
    );

    expect(received).toHaveLength(0);
  });

  it('fleet endpoint requires auth and rejects unknown sensitive fields', async () => {
    const store = new AgentStateStore();
    const fleetRuntime = new FleetRuntime(store);
    const config = await server.start({ store, fleetRuntime, embedded: true });
    const payload = {
      protocolVersion: 1,
      providerId: 'omp',
      hostId: 'local-host',
      sourceId: 'omp-process-1',
      sentAt: 1_000,
      leaseTtlMs: 5_000,
      agents: [],
    };

    const unauthorized = await fetch(`http://127.0.0.1:${config.port}/api/fleet`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    expect(unauthorized.status).toBe(401);

    const invalid = await postFleet(config.port, config.token, { ...payload, prompt: 'secret' });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: 'unknown field: prompt' });
  });

  it('fleet endpoint projects authenticated agents into the shared store', async () => {
    const store = new AgentStateStore();
    const fleetRuntime = new FleetRuntime(store);
    const config = await server.start({ store, fleetRuntime, embedded: true });
    const response = await postFleet(config.port, config.token, {
      protocolVersion: 1,
      providerId: 'codex',
      hostId: 'local-host',
      sourceId: 'codex-process-1',
      sentAt: 1_000,
      leaseTtlMs: 5_000,
      agents: [
        {
          sessionId: 'thread-1',
          agentId: 'Main',
          status: 'running',
          sequence: 1,
          updatedAt: 1_000,
        },
      ],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      created: 1,
      updated: 0,
      ignored: 0,
      disconnected: 0,
    });
    expect([...store.values()][0]).toMatchObject({
      providerId: 'codex',
      hostId: 'local-host',
      fleetAgentId: 'Main',
      fleetStatus: 'running',
    });
  });

  it('accepts valid fleet snapshots larger than the hook payload limit', async () => {
    const store = new AgentStateStore();
    const fleetRuntime = new FleetRuntime(store);
    const config = await server.start({ store, fleetRuntime, embedded: true });
    const label = 'x'.repeat(160);
    const agents = Array.from({ length: 100 }, (_, index) => ({
      sessionId: `session-${index}`,
      agentId: `agent-${index}`,
      status: 'running',
      sequence: 1,
      updatedAt: 1_000,
      role: label,
      model: label,
      projectLabel: label,
      activity: label,
    }));
    const payload = {
      protocolVersion: 1,
      providerId: 'omp',
      hostId: 'local-host',
      sourceId: 'omp-process-large',
      sentAt: 1_000,
      leaseTtlMs: 5_000,
      agents,
    };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(65_536);

    const response = await postFleet(config.port, config.token, payload);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ created: 100 });
  });

  it('streams simultaneous OMP and Codex fleets and restores them on dashboard reconnect', async () => {
    const store = new AgentStateStore();
    const fleetRuntime = new FleetRuntime(store);
    const config = await server.start({ store, fleetRuntime, embedded: false });
    const now = Date.now();

    const ompResponse = await postFleet(config.port, config.token, {
      protocolVersion: 1,
      providerId: 'omp',
      hostId: 'local-host',
      sourceId: 'omp-process-1',
      sentAt: now,
      leaseTtlMs: 5_000,
      agents: [
        {
          sessionId: 'omp-session',
          agentId: 'Main',
          status: 'waiting',
          sequence: 1,
          updatedAt: now,
          role: 'main',
          projectLabel: 'pixel-agents',
          activity: 'Waiting for approval',
        },
        {
          sessionId: 'omp-session',
          agentId: 'reviewer-1',
          parent: { sessionId: 'omp-session', agentId: 'Main' },
          status: 'parked',
          sequence: 1,
          updatedAt: now,
          role: 'reviewer',
          projectLabel: 'pixel-agents',
          activity: 'Parked',
        },
      ],
    });
    const codexResponse = await postFleet(config.port, config.token, {
      protocolVersion: 1,
      providerId: 'codex',
      hostId: 'local-host',
      sourceId: 'codex-process-1',
      sentAt: now,
      leaseTtlMs: 5_000,
      agents: [
        {
          sessionId: 'codex-thread',
          agentId: 'Main',
          status: 'running',
          sequence: 1,
          updatedAt: now,
          role: 'main',
          projectLabel: 'pixel-agents',
          activity: 'Running',
        },
        {
          sessionId: 'codex-thread',
          agentId: 'reviewer-1',
          parent: { sessionId: 'codex-thread', agentId: 'Main' },
          status: 'completed',
          sequence: 1,
          updatedAt: now,
          role: 'reviewer',
          projectLabel: 'pixel-agents',
          activity: 'Completed',
        },
      ],
    });
    const secondOmpResponse = await postFleet(config.port, config.token, {
      protocolVersion: 1,
      providerId: 'omp',
      hostId: 'local-host',
      sourceId: 'omp-process-2',
      sentAt: now,
      leaseTtlMs: 5_000,
      agents: [
        {
          sessionId: 'omp-session-2',
          agentId: 'Main',
          status: 'idle',
          sequence: 1,
          updatedAt: now,
          role: 'main',
          projectLabel: 'agentic-workstation',
          activity: 'Idle',
        },
        {
          sessionId: 'omp-session-2',
          agentId: 'implementer-1',
          parent: { sessionId: 'omp-session-2', agentId: 'Main' },
          status: 'running',
          sequence: 1,
          updatedAt: now,
          role: 'implementer',
          projectLabel: 'agentic-workstation',
          activity: 'Editing code',
        },
      ],
    });
    const secondCodexResponse = await postFleet(config.port, config.token, {
      protocolVersion: 1,
      providerId: 'codex',
      hostId: 'local-host',
      sourceId: 'codex-process-2',
      sentAt: now,
      leaseTtlMs: 5_000,
      agents: [
        {
          sessionId: 'codex-thread-2',
          agentId: 'Main',
          status: 'waiting',
          sequence: 1,
          updatedAt: now,
          role: 'main',
          projectLabel: 'agentic-workstation',
          activity: 'Waiting for approval',
        },
        {
          sessionId: 'codex-thread-2',
          agentId: 'implementer-1',
          parent: { sessionId: 'codex-thread-2', agentId: 'Main' },
          status: 'parked',
          sequence: 1,
          updatedAt: now,
          role: 'implementer',
          projectLabel: 'agentic-workstation',
          activity: 'Parked',
        },
      ],
    });
    expect(ompResponse.status).toBe(200);
    expect(codexResponse.status).toBe(200);
    expect(secondOmpResponse.status).toBe(200);
    expect(secondCodexResponse.status).toBe(200);

    const firstSocket = await connectWebSocket(config.port);
    const startupTypes: string[] = [];
    firstSocket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as Record<string, unknown>;
      if (typeof message.type === 'string') startupTypes.push(message.type);
    });
    const firstSnapshot = waitForMessage(firstSocket, (message) => message.type === 'existingAgents');
    const layoutReady = waitForMessage(firstSocket, (message) => message.type === 'layoutLoaded');
    firstSocket.send(JSON.stringify({ type: 'webviewReady' }));
    const [first] = await Promise.all([firstSnapshot, layoutReady]);
    expect(startupTypes.indexOf('existingAgents')).toBeLessThan(startupTypes.indexOf('layoutLoaded'));
    const firstDetails = Object.values(first.agentDetails as Record<string, Record<string, unknown>>);
    expect(firstDetails).toHaveLength(8);
    expect(firstDetails).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          providerId: 'omp',
          agentId: 'Main',
          status: 'waiting',
          activity: 'Waiting for approval',
        }),
        expect.objectContaining({ providerId: 'omp', agentId: 'reviewer-1', status: 'parked' }),
        expect.objectContaining({ providerId: 'codex', agentId: 'Main', status: 'running' }),
        expect.objectContaining({
          providerId: 'codex',
          agentId: 'reviewer-1',
          status: 'completed',
        }),
      ]),
    );
    expect(new Set(firstDetails.map((detail) => detail.sessionId))).toEqual(
      new Set(['omp-session', 'omp-session-2', 'codex-thread', 'codex-thread-2']),
    );
    const ompMain = firstDetails.find(
      (detail) =>
        detail.providerId === 'omp' &&
        detail.sessionId === 'omp-session' &&
        detail.agentId === 'Main',
    );
    const ompChild = firstDetails.find(
      (detail) =>
        detail.providerId === 'omp' &&
        detail.sessionId === 'omp-session' &&
        detail.agentId === 'reviewer-1',
    );
    expect(ompChild?.parentAgentId).toBe(
      Number(
        Object.entries(first.agentDetails as Record<string, Record<string, unknown>>).find(
          ([, detail]) => detail === ompMain,
        )?.[0],
      ),
    );
    firstSocket.close();

    const secondSocket = await connectWebSocket(config.port);
    const restoredSnapshot = waitForMessage(
      secondSocket,
      (message) => message.type === 'existingAgents',
    );
    const restoredLayout = waitForMessage(
      secondSocket,
      (message) => message.type === 'layoutLoaded',
    );
    const restoredCompletedStatus = waitForMessage(
      secondSocket,
      (message) => message.type === 'agentStatus' && message.status === 'completed',
    );
    const restoredParkedStatus = waitForMessage(
      secondSocket,
      (message) => message.type === 'agentStatus' && message.status === 'parked',
    );
    secondSocket.send(JSON.stringify({ type: 'webviewReady' }));
    const [restored] = await Promise.all([
      restoredSnapshot,
      restoredLayout,
      restoredCompletedStatus,
      restoredParkedStatus,
    ]);
    expect(Object.keys(restored.agentDetails as object)).toHaveLength(8);

    const disconnectedStatus = waitForMessage(
      secondSocket,
      (message) => message.type === 'agentStatus' && message.status === 'disconnected',
    );
    const terminationResponse = await postFleet(config.port, config.token, {
      protocolVersion: 1,
      providerId: 'codex',
      hostId: 'local-host',
      sourceId: 'codex-process-1',
      sentAt: now + 1,
      leaseTtlMs: 5_000,
      agents: [
        {
          sessionId: 'codex-thread',
          agentId: 'Main',
          status: 'disconnected',
          sequence: 2,
          updatedAt: now + 1,
          role: 'main',
          projectLabel: 'pixel-agents',
          activity: 'Process disconnected',
        },
      ],
    });
    expect(terminationResponse.status).toBe(200);
    expect(await disconnectedStatus).toMatchObject({
      type: 'agentStatus',
      status: 'disconnected',
      activity: 'Process disconnected',
    });
    secondSocket.close();
  });
});
