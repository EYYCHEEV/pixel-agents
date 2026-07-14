import type { FleetAgentMeta } from '../../core/src/messages.js';
import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import type { LoadedAssets, LoadedCharacterSprites, LoadedPetSprites } from './assetLoader.js';
import { readConfig, writeConfig } from './configPersistence.js';
import { fleetMetaFromAgent } from './fleetRuntime.js';
import { readLayoutFromFile, writeLayoutToFile } from './layoutPersistence.js';
import { claudeProvider } from './providers/index.js';
import type { StandaloneHostActions } from './standaloneHostActions.js';
import { standaloneHostActions } from './standaloneHostActions.js';

type WsSend = (message: Record<string, unknown>) => void;

/** Async hook toggle side effect (install/uninstall + script copy). Provided by cli.ts. */
export type SetHooksEnabledSideEffect = (enabled: boolean) => Promise<void> | void;
export type ReloadExternalAssetsSideEffect = () => Promise<void>;

/** Cached assets loaded at server startup. Sent to each WebSocket client on webviewReady. */
export interface AssetCache {
  characters: LoadedCharacterSprites | null;
  pets: LoadedPetSprites | null;
  floorTiles: string[][][] | null;
  wallTiles: string[][][][] | null;
  furniture: LoadedAssets | null;
  defaultLayout: Record<string, unknown> | null;
}

export interface ClientMessageContext {
  store: AgentStateStore;
  runtime?: AgentRuntime;
  cache: AssetCache | null;
  /** Install/uninstall hooks side effect. Needs server url+token known only to cli.ts. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
  /** Reload the mutable standalone asset cache after directory changes. */
  onReloadExternalAssets?: ReloadExternalAssetsSideEffect;
  /** Native standalone actions for Finder and file/directory dialogs. */
  hostActions?: StandaloneHostActions;
}

// ── Setting key constants (mirror adapters/vscode/constants.ts) ──
const KEY_SOUND_ENABLED = 'pixel-agents.soundEnabled';
const KEY_LAST_SEEN_VERSION = 'pixel-agents.lastSeenVersion';
const KEY_ALWAYS_SHOW_LABELS = 'pixel-agents.alwaysShowLabels';
const KEY_WATCH_ALL_SESSIONS = 'pixel-agents.watchAllSessions';
const KEY_HOOKS_ENABLED = 'pixel-agents.hooksEnabled';
const KEY_HOOKS_INFO_SHOWN = 'pixel-agents.hooksInfoShown';

/**
 * Handle incoming ClientMessage from a WebSocket client.
 *
 * In standalone mode, the server is the authority for all state: assets,
 * layout, settings, agents. Assets are loaded once at startup and cached
 * in memory. Each connecting client receives the full state on webviewReady.
 */
