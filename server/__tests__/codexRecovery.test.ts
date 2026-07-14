import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import { scanCodexRecovery } from '../src/recovery/codexRecovery.js';
import type { RecoveryScanContext } from '../src/recovery/types.js';

const NOW = 1_800_000_000_000;
const roots: string[] = [];

interface ThreadFixture {
  id: string;
  updatedAt?: number;
  archived?: boolean;
  cwd?: string;
  nickname?: string;
  role?: string;
  model?: string;
  prompt?: string;
}

function temporaryHome(): string {
  const homeDir = mkdtempSync(join(tmpdir(), 'pixel-agents-codex-recovery-'));
  roots.push(homeDir);
  return homeDir;
}

function createDatabase(homeDir: string): DatabaseSync {
  const codexDir = join(homeDir, '.codex');
  mkdirSync(codexDir, { recursive: true });
  const database = new DatabaseSync(join(codexDir, 'state_5.sqlite'));
  database.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      first_user_message TEXT,
      agent_nickname TEXT,
      agent_role TEXT,
      model TEXT,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT PRIMARY KEY NOT NULL,
      status TEXT NOT NULL
    );
  `);
  return database;
}

function insertThread(database: DatabaseSync, fixture: ThreadFixture): void {
  const updatedAt = fixture.updatedAt ?? NOW - 1_000;
  database
    .prepare(
      `INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
        sandbox_policy, approval_mode, archived, first_user_message, agent_nickname,
        agent_role, model, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      fixture.id,
      `/private/rollouts/${fixture.prompt ?? 'safe'}`,
      Math.floor((updatedAt - 1_000) / 1_000),
      Math.floor(updatedAt / 1_000),
      '{}',
      'openai',
      fixture.cwd ?? '/work/pixel-agents',
      'fixture title',
      '{}',
      'never',
      fixture.archived ? 1 : 0,
      fixture.prompt ?? null,
      fixture.nickname ?? null,
      fixture.role ?? null,
      fixture.model ?? null,
      updatedAt - 1_000,
      updatedAt,
    );
}

function insertEdge(
  database: DatabaseSync,
  parentThreadId: string,
  childThreadId: string,
  status = 'open',
): void {
  database
    .prepare(
      'INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status) VALUES (?, ?, ?)',
    )
    .run(parentThreadId, childThreadId, status);
}

