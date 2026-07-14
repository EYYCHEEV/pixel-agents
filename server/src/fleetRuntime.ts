import type {
  FleetAgentIdentity,
  FleetAgentProjection,
  FleetAgentStatus,
  FleetSnapshot,
} from '../../core/src/fleet.js';
import type { FleetAgentMeta } from '../../core/src/messages.js';
import type { AgentStateStore } from './agentStateStore.js';
import {
  FLEET_MAX_AGENTS_PER_SNAPSHOT,
  FLEET_MAX_LABEL_LENGTH,
  FLEET_MAX_LEASE_TTL_MS,
  FLEET_MIN_LEASE_TTL_MS,
  FLEET_SWEEP_INTERVAL_MS,
} from './constants.js';
import type { AgentState } from './types.js';

const FLEET_STATUSES = new Set<FleetAgentStatus>([
  'running',
  'waiting',
  'idle',
  'parked',
  'completed',
  'disconnected',
]);

const SNAPSHOT_FIELDS = new Set([
  'protocolVersion',
  'providerId',
  'hostId',
  'sourceId',
  'sentAt',
  'leaseTtlMs',
  'inferred',
  'agents',
]);
const PROJECTION_FIELDS = new Set([
  'sessionId',
  'agentId',
  'parent',
  'role',
  'model',
  'projectLabel',
  'activity',
  'status',
  'sequence',
  'updatedAt',
]);
const IDENTITY_FIELDS = new Set(['sessionId', 'agentId']);

interface FleetLease {
  sourceId: string;
  sentAt: number;
  expiresAt: number;
  agentKeys: Set<string>;
}

export interface FleetApplyResult {
  created: number;
  updated: number;
  ignored: number;
  disconnected: number;
}

interface FleetParseFailure {
  ok: false;
  error: string;
}

export type FleetSnapshotParseResult =
  | { ok: true; value: FleetSnapshot }
  | FleetParseFailure;

type FleetProjectionParseResult =
  | { ok: true; value: FleetAgentProjection }
  | FleetParseFailure;