export function handleClientMessage(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: ClientMessageContext,
): void {
  const { store, runtime } = ctx;
  const adapter = store.getAdapter();
  const hostActions = ctx.hostActions ?? standaloneHostActions;

  switch (msg.type) {
    case 'webviewReady':
      handleWebviewReady(send, ctx);
      break;

    case 'saveLayout':
      if (msg.layout) {
        writeLayoutToFile(msg.layout as Record<string, unknown>);
      }
      break;

    case 'saveAgentSeats':
      if (msg.seats) {
        adapter?.saveSeats(
          msg.seats as Record<string, { palette?: number; hueShift?: number; seatId?: string }>,
        );
      }
      break;

    case 'setSoundEnabled':
      adapter?.setSetting(KEY_SOUND_ENABLED, msg.enabled);
      break;

    case 'setLastSeenVersion':
      adapter?.setSetting(KEY_LAST_SEEN_VERSION, msg.version as string);
      break;

    case 'setAlwaysShowLabels':
      adapter?.setSetting(KEY_ALWAYS_SHOW_LABELS, msg.enabled);
      break;

    case 'setWatchAllSessions': {
      const enabled = msg.enabled as boolean;
      adapter?.setSetting(KEY_WATCH_ALL_SESSIONS, enabled);
      if (runtime) runtime.watchAllSessions.current = enabled;
      break;
    }

    case 'setHooksEnabled': {
      const enabled = msg.enabled as boolean;
      adapter?.setSetting(KEY_HOOKS_ENABLED, enabled);
      if (runtime) runtime.hooksEnabled.current = enabled;
      void ctx.onSetHooksEnabled?.(enabled);
      break;
    }

    case 'setHooksInfoShown':
      adapter?.setSetting(KEY_HOOKS_INFO_SHOWN, true);
      break;

    case 'openSessionsFolder':
      void hostActions
        .openSessionsFolder()
        .catch((error) => reportHostActionError('open sessions folder', error));
      break;

    case 'exportLayout': {
      const layout = readLayoutFromFile() ?? ctx.cache?.defaultLayout;
      if (!layout) {
        console.warn('[Pixel Agents] No layout is available to export');
        break;
      }
      void hostActions
        .exportLayout(layout)
        .catch((error) => reportHostActionError('export layout', error));
      break;
    }

    case 'importLayout':
      void hostActions
        .importLayout()
        .then((layout) => {
          if (!layout) return;
          if (!isImportableLayout(layout)) {
            console.error('[Pixel Agents] Failed to import layout: Invalid layout file');
            return;
          }
          writeLayoutToFile(layout);
          send({ type: 'layoutLoaded', layout });
        })
        .catch((error) => reportHostActionError('import layout', error));
      break;

    case 'addExternalAssetDirectory': {
      const newPath = msg.path as string | undefined;
      if (!newPath) {
        void hostActions
          .chooseExternalAssetDirectory()
          .then((selectedPath) => {
            if (selectedPath) {
              handleClientMessage({ type: 'addExternalAssetDirectory', path: selectedPath }, send, ctx);
            }
          })
          .catch((error) => reportHostActionError('add external asset directory', error));
        break;
      }
      const cfg = readConfig();
      if (!cfg.externalAssetDirectories.includes(newPath)) {
        cfg.externalAssetDirectories.push(newPath);
        writeConfig(cfg);
      }
      send({ type: 'externalAssetDirectoriesUpdated', dirs: cfg.externalAssetDirectories });
      void reloadExternalAssets(send, ctx);
      break;
    }

    case 'removeExternalAssetDirectory': {
      const removePath = msg.path as string | undefined;
      if (!removePath) break;
      const cfg = readConfig();
      cfg.externalAssetDirectories = cfg.externalAssetDirectories.filter((d) => d !== removePath);
      writeConfig(cfg);
      send({ type: 'externalAssetDirectoriesUpdated', dirs: cfg.externalAssetDirectories });
      void reloadExternalAssets(send, ctx);
      break;
    }

    default:
      // focusAgent requires IDE-specific handling.
      break;
  }
}

function reportHostActionError(action: string, error: unknown): void {
  console.error(`[Pixel Agents] Failed to ${action}:`, error);
}

function isImportableLayout(layout: Record<string, unknown>): boolean {
  const { cols, rows, tiles, furniture, tileColors, pets } = layout;
  if (
    layout.version !== 1 ||
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    (cols as number) <= 0 ||
    (rows as number) <= 0 ||
    !Array.isArray(tiles) ||
    tiles.length !== (cols as number) * (rows as number) ||
    !tiles.every(Number.isInteger) ||
    !Array.isArray(furniture)
  ) {
    return false;
  }
  if (tileColors !== undefined && (!Array.isArray(tileColors) || tileColors.length !== tiles.length)) {
    return false;
  }
  return pets === undefined || Array.isArray(pets);
}

async function reloadExternalAssets(send: WsSend, ctx: ClientMessageContext): Promise<void> {
  if (!ctx.onReloadExternalAssets) return;
  try {
    await ctx.onReloadExternalAssets();
    sendReloadableAssets(send, ctx.cache);
  } catch (error) {
    reportHostActionError('reload external assets', error);
  }
}

function sendReloadableAssets(send: WsSend, cache: AssetCache | null): void {
  if (cache?.characters) {
    send({ type: 'characterSpritesLoaded', characters: cache.characters.characters });
  }
  if (cache?.pets) {
    send({
      type: 'petSpritesLoaded',
      pets: cache.pets.pets,
      petNames: cache.pets.manifests.map((manifest) => manifest.name),
    });
  }
  if (cache?.furniture) {
    send({
      type: 'furnitureAssetsLoaded',
      catalog: cache.furniture.catalog,
      sprites: Object.fromEntries(cache.furniture.sprites),
    });
  }
}

