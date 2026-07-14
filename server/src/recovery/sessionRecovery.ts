import type { FleetSnapshot } from '../../../core/src/fleet.js';
import { collectRecoveryContext } from './processInventory.js';
import type { RecoveryScanContext, RecoveryScanner } from './types.js';

const DEFAULT_SCAN_INTERVAL_MS = 1_000;

export interface SessionRecoveryOptions {
  hostId: string;
  scanners: readonly RecoveryScanner[];
  publish: (snapshot: FleetSnapshot) => Promise<void> | void;
  collectContext?: () => Promise<RecoveryScanContext>;
  intervalMs?: number;
}

export class SessionRecoveryMonitor {
  private readonly options: SessionRecoveryOptions;
  private timer: NodeJS.Timeout | null = null;
  private scanInFlight: Promise<void> | null = null;

  constructor(options: SessionRecoveryOptions) {
    this.options = options;
  }

  start(): void {
    if (this.timer) return;
    void this.scanNow();
    this.timer = setInterval(() => void this.scanNow(), this.options.intervalMs ?? DEFAULT_SCAN_INTERVAL_MS);
    this.timer.unref();
  }

  async scanNow(): Promise<void> {
    if (this.scanInFlight) return this.scanInFlight;
    this.scanInFlight = this.runScan().finally(() => {
      this.scanInFlight = null;
    });
    return this.scanInFlight;
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private async runScan(): Promise<void> {
    const context = this.options.collectContext
      ? await this.options.collectContext()
      : await collectRecoveryContext(this.options.hostId);
    const results = await Promise.allSettled(
      this.options.scanners.map((scanner) => scanner(context)),
    );
    for (const result of results) {
      if (result.status === 'fulfilled') await this.options.publish(result.value);
    }
  }
}
