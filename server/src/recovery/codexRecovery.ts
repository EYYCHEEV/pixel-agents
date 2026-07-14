import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { FleetAgentIdentity, FleetAgentProjection, FleetSnapshot } from '../../../core/src/fleet.js';
import type { RecoveryScanContext, RecoveryScanner } from './types.js';

const SOURCE_ID = 'recovery:codex';
const LEASE_TTL_MS = 4_000;
const RECENT_WINDOW_MS = 2 * 60_000;
const RUNNING_WINDOW_MS = 15_000;
const MAX_CANDIDATES = 64;

interface ThreadRow {
  id: string;
  cwd: string | null;
  agent_nickname: string | null;
  agent_role: string | null;
  model: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}

interface EdgeRow {
  parent_thread_id: string;
  child_thread_id: string;
  status: string;
}

function emptySnapshot(context: RecoveryScanContext): FleetSnapshot {
  return {
    protocolVersion: 1,
    providerId: 'codex',
    hostId: context.hostId,
    sourceId: SOURCE_ID,
    sentAt: context.now,
    leaseTtlMs: LEASE_TTL_MS,
    inferred: true,
    agents: [],
  };
}

function isCodexProcess(command: string): boolean {
  return /(?:^|[\\/\s])codex(?:\.js|\.exe)?(?:\s|$)/i.test(command);
}

function safeText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function safeTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

function readThreads(database: DatabaseSync, cutoff: number): ThreadRow[] {
  const rows = database
    .prepare(
      `SELECT id, cwd, agent_nickname, agent_role, model, created_at_ms, updated_at_ms
       FROM threads
       WHERE archived = 0 AND updated_at_ms >= ?
       ORDER BY updated_at_ms DESC, id ASC
       LIMIT ?`,
    )
    .all(cutoff, MAX_CANDIDATES);

  const threads: ThreadRow[] = [];
  for (const row of rows) {
    const id = safeText(row.id);
    const createdAt = safeTimestamp(row.created_at_ms);
    const updatedAt = safeTimestamp(row.updated_at_ms);
    if (!id || createdAt === undefined || updatedAt === undefined) continue;
    threads.push({
      id,
      cwd: safeText(row.cwd) ?? null,
      agent_nickname: safeText(row.agent_nickname) ?? null,
      agent_role: safeText(row.agent_role) ?? null,
      model: safeText(row.model) ?? null,
      created_at_ms: createdAt,
      updated_at_ms: updatedAt,
    });
  }
  return threads;
}

function readOpenEdges(database: DatabaseSync, threadIds: readonly string[]): EdgeRow[] {
  if (threadIds.length === 0) return [];
  const placeholders = threadIds.map(() => '?').join(', ');
  const rows = database
    .prepare(
      `SELECT parent_thread_id, child_thread_id, status
       FROM thread_spawn_edges
       WHERE status = 'open' AND child_thread_id IN (${placeholders})`,
    )
    .all(...threadIds);

  const edges: EdgeRow[] = [];
  for (const row of rows) {
    const parentId = safeText(row.parent_thread_id);
    const childId = safeText(row.child_thread_id);
    const status = safeText(row.status);
    if (parentId && childId && status) {
      edges.push({ parent_thread_id: parentId, child_thread_id: childId, status });
    }
  }
  return edges;
}

function rootThreadId(
  threadId: string,
  parentByChild: ReadonlyMap<string, string>,
  includedIds: ReadonlySet<string>,
): string {
  let current = threadId;
  const visited = new Set([threadId]);
  while (true) {
    const parent = parentByChild.get(current);
    if (!parent || !includedIds.has(parent) || visited.has(parent)) return current;
    visited.add(parent);
    current = parent;
  }
}

function projectThreads(
  context: RecoveryScanContext,
  threads: readonly ThreadRow[],
  edges: readonly EdgeRow[],
): FleetAgentProjection[] {
  const includedIds = new Set(threads.map((thread) => thread.id));
  const parentByChild = new Map<string, string>();
  for (const edge of edges) {
    if (includedIds.has(edge.child_thread_id) && includedIds.has(edge.parent_thread_id)) {
      parentByChild.set(edge.child_thread_id, edge.parent_thread_id);
    }
  }

  const identityByThread = new Map<string, FleetAgentIdentity>();
  for (const thread of threads) {
    identityByThread.set(thread.id, {
      sessionId: rootThreadId(thread.id, parentByChild, includedIds),
      agentId: thread.id,
    });
  }

  return threads.map((thread) => {
    const identity = identityByThread.get(thread.id)!;
    const parentId = parentByChild.get(thread.id);
    const parent = parentId ? identityByThread.get(parentId) : undefined;
    const projectLabel = thread.cwd ? basename(thread.cwd) || undefined : undefined;
    const role = thread.agent_role ?? thread.agent_nickname ?? undefined;
    return {
      ...identity,
      ...(parent ? { parent } : {}),
      ...(role ? { role } : {}),
      ...(thread.model ? { model: thread.model } : {}),
      ...(projectLabel ? { projectLabel } : {}),
      status: context.now - thread.updated_at_ms <= RUNNING_WINDOW_MS ? 'running' : 'idle',
      sequence: thread.updated_at_ms,
      updatedAt: thread.updated_at_ms,
    };
  });
}

export const scanCodexRecovery: RecoveryScanner = async (context) => {
  const snapshot = emptySnapshot(context);
  if (!context.processes.some((process) => isCodexProcess(process.command))) return snapshot;

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(join(context.homeDir, '.codex', 'state_5.sqlite'), {
      readOnly: true,
    });
    const threads = readThreads(database, context.now - RECENT_WINDOW_MS);
    const edges = readOpenEdges(
      database,
      threads.map((thread) => thread.id),
    );
    snapshot.agents = projectThreads(context, threads, edges);
  } catch {
    // Recovery is best-effort: a missing, busy, or incompatible Codex database is not fatal.
  } finally {
    database?.close();
  }
  return snapshot;
};