function handleWebviewReady(send: WsSend, ctx: ClientMessageContext): void {
  const { store, runtime, cache } = ctx;
  const adapter = store.getAdapter();

  // 1. Provider capabilities (must arrive before any agent messages)
  send({
    type: 'providerCapabilities',
    readingTools: [...claudeProvider.readingTools],
    subagentToolNames: [...claudeProvider.subagentToolNames],
  });

  // 2. Assets (from server cache, loaded at startup via pngjs)
  if (cache) {
    if (cache.characters) {
      send({ type: 'characterSpritesLoaded', characters: cache.characters.characters });
    }
    if (cache.pets) {
      send({
        type: 'petSpritesLoaded',
        pets: cache.pets.pets,
        petNames: cache.pets.manifests.map((m) => m.name),
      });
    }
    if (cache.floorTiles) {
      send({ type: 'floorTilesLoaded', sprites: cache.floorTiles });
    }
    if (cache.wallTiles) {
      send({ type: 'wallTilesLoaded', sets: cache.wallTiles });
    }
    if (cache.furniture) {
      send({
        type: 'furnitureAssetsLoaded',
        catalog: cache.furniture.catalog,
        sprites: Object.fromEntries(cache.furniture.sprites),
      });
    }
  }

  const savedLayout = readLayoutFromFile();

  // 3. Settings (from adapter, with sensible defaults when adapter is absent)
  const cfg = readConfig();
  const watchAllSessions = adapter?.getSetting(KEY_WATCH_ALL_SESSIONS, false) ?? false;
  const hooksEnabled = adapter?.getSetting(KEY_HOOKS_ENABLED, true) ?? true;
  send({
    type: 'settingsLoaded',
    soundEnabled: adapter?.getSetting(KEY_SOUND_ENABLED, true) ?? true,
    lastSeenVersion: adapter?.getSetting(KEY_LAST_SEEN_VERSION, '') ?? '',
    extensionVersion: process.env.PIXEL_AGENTS_VERSION ?? '',
    watchAllSessions,
    alwaysShowLabels: adapter?.getSetting(KEY_ALWAYS_SHOW_LABELS, false) ?? false,
    hooksEnabled,
    hooksInfoShown: adapter?.getSetting(KEY_HOOKS_INFO_SHOWN, false) ?? false,
    externalAssetDirectories: cfg.externalAssetDirectories,
  });

  // Sync runtime refs with the persisted settings so scanners behave correctly
  // from the first tick after a server restart.
  if (runtime) {
    runtime.watchAllSessions.current = watchAllSessions;
    runtime.hooksEnabled.current = hooksEnabled;
  }

  // 4. Restore persisted external agents (standalone only; VS Code handles its own restore)
  runtime?.restoreExternalAgents();

  // 5. Existing agents must precede layoutLoaded so the webview can buffer and instantiate them.
  const agentIds: number[] = [];
  const folderNames: Record<number, string> = {};
  const externalAgents: Record<number, boolean> = {};
  const agentDetails: Record<number, FleetAgentMeta> = {};
  for (const [id, agent] of store) {
    agentIds.push(id);
    if (agent.folderName) {
      folderNames[id] = agent.folderName;
    }
    if (agent.isExternal) {
      externalAgents[id] = true;
    }
    const fleet = fleetMetaFromAgent(agent);
    if (fleet) agentDetails[id] = fleet;
  }
  const seats = adapter?.loadSeats() ?? {};
  send({
    type: 'existingAgents',
    agents: agentIds,
    agentMeta: seats,
    folderNames,
    externalAgents,
    agentDetails,
  });

  // 6. Layout readiness drains the webview's buffered existing agents.
  send({ type: 'layoutLoaded', layout: savedLayout ?? cache?.defaultLayout ?? null });
  for (const [id, agent] of store) {
    if (!agent.fleetKey || !agent.fleetStatus) continue;
    send({
      type: 'agentStatus',
      id,
      status: agent.fleetStatus,
      activity: agent.fleetActivity,
    });
  }
}
