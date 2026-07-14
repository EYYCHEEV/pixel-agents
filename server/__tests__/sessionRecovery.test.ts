import { describe, expect, it, vi } from 'vitest';

import type { FleetSnapshot } from '../../core/src/fleet.js';
import { SessionRecoveryMonitor } from '../src/recovery/sessionRecovery.js';
import type { RecoveryScanContext } from '../src/recovery/types.js';

const context: RecoveryScanContext = {
  homeDir: '/tmp/home',
  hostId: 'host-test',
  now: 1_000,
  processes: [],
  activeTerminalKeys: new Set(),
};

const recovered: FleetSnapshot = {
  protocolVersion: 1,
  providerId: 'omp',
  hostId: 'host-test',
  sourceId: 'recovery:omp',
  sentAt: 1_000,
  leaseTtlMs: 4_000,
  inferred: true,
  agents: [],
};

describe('SessionRecoveryMonitor', () => {
  it('publishes successful scanners while isolating a failed provider', async () => {
    const publish = vi.fn();
    const monitor = new SessionRecoveryMonitor({
      hostId: 'host-test',
      collectContext: async () => context,
      scanners: [async () => recovered, async () => Promise.reject(new Error('locked'))],
      publish,
    });

    await monitor.scanNow();

    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(recovered);
  });

  it('coalesces overlapping scan requests', async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collectContext = vi.fn(async () => {
      await blocked;
      return context;
    });
    const monitor = new SessionRecoveryMonitor({
      hostId: 'host-test',
      collectContext,
      scanners: [async () => recovered],
      publish: vi.fn(),
    });

    const first = monitor.scanNow();
    const second = monitor.scanNow();
    release?.();
    await Promise.all([first, second]);

    expect(collectContext).toHaveBeenCalledOnce();
  });
});
