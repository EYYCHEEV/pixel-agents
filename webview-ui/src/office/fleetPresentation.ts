import type { FleetAgentMeta } from '../../../core/src/messages.js';

export interface FleetCharacterAppearance {
  palette: number;
  hueShift: 0;
}

export function isFleetChild(fleet: FleetAgentMeta): boolean {
  return fleet.isChild === true || fleet.parentAgentId !== undefined;
}

export function shouldMaterializeFleetAgent(fleet: FleetAgentMeta): boolean {
  return fleet.status === 'running' || fleet.status === 'waiting';
}

export function fleetCharacterAppearance(
  fleet: FleetAgentMeta,
  paletteCount: number,
): FleetCharacterAppearance {
  const count = Math.max(1, paletteCount);
  return { palette: hashFleetIdentity(fleet) % count, hueShift: 0 };
}

function hashFleetIdentity(fleet: FleetAgentMeta): number {
  const identity = `${fleet.providerId}\0${fleet.hostId}\0${fleet.sessionId}\0${fleet.agentId}`;
  let hash = 2_166_136_261;
  for (let index = 0; index < identity.length; index++) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}