export class FleetRuntime {
  private readonly agentIdsByKey = new Map<string, number>();
  private readonly leases = new Map<string, FleetLease>();
  private readonly lastSentAtBySource = new Map<string, number>();
  private readonly latestSnapshotsBySource = new Map<string, FleetSnapshot>();
  private readonly snapshotListeners = new Set<(snapshot: FleetSnapshot) => void>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly store: AgentStateStore) {
    for (const [id, agent] of store) {
      if (agent.fleetKey) this.agentIdsByKey.set(agent.fleetKey, id);
    }
    for (const persisted of store.loadPersistedAgents()) {
      if (persisted.id >= store.nextAgentId.current) {
        store.nextAgentId.current = persisted.id + 1;
      }
    }
  }

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepExpired(Date.now()), FLEET_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  subscribeSnapshots(listener: (snapshot: FleetSnapshot) => void): () => void {
    this.snapshotListeners.add(listener);
    const now = Date.now();
    for (const [leaseKey, snapshot] of this.latestSnapshotsBySource) {
      const lease = this.leases.get(leaseKey);
      if (!lease || lease.expiresAt <= now) continue;
      listener({
        ...snapshot,
        leaseTtlMs: Math.max(
          FLEET_MIN_LEASE_TTL_MS,
          Math.min(snapshot.leaseTtlMs, lease.expiresAt - now),
        ),
      });
    }
    return () => this.snapshotListeners.delete(listener);
  }

  applySnapshot(snapshot: FleetSnapshot, receivedAt = Date.now()): FleetApplyResult {
    const leaseKey = JSON.stringify([snapshot.providerId, snapshot.hostId, snapshot.sourceId]);
    const previousLease = this.leases.get(leaseKey);
    const lastSentAt = this.lastSentAtBySource.get(leaseKey);
    const nextKeys = new Set<string>();
    const pending: Array<{
      projection: FleetAgentProjection;
      key: string;
      agent: AgentState;
      isNew: boolean;
    }> = [];
    const result: FleetApplyResult = { created: 0, updated: 0, ignored: 0, disconnected: 0 };
    if (lastSentAt !== undefined && snapshot.sentAt < lastSentAt) {
      result.ignored = snapshot.agents.length;
      return result;
    }

    for (const projection of snapshot.agents) {
      const key = fleetAgentKey(snapshot.providerId, snapshot.hostId, projection);
      nextKeys.add(key);

      const existingId = this.agentIdsByKey.get(key);
      const existing = existingId === undefined ? undefined : this.store.get(existingId);
      if (existing && shouldIgnoreProjection(existing, snapshot, projection)) {
        result.ignored++;
        continue;
      }

      const agent = existing ?? createFleetAgent(allocateAgentId(this.store), snapshot, projection);
      if (!existing) this.agentIdsByKey.set(key, agent.id);
      pending.push({ projection, key, agent, isNew: !existing });
    }

    for (const item of pending) {
      const parentKey = item.projection.parent
        ? fleetAgentKey(snapshot.providerId, snapshot.hostId, item.projection.parent)
        : undefined;
      const parentId = parentKey ? this.agentIdsByKey.get(parentKey) : undefined;
      const previousStatus = item.agent.fleetStatus;
      const previousActivity = item.agent.fleetActivity;
      const previousFleet = fleetMetaFromAgent(item.agent);

      updateFleetAgent(item.agent, snapshot, item.projection, item.key, parentKey, parentId, receivedAt);

      if (item.isNew) {
        this.store.set(item.agent.id, item.agent);
        result.created++;
      } else {
        result.updated++;
        if (previousStatus !== item.agent.fleetStatus || previousActivity !== item.agent.fleetActivity) {
          this.broadcastStatus(item.agent);
        }
        const fleet = fleetMetaFromAgent(item.agent);
        if (fleet && previousFleet && fleetMetadataChanged(previousFleet, fleet)) {
          this.store.broadcast({ type: 'agentFleetUpdated', id: item.agent.id, fleet });
        }
      }
    }

    this.reconcileParents();

    if (previousLease) {
      for (const missingKey of previousLease.agentKeys) {
        if (
          !nextKeys.has(missingKey) &&
          this.markDisconnected(missingKey, previousLease.sourceId)
        ) {
          result.disconnected++;
        }
      }
    }

    this.lastSentAtBySource.set(leaseKey, snapshot.sentAt);
    this.leases.set(leaseKey, {
      sourceId: snapshot.sourceId,
      sentAt: snapshot.sentAt,
      expiresAt: receivedAt + snapshot.leaseTtlMs,
      agentKeys: nextKeys,
    });
    this.latestSnapshotsBySource.set(leaseKey, snapshot);
    for (const listener of this.snapshotListeners) {
      listener(snapshot);
    }

    return result;
  }

  sweepExpired(now = Date.now()): number {
    let disconnected = 0;
    for (const [leaseKey, lease] of this.leases) {
      if (lease.expiresAt > now) continue;
      for (const agentKey of lease.agentKeys) {
        if (this.markDisconnected(agentKey, lease.sourceId)) disconnected++;
      }
      this.leases.delete(leaseKey);
      this.latestSnapshotsBySource.delete(leaseKey);
    }
    return disconnected;
  }

  dispose(): void {
    clearInterval(this.sweepTimer ?? undefined);
    this.sweepTimer = null;
    this.leases.clear();
    this.lastSentAtBySource.clear();
    this.latestSnapshotsBySource.clear();
    this.snapshotListeners.clear();
  }

  private markDisconnected(agentKey: string, sourceId: string): boolean {
    const id = this.agentIdsByKey.get(agentKey);
    if (id === undefined) return false;
    const agent = this.store.get(id);
    if (
      !agent ||
      agent.sourceId !== sourceId ||
      agent.fleetStatus === 'completed' ||
      agent.fleetStatus === 'disconnected'
    ) {
      return false;
    }
    agent.fleetStatus = 'disconnected';
    agent.fleetActivity = 'Source disconnected';
    this.broadcastStatus(agent);
    return true;
  }

  private broadcastStatus(agent: AgentState): void {
    this.store.broadcast({
      type: 'agentStatus',
      id: agent.id,
      status: agent.fleetStatus,
      activity: agent.fleetActivity,
    });
  }
  private reconcileParents(): void {
    for (const agent of this.store.values()) {
      if (!agent.fleetKey) continue;
      const parentId = agent.fleetParentKey
        ? this.agentIdsByKey.get(agent.fleetParentKey)
        : undefined;
      if (agent.leadAgentId === parentId) continue;
      agent.leadAgentId = parentId;
      const fleet = fleetMetaFromAgent(agent);
      if (fleet) this.store.broadcast({ type: 'agentFleetUpdated', id: agent.id, fleet });
    }
  }

}

