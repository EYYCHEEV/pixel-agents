import type { FleetSnapshot } from '../../../core/src/fleet.js';

export interface RecoveryProcess {
  pid: number;
  tty?: string;
  command: string;
}

export interface RecoveryScanContext {
  homeDir: string;
  hostId: string;
  now: number;
  processes: readonly RecoveryProcess[];
  activeTerminalKeys: ReadonlySet<string>;
}

export type RecoveryScanner = (context: RecoveryScanContext) => Promise<FleetSnapshot>;
