import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scanOmpRecovery } from '../src/recovery/ompRecovery.js';
import type { RecoveryScanContext } from '../src/recovery/types.js';

const NOW = 2_000_000;
let homeDir: string;

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), 'pixel-agents-omp-recovery-'));
});

afterEach(async () => {
  await rm(homeDir, { recursive: true, force: true });
});

function context(activeTerminalKeys: string[]): RecoveryScanContext {
  return {
    homeDir,
    hostId: 'fixture-host',
    now: NOW,
    processes: [],
    activeTerminalKeys: new Set(activeTerminalKeys),
  };
}

async function createSession(
  terminalKey: string,
  sessionId: string,
  cwd = join(homeDir, 'work', 'pixel-agents'),
): Promise<{ sessionFile: string; artifactRoot: string }> {
  const projectDir = join(homeDir, '.omp', 'agent', 'sessions', '-fixture-project');
  const registryDir = join(homeDir, '.omp', 'agent', 'terminal-sessions');
  const sessionFile = join(projectDir, `2026-07-14T00-00-00-000Z_${sessionId}.jsonl`);
  await mkdir(projectDir, { recursive: true });
  await mkdir(registryDir, { recursive: true });
  await writeFile(sessionFile, '{"type":"message","message":{"role":"user"}}\n');
  await writeFile(join(registryDir, terminalKey), `${cwd}\n${sessionFile}\n`);
  return { sessionFile, artifactRoot: sessionFile.slice(0, -'.jsonl'.length) };
}

async function createArtifact(
  artifactRoot: string,
  relativePath: string,
  contents: string,
  mtimeMs: number,
): Promise<void> {
  const path = join(artifactRoot, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents);
  await utimes(path, mtimeMs / 1000, mtimeMs / 1000);
}

