import assert from 'node:assert/strict';

import { test } from 'vitest';

import type { FleetAgentMeta } from '../../core/src/messages.js';
import { OfficeState } from '../src/office/engine/officeState.js';
import {
  fleetCharacterAppearance,
  isFleetChild,
  shouldMaterializeFleetAgent,
} from '../src/office/fleetPresentation.js';
import type { OfficeLayout } from '../src/office/types.js';
import { TileType } from '../src/office/types.js';

const main: FleetAgentMeta = {
  providerId: 'omp',
  hostId: 'local',
  sessionId: 'session-1',
  agentId: 'Main',
  role: 'main',
  status: 'running',
};

const child: FleetAgentMeta = {
  ...main,
  agentId: 'reviewer',
  role: 'reviewer',
  isChild: true,
};

test('running and waiting fleet agents materialize', () => {
  for (const status of ['running', 'waiting'] as const) {
    assert.equal(shouldMaterializeFleetAgent({ ...main, status }), true, status);
    assert.equal(shouldMaterializeFleetAgent({ ...child, status }), true, status);
  }
  for (const status of ['idle', 'parked', 'completed', 'disconnected'] as const) {
    assert.equal(shouldMaterializeFleetAgent({ ...main, status }), false, status);
    assert.equal(shouldMaterializeFleetAgent({ ...child, status }), false, status);
  }
});

test('child identity remains explicit when its parent is unresolved', () => {
  assert.equal(isFleetChild(child), true);
  assert.equal(isFleetChild({ ...child, isChild: undefined, parentAgentId: 42 }), true);
});

test('every fleet character appearance is stable, human, and never hue rotated', () => {
  const fleetMain = fleetCharacterAppearance(main, 6);
  const first = fleetCharacterAppearance(child, 6);
  const second = fleetCharacterAppearance({ ...child }, 6);
  const sibling = fleetCharacterAppearance({ ...child, agentId: 'verifier' }, 6);

  assert.deepEqual(first, second);
  assert.equal(fleetMain.hueShift, 0);
  assert.equal(first.hueShift, 0);
  assert.equal(sibling.hueShift, 0);
  assert.ok(fleetMain.palette >= 0 && fleetMain.palette < 6);
  assert.ok(first.palette >= 0 && first.palette < 6);
  assert.ok(sibling.palette >= 0 && sibling.palette < 6);
});

test('a despawning hidden child revives once under the same character identity', () => {
  const layout: OfficeLayout = {
    version: 1,
    cols: 5,
    rows: 5,
    tiles: new Array(25).fill(TileType.FLOOR_1),
    furniture: [],
  };
  const office = new OfficeState(layout);

  office.addAgent(7, 1, 0);
  office.removeAgent(7);
  assert.equal(office.characters.get(7)?.matrixEffect, 'despawn');

  office.addAgent(7, 1, 0);
  office.addAgent(7, 1, 0);
  assert.equal(office.characters.size, 1);
  assert.equal(office.characters.get(7)?.id, 7);
  assert.equal(office.characters.get(7)?.hueShift, 0);
  assert.notEqual(office.characters.get(7)?.matrixEffect, 'despawn');
});

test('fleet demand never expands the operator-authored layout', () => {
  const layout: OfficeLayout = {
    version: 1,
    cols: 5,
    rows: 5,
    tiles: new Array(25).fill(TileType.FLOOR_1),
    furniture: [],
  };
  const office = new OfficeState(layout);
  const before = structuredClone(office.getLayout());

  for (let id = 1; id <= 20; id++) office.addAgent(id, id % 6, 0);

  assert.deepEqual(office.getLayout(), before);
  assert.equal(office.tileMap.length, before.rows);
  assert.equal(office.tileMap[0].length, before.cols);
  assert.equal(office.seats.size, 0);
});