function context(homeDir: string, hasCodexProcess = true): RecoveryScanContext {
  return {
    homeDir,
    hostId: 'fixture-host',
    now: NOW,
    processes: hasCodexProcess ? [{ pid: 42, command: '/usr/local/bin/codex --quiet' }] : [],
    activeTerminalKeys: new Set(),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('scanCodexRecovery', () => {
  it('returns an empty inferred snapshot unless a Codex process exists', async () => {
    const homeDir = temporaryHome();
    const database = createDatabase(homeDir);
    insertThread(database, { id: 'root-thread' });
    database.close();

    await expect(scanCodexRecovery(context(homeDir, false))).resolves.toEqual({
      protocolVersion: 1,
      providerId: 'codex',
      hostId: 'fixture-host',
      sourceId: 'recovery:codex',
      sentAt: NOW,
      leaseTtlMs: 4_000,
      inferred: true,
      agents: [],
    });
  });

  it('emits stable thread identities and immediate open-edge lineage without prompt content', async () => {
    const homeDir = temporaryHome();
    const database = createDatabase(homeDir);
    const promptSecret = 'PROMPT-SECRET-MUST-NOT-LEAK';
    insertThread(database, {
      id: 'root-thread',
      updatedAt: NOW - 40_000,
      cwd: '/work/pixel-agents',
      nickname: 'Main',
      role: 'lead',
      model: 'gpt-root',
      prompt: promptSecret,
    });
    insertThread(database, {
      id: 'child-thread',
      updatedAt: NOW - 5_000,
      nickname: 'reviewer',
      role: 'review',
      model: 'gpt-child',
      prompt: promptSecret,
    });
    insertThread(database, { id: 'grandchild-thread', updatedAt: NOW - 2_000 });
    insertEdge(database, 'root-thread', 'child-thread');
    insertEdge(database, 'child-thread', 'grandchild-thread');
    database.close();

    const first = await scanCodexRecovery(context(homeDir));
    const second = await scanCodexRecovery(context(homeDir));

    expect(second.agents).toEqual(first.agents);
    expect(first).toMatchObject({
      protocolVersion: 1,
      providerId: 'codex',
      hostId: 'fixture-host',
      sourceId: 'recovery:codex',
      leaseTtlMs: 4_000,
      inferred: true,
    });
    expect(first.agents).toEqual([
      expect.objectContaining({
        sessionId: 'root-thread',
        agentId: 'grandchild-thread',
        parent: { sessionId: 'root-thread', agentId: 'child-thread' },
        status: 'running',
        sequence: NOW - 2_000,
        updatedAt: NOW - 2_000,
      }),
      expect.objectContaining({
        sessionId: 'root-thread',
        agentId: 'child-thread',
        parent: { sessionId: 'root-thread', agentId: 'root-thread' },
        role: 'review',
        model: 'gpt-child',
        status: 'running',
      }),
      expect.objectContaining({
        sessionId: 'root-thread',
        agentId: 'root-thread',
        role: 'lead',
        model: 'gpt-root',
        projectLabel: 'pixel-agents',
        status: 'idle',
      }),
    ]);
    expect(JSON.stringify(first)).not.toContain(promptSecret);
  });

  it('filters archived and stale threads and ignores closed lineage edges', async () => {
    const homeDir = temporaryHome();
    const database = createDatabase(homeDir);
    insertThread(database, { id: 'recent', updatedAt: NOW - 30_000 });
    insertThread(database, { id: 'closed-child', updatedAt: NOW - 20_000 });
    insertThread(database, { id: 'archived', updatedAt: NOW - 1_000, archived: true });
    insertThread(database, { id: 'stale', updatedAt: NOW - 120_001 });
    insertEdge(database, 'recent', 'closed-child', 'closed');
    database.close();

    const snapshot = await scanCodexRecovery(context(homeDir));

    expect(snapshot.agents.map((agent) => agent.agentId)).toEqual(['closed-child', 'recent']);
    expect(snapshot.agents.every((agent) => agent.status === 'idle')).toBe(true);
    expect(snapshot.agents.find((agent) => agent.agentId === 'closed-child')?.parent).toBeUndefined();
  });

  it('bounds the recent candidate set', async () => {
    const homeDir = temporaryHome();
    const database = createDatabase(homeDir);
    for (let index = 0; index < 70; index++) {
      insertThread(database, { id: `thread-${String(index).padStart(2, '0')}`, updatedAt: NOW - index });
    }
    database.close();

    const snapshot = await scanCodexRecovery(context(homeDir));

    expect(snapshot.agents).toHaveLength(64);
    expect(snapshot.agents[0]?.agentId).toBe('thread-00');
    expect(snapshot.agents.at(-1)?.agentId).toBe('thread-63');
  });

  it('tolerates missing, locked, and malformed databases', async () => {
    const missingHome = temporaryHome();
    const lockedHome = temporaryHome();
    const malformedHome = temporaryHome();
    const lockedDatabase = createDatabase(lockedHome);
    insertThread(lockedDatabase, { id: 'locked-thread' });
    lockedDatabase.exec('BEGIN EXCLUSIVE');
    mkdirSync(join(malformedHome, '.codex'), { recursive: true });
    writeFileSync(join(malformedHome, '.codex', 'state_5.sqlite'), 'not a sqlite database');

    const [missing, locked, malformed] = await Promise.all([
      scanCodexRecovery(context(missingHome)),
      scanCodexRecovery(context(lockedHome)),
      scanCodexRecovery(context(malformedHome)),
    ]);
    lockedDatabase.exec('ROLLBACK');
    lockedDatabase.close();

    expect(missing.agents).toEqual([]);
    expect(locked.agents).toEqual([]);
    expect(malformed.agents).toEqual([]);
    expect(malformed.inferred).toBe(true);
  });
});