describe('scanOmpRecovery', () => {
  it('gates registries by active terminal and emits stable inferred Main metadata', async () => {
    const active = await createSession('tmux-%1', 'session-active');
    await createSession('ttys999', 'session-stale', join(homeDir, 'work', 'ignored'));

    const first = await scanOmpRecovery(context(['tmux-%1']));
    const second = await scanOmpRecovery(context(['tmux-%1']));

    expect(first).toMatchObject({
      protocolVersion: 1,
      providerId: 'omp',
      hostId: 'fixture-host',
      sourceId: 'recovery:omp',
      sentAt: NOW,
      leaseTtlMs: 4_000,
      inferred: true,
    });
    expect(first.agents).toHaveLength(1);
    expect(first.agents[0]).toMatchObject({
      sessionId: 'session-active',
      agentId: 'Main',
      role: 'main',
      projectLabel: 'pixel-agents',
      status: 'running',
    });
    expect(second.agents[0]).toEqual(first.agents[0]);
    expect(active.sessionFile).toContain('session-active');
  });

  it('marks an inactive recovered Main idle', async () => {
    const { sessionFile } = await createSession('tmux-%2', 'session-idle');
    await writeFile(
      sessionFile,
      '{"type":"message","message":{"role":"assistant","stopReason":"stop","content":[]}}\n',
    );
    const registryFile = join(homeDir, '.omp', 'agent', 'terminal-sessions', 'tmux-%2');
    const idleTimestamp = NOW - 60_000;
    await utimes(sessionFile, idleTimestamp / 1000, idleTimestamp / 1000);
    await utimes(registryFile, idleTimestamp / 1000, idleTimestamp / 1000);

    const snapshot = await scanOmpRecovery(context(['tmux-%2']));

    expect(snapshot.agents).toHaveLength(1);
    expect(snapshot.agents[0]).toMatchObject({
      agentId: 'Main',
      status: 'idle',
    });
  });

  it('infers nested immediate-parent lineage and conservative age statuses', async () => {
    const { artifactRoot } = await createSession('ttys001', 'lineage-session');
    await createArtifact(
      artifactRoot,
      'Planner.jsonl',
      '{"type":"message","message":{"role":"user","content":"private prompt"}}\n',
      NOW - 1_000,
    );
    await createArtifact(
      artifactRoot,
      join('Planner', 'Reviewer.jsonl'),
      '{"type":"message","message":{"role":"user","content":"secret response"}}\n',
      NOW - 60_000,
    );
    await createArtifact(
      artifactRoot,
      join('Planner', 'Reviewer', 'Verifier.jsonl'),
      '{"type":"message","message":{"role":"user","content":"hidden tool output"}}\n',
      NOW - 5 * 60_000,
    );

    const snapshot = await scanOmpRecovery(context(['ttys001']));
    const planner = snapshot.agents.find((agent) => agent.agentId === 'Planner');
    const reviewer = snapshot.agents.find((agent) => agent.agentId === 'Reviewer');
    const verifier = snapshot.agents.find((agent) => agent.agentId === 'Verifier');

    expect(planner).toMatchObject({
      parent: { sessionId: 'lineage-session', agentId: 'Main' },
      status: 'running',
    });
    expect(reviewer).toMatchObject({
      parent: { sessionId: 'lineage-session', agentId: 'Planner' },
      status: 'idle',
    });
    expect(verifier).toMatchObject({
      parent: { sessionId: 'lineage-session', agentId: 'Reviewer' },
      status: 'parked',
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/private prompt|secret response|hidden tool output/);
  });

  it('omits completed child artifacts while retaining in-progress siblings', async () => {
    const { artifactRoot } = await createSession('ttys002', 'terminal-session');
    await createArtifact(
      artifactRoot,
      'Completed.jsonl',
      [
        '{"type":"message","message":{"role":"user"}}',
        '{"type":"message","message":{"role":"assistant","stopReason":"stop","content":"sensitive"}}',
        '',
      ].join('\n'),
      NOW,
    );
    await createArtifact(
      artifactRoot,
      'Interrupted.jsonl',
      '{"type":"message","message":{"role":"toolResult","content":"sensitive result"}}\n',
      NOW,
    );
    await createArtifact(
      artifactRoot,
      'ToolCalling.jsonl',
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', name: 'read', input: 'sensitive input' }],
        },
      }),
      NOW,
    );
    await createArtifact(
      artifactRoot,
      'Live.jsonl',
      '{"type":"message","message":{"role":"user","content":"still working"}}\n',
      NOW,
    );

    const snapshot = await scanOmpRecovery(context(['ttys002']));
    expect(snapshot.agents.map((agent) => agent.agentId)).toEqual([
      'Main',
      'Interrupted',
      'Live',
      'ToolCalling',
    ]);
    expect(JSON.stringify(snapshot)).not.toContain('sensitive');
    expect(JSON.stringify(snapshot)).not.toContain('still working');
  });

  it('skips malformed, oversized, missing, and out-of-tree registries without failing', async () => {
    const registryDir = join(homeDir, '.omp', 'agent', 'terminal-sessions');
    await mkdir(registryDir, { recursive: true });
    await writeFile(join(registryDir, 'malformed'), 'one-line-only');
    await writeFile(join(registryDir, 'oversized'), 'x'.repeat(4 * 1024 + 1));
    await writeFile(join(registryDir, 'missing'), `/project\n${join(homeDir, 'missing.jsonl')}\n`);
    const outside = join(homeDir, 'outside_session.jsonl');
    await writeFile(outside, '{}\n');
    await writeFile(join(registryDir, 'outside'), `/project\n${outside}\n`);

    await expect(
      scanOmpRecovery(context(['malformed', 'oversized', 'missing', 'outside'])),
    ).resolves.toMatchObject({ agents: [] });
  });

  it('ignores non-JSON artifacts when bounding and retains old in-flight tools', async () => {
    const { artifactRoot } = await createSession('ttys004', 'busy-session');
    await mkdir(artifactRoot, { recursive: true });
    for (let index = 0; index < 129; index += 1) {
      await writeFile(
        join(artifactRoot, `${String(index).padStart(3, '0')}.bash.log`),
        'tool output',
      );
    }
    await createArtifact(
      artifactRoot,
      'WaitingOnTool.jsonl',
      JSON.stringify({
        type: 'message',
        message: {
          role: 'assistant',
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', name: 'bash' }],
        },
      }),
      NOW - 10 * 60_000,
    );

    const snapshot = await scanOmpRecovery(context(['ttys004']));

    expect(snapshot.agents.find((agent) => agent.agentId === 'WaitingOnTool')).toMatchObject({
      status: 'running',
    });
  });

  it('bounds child selection to the newest 64 artifacts', async () => {
    const { artifactRoot } = await createSession('ttys003', 'bounded-session');
    for (let index = 0; index < 70; index += 1) {
      await createArtifact(
        artifactRoot,
        `Child-${String(index).padStart(2, '0')}.jsonl`,
        '{"type":"message","message":{"role":"user"}}\n',
        NOW - (70 - index) * 1_000,
      );
    }

    const snapshot = await scanOmpRecovery(context(['ttys003']));
    const children = snapshot.agents.filter((agent) => agent.agentId !== 'Main');
    expect(children).toHaveLength(64);
    expect(children.map((agent) => agent.agentId)).toContain('Child-69');
    expect(children.map((agent) => agent.agentId)).not.toContain('Child-00');
    expect(new Set(children.map((agent) => agent.sequence)).size).toBe(64);
    expect(children.every((agent) => basename(agent.agentId) === agent.agentId)).toBe(true);
  });
});
