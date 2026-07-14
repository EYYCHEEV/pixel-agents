import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import type { AssetCache } from '../src/clientMessageHandler.js';
import type { StandaloneHostActions } from '../src/standaloneHostActions.js';

let tempHome: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tempHome };
});

// The handler must load after the mocked home-directory boundary.
const { handleClientMessage } = await import('../src/clientMessageHandler.js');

function emptyCache(defaultLayout: Record<string, unknown> | null = null): AssetCache {
  return {
    characters: null,
    pets: null,
    floorTiles: null,
    wallTiles: null,
    furniture: null,
    defaultLayout,
  };
}

function fakeHostActions(
  overrides: Partial<StandaloneHostActions> = {},
): StandaloneHostActions {
  return {
    openSessionsFolder: vi.fn(async () => undefined),
    exportLayout: vi.fn(async () => undefined),
    importLayout: vi.fn(async () => null),
    chooseExternalAssetDirectory: vi.fn(async () => null),
    ...overrides,
  };
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agents-client-message-'));
});

afterEach(() => {
  fs.rmSync(tempHome, { recursive: true, force: true });
});

it('dispatches open and export actions through the standalone host', async () => {
  const layout = { version: 1, cols: 20, rows: 11 };
  const hostActions = fakeHostActions();
  const store = new AgentStateStore();

  handleClientMessage({ type: 'openSessionsFolder' }, vi.fn(), {
    store,
    cache: emptyCache(layout),
    hostActions,
  });
  handleClientMessage({ type: 'exportLayout' }, vi.fn(), {
    store,
    cache: emptyCache(layout),
    hostActions,
  });

  await vi.waitFor(() => {
    expect(hostActions.openSessionsFolder).toHaveBeenCalledOnce();
    expect(hostActions.exportLayout).toHaveBeenCalledWith(layout);
  });
});

it('persists an imported layout and publishes it to the current client', async () => {
  const imported = { version: 1, cols: 2, rows: 2, tiles: [1, 1, 1, 1], furniture: [] };
  const hostActions = fakeHostActions({ importLayout: vi.fn(async () => imported) });
  const send = vi.fn();

  handleClientMessage({ type: 'importLayout' }, send, {
    store: new AgentStateStore(),
    cache: emptyCache(),
    hostActions,
  });

  await vi.waitFor(() => {
    expect(send).toHaveBeenCalledWith({ type: 'layoutLoaded', layout: imported });
  });
  expect(
    JSON.parse(fs.readFileSync(path.join(tempHome, '.pixel-agents', 'layout.json'), 'utf8')),
  ).toEqual(imported);
});

it('rejects an invalid imported layout', async () => {
  const invalid = { version: 1, cols: 24, rows: 14 };
  const hostActions = fakeHostActions({ importLayout: vi.fn(async () => invalid) });
  const send = vi.fn();
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  handleClientMessage({ type: 'importLayout' }, send, {
    store: new AgentStateStore(),
    cache: emptyCache(),
    hostActions,
  });

  await vi.waitFor(() => {
    expect(error).toHaveBeenCalledWith(
      '[Pixel Agents] Failed to import layout: Invalid layout file',
    );
  });
  expect(send).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(tempHome, '.pixel-agents', 'layout.json'))).toBe(false);
  error.mockRestore();
});

it('reloads standalone assets after directory changes', async () => {
  const assetDirectory = path.join(tempHome, 'custom-assets');
  const hostActions = fakeHostActions({
    chooseExternalAssetDirectory: vi.fn(async () => assetDirectory),
  });
  const send = vi.fn();
  const cache = emptyCache();
  const onReloadExternalAssets = vi.fn(async () => {
    cache.characters = { characters: [] };
    cache.pets = { pets: [], manifests: [] };
    cache.furniture = { catalog: [], sprites: new Map() };
  });
  const ctx = {
    store: new AgentStateStore(),
    cache,
    hostActions,
    onReloadExternalAssets,
  };

  handleClientMessage({ type: 'addExternalAssetDirectory' }, send, ctx);

  await vi.waitFor(() => {
    expect(onReloadExternalAssets).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({
      type: 'externalAssetDirectoriesUpdated',
      dirs: [assetDirectory],
    });
    expect(send).toHaveBeenCalledWith({ type: 'characterSpritesLoaded', characters: [] });
    expect(send).toHaveBeenCalledWith({ type: 'petSpritesLoaded', pets: [], petNames: [] });
    expect(send).toHaveBeenCalledWith({
      type: 'furnitureAssetsLoaded',
      catalog: [],
      sprites: {},
    });
  });

  handleClientMessage(
    { type: 'removeExternalAssetDirectory', path: assetDirectory },
    send,
    ctx,
  );
  await vi.waitFor(() => {
    expect(onReloadExternalAssets).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledWith({
      type: 'externalAssetDirectoriesUpdated',
      dirs: [],
    });
  });

  const config = JSON.parse(
    fs.readFileSync(path.join(tempHome, '.pixel-agents', 'config.json'), 'utf8'),
  ) as { externalAssetDirectories: string[] };
  expect(config.externalAssetDirectories).toEqual([]);
});
