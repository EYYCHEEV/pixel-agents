export type FleetAgentStatus =
  | 'running'
  | 'waiting'
  | 'idle'
  | 'parked'
  | 'completed'
  | 'disconnected';

export interface FleetAgentIdentity {
  sessionId: string;
  agentId: string;
}

export interface FleetAgentProjection extends FleetAgentIdentity {
  parent?: FleetAgentIdentity;
  role?: string;
  model?: string;
  projectLabel?: string;
  activity?: string;
  status: FleetAgentStatus;
  sequence: number;
  updatedAt: number;
}

/**
 * Complete state owned by one producer process. Producers send this immediately
 * after lifecycle changes and repeat it as a heartbeat. Missing agents from the
 * same source are treated as disconnected.
 */
export interface FleetSnapshot {
  protocolVersion: 1;
  providerId: string;
  hostId: string;
  sourceId: string;
  sentAt: number;
  leaseTtlMs: number;
  /** True when state was recovered externally rather than observed by the owning process. */
  inferred?: boolean;
  agents: FleetAgentProjection[];
}