export function parseFleetSnapshot(input: unknown): FleetSnapshotParseResult {
  if (!isRecord(input)) return invalid('body must be an object');
  const snapshotUnknown = findUnknownField(input, SNAPSHOT_FIELDS);
  if (snapshotUnknown) return invalid(`unknown field: ${snapshotUnknown}`);
  if (input.protocolVersion !== 1) return invalid('protocolVersion must be 1');

  const providerId = parseIdentifier(input.providerId, 'providerId');
  if (typeof providerId !== 'string') return providerId;
  const hostId = parseLabel(input.hostId, 'hostId');
  if (typeof hostId !== 'string') return hostId;
  const sourceId = parseLabel(input.sourceId, 'sourceId');
  if (typeof sourceId !== 'string') return sourceId;
  if (input.inferred !== undefined && typeof input.inferred !== 'boolean') {
    return invalid('inferred must be a boolean');
  }
  if (!isFiniteTimestamp(input.sentAt)) return invalid('sentAt must be a finite timestamp');
  if (
    !Number.isInteger(input.leaseTtlMs) ||
    (input.leaseTtlMs as number) < FLEET_MIN_LEASE_TTL_MS ||
    (input.leaseTtlMs as number) > FLEET_MAX_LEASE_TTL_MS
  ) {
    return invalid(
      `leaseTtlMs must be an integer from ${FLEET_MIN_LEASE_TTL_MS} to ${FLEET_MAX_LEASE_TTL_MS}`,
    );
  }
  if (!Array.isArray(input.agents) || input.agents.length > FLEET_MAX_AGENTS_PER_SNAPSHOT) {
    return invalid(`agents must be an array with at most ${FLEET_MAX_AGENTS_PER_SNAPSHOT} entries`);
  }

  const agents: FleetAgentProjection[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < input.agents.length; index++) {
    const parsed = parseProjection(input.agents[index], index);
    if (!parsed.ok) return parsed;
    const localKey = JSON.stringify([parsed.value.sessionId, parsed.value.agentId]);
    if (seen.has(localKey)) return invalid(`agents[${index}] duplicates an agent identity`);
    seen.add(localKey);
    agents.push(parsed.value);
  }

  return {
    ok: true,
    value: {
      protocolVersion: 1,
      providerId,
      hostId,
      sourceId,
      sentAt: input.sentAt as number,
      leaseTtlMs: input.leaseTtlMs as number,
      inferred: input.inferred === true ? true : undefined,
      agents,
    },
  };
}

export function fleetMetaFromAgent(agent: AgentState): FleetAgentMeta | undefined {
  if (
    !agent.providerId ||
    !agent.hostId ||
    !agent.fleetAgentId ||
    !agent.fleetStatus ||
    !agent.fleetKey
  ) {
    return undefined;
  }
  return {
    providerId: agent.providerId,
    hostId: agent.hostId,
    sessionId: agent.sessionId,
    agentId: agent.fleetAgentId,
    parentAgentId: agent.leadAgentId,
    isChild: agent.fleetParentKey ? true : undefined,
    role: agent.fleetRole,
    model: agent.fleetModel,
    projectLabel: agent.folderName,
    activity: agent.fleetActivity,
    inferred: agent.fleetInferred || undefined,
    status: agent.fleetStatus,
  };
}

export function fleetAgentKey(
  providerId: string,
  hostId: string,
  identity: FleetAgentIdentity,
): string {
  return JSON.stringify([providerId, hostId, identity.sessionId, identity.agentId]);
}


function fleetMetadataChanged(previous: FleetAgentMeta, next: FleetAgentMeta): boolean {
  return (
    previous.providerId !== next.providerId ||
    previous.hostId !== next.hostId ||
    previous.sessionId !== next.sessionId ||
    previous.agentId !== next.agentId ||
    previous.parentAgentId !== next.parentAgentId ||
    previous.isChild !== next.isChild ||
    previous.role !== next.role ||
    previous.model !== next.model ||
    previous.projectLabel !== next.projectLabel ||
    previous.inferred !== next.inferred
  );
}

function shouldIgnoreProjection(
  agent: AgentState,
  snapshot: FleetSnapshot,
  projection: FleetAgentProjection,
): boolean {
  if (snapshot.inferred && agent.fleetInferred === false && agent.fleetStatus !== 'disconnected') {
    return true;
  }
  if (!snapshot.inferred && agent.fleetInferred) return false;
  if (agent.sourceId === snapshot.sourceId) {
    if (
      agent.fleetStatus === 'disconnected' &&
      projection.status !== 'disconnected' &&
      projection.sequence === (agent.fleetSequence ?? -1)
    ) {
      return false;
    }
    return projection.sequence <= (agent.fleetSequence ?? -1);
  }
  return projection.updatedAt < (agent.fleetUpdatedAt ?? -1);
}

function allocateAgentId(store: AgentStateStore): number {
  let id = store.nextAgentId.current;
  while (store.has(id)) id++;
  store.nextAgentId.current = id + 1;
  return id;
}

function createFleetAgent(
  id: number,
  snapshot: FleetSnapshot,
  projection: FleetAgentProjection,
): AgentState {
  return {
    id,
    sessionId: projection.sessionId,
    terminalRef: undefined,
    isExternal: true,
    projectDir: '',
    jsonlFile: '',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: projection.status === 'waiting',
    permissionSent: false,
    hadToolsInTurn: false,
    folderName: projection.projectLabel,
    lastDataAt: snapshot.sentAt,
    linesProcessed: 0,
    seenUnknownRecordTypes: new Set(),
    hookDelivered: true,
    hooksOnly: true,
    inputTokens: 0,
    outputTokens: 0,
  };
}

function updateFleetAgent(
  agent: AgentState,
  snapshot: FleetSnapshot,
  projection: FleetAgentProjection,
  key: string,
  parentKey: string | undefined,
  parentId: number | undefined,
  receivedAt: number,
): void {
  agent.sessionId = projection.sessionId;
  agent.providerId = snapshot.providerId;
  agent.fleetKey = key;
  agent.hostId = snapshot.hostId;
  agent.sourceId = snapshot.sourceId;
  agent.fleetAgentId = projection.agentId;
  agent.fleetParentKey = parentKey;
  agent.leadAgentId = parentId;
  agent.fleetStatus = projection.status;
  agent.fleetRole = projection.role;
  agent.fleetModel = projection.model;
  agent.fleetActivity = projection.activity;
  agent.fleetSequence = projection.sequence;
  agent.fleetUpdatedAt = projection.updatedAt;
  agent.fleetInferred = snapshot.inferred === true;
  agent.folderName = projection.projectLabel;
  agent.isWaiting = projection.status === 'waiting';
  agent.lastDataAt = receivedAt;
}

function parseProjection(input: unknown, index: number): FleetProjectionParseResult {
  if (!isRecord(input)) return invalid(`agents[${index}] must be an object`);
  const projectionUnknown = findUnknownField(input, PROJECTION_FIELDS);
  if (projectionUnknown) return invalid(`agents[${index}] contains unknown field: ${projectionUnknown}`);
  const sessionId = parseLabel(input.sessionId, `agents[${index}].sessionId`);
  if (typeof sessionId !== 'string') return sessionId;
  const agentId = parseLabel(input.agentId, `agents[${index}].agentId`);
  if (typeof agentId !== 'string') return agentId;
  if (!FLEET_STATUSES.has(input.status as FleetAgentStatus)) {
    return invalid(`agents[${index}].status is invalid`);
  }
  if (!Number.isInteger(input.sequence) || (input.sequence as number) < 0) {
    return invalid(`agents[${index}].sequence must be a non-negative integer`);
  }
  if (!isFiniteTimestamp(input.updatedAt)) {
    return invalid(`agents[${index}].updatedAt must be a finite timestamp`);
  }

  let parent: FleetAgentIdentity | undefined;
  if (input.parent !== undefined) {
    if (!isRecord(input.parent)) return invalid(`agents[${index}].parent must be an object`);
    const parentUnknown = findUnknownField(input.parent, IDENTITY_FIELDS);
    if (parentUnknown) {
      return invalid(`agents[${index}].parent contains unknown field: ${parentUnknown}`);
    }
    const parentSessionId = parseLabel(input.parent.sessionId, `agents[${index}].parent.sessionId`);
    if (typeof parentSessionId !== 'string') return parentSessionId;
    const parentAgentId = parseLabel(input.parent.agentId, `agents[${index}].parent.agentId`);
    if (typeof parentAgentId !== 'string') return parentAgentId;
    parent = { sessionId: parentSessionId, agentId: parentAgentId };
  }

  const optional: Record<string, string | undefined> = {};
  for (const field of ['role', 'model', 'projectLabel', 'activity'] as const) {
    const value = input[field];
    if (value === undefined) continue;
    const parsed = parseLabel(value, `agents[${index}].${field}`);
    if (typeof parsed !== 'string') return parsed;
    optional[field] = parsed;
  }

  return {
    ok: true,
    value: {
      sessionId,
      agentId,
      parent,
      status: input.status as FleetAgentStatus,
      sequence: input.sequence as number,
      updatedAt: input.updatedAt as number,
      ...optional,
    },
  };
}

function parseIdentifier(value: unknown, field: string): string | FleetParseFailure {
  const parsed = parseLabel(value, field);
  if (typeof parsed !== 'string') return parsed;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(parsed)) {
    return invalid(`${field} must contain lowercase letters, digits, or hyphens`);
  }
  return parsed;
}

function parseLabel(value: unknown, field: string): string | FleetParseFailure {
  if (typeof value !== 'string' || value.length === 0 || value.length > FLEET_MAX_LABEL_LENGTH) {
    return invalid(`${field} must be a non-empty string up to ${FLEET_MAX_LABEL_LENGTH} characters`);
  }
  return value;
}

function findUnknownField(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): string | undefined {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return key;
  }
  return undefined;
}

function isFiniteTimestamp(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(error: string): FleetParseFailure {
  return { ok: false, error };
}
