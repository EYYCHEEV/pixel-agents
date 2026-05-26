import { type ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { waitForHookServer } from './hooks';

const DEFAULT_HOLD_OPEN_MS = 30_000;
const HOOK_SETUP_TIMEOUT_MS = 20_000;
const INVOCATION_TIMEOUT_MS = 20_000;
const SCENARIO_SCHEMA_VERSION = 1;

export interface ClaudeMockSessionDefinition {
  alias: string;
  sessionIdTemplate: string;
  cwdTemplate?: string;
  transcriptPathTemplate?: string;
  sidecarPathTemplate?: string;
  sidecarJson?: Record<string, unknown>;
}

export interface ClaudeMockAppendJsonlAction {
  kind: 'appendJsonl';
  atMs: number;
  session: string;
  record: Record<string, unknown>;
}

export interface ClaudeMockEmitHookAction {
  kind: 'emitHook';
  atMs: number;
  payload: Record<string, unknown>;
}

export interface ClaudeMockWriteJsonAction {
  kind: 'writeJson';
  atMs: number;
  filePath: string;
  value: Record<string, unknown>;
}

export interface ClaudeMockDeletePathAction {
  kind: 'deletePath';
  atMs: number;
  filePath: string;
}

export interface ClaudeMockExitAction {
  kind: 'exit';
  atMs: number;
  code?: number;
}

export type ClaudeMockAction =
  | ClaudeMockAppendJsonlAction
  | ClaudeMockEmitHookAction
  | ClaudeMockWriteJsonAction
  | ClaudeMockDeletePathAction
  | ClaudeMockExitAction;

export interface ClaudeMockScenario {
  schemaVersion: number;
  name?: string;
  autoInit: boolean;
  holdOpenMs: number;
  sessions: ClaudeMockSessionDefinition[];
  actions: ClaudeMockAction[];
}

class TimedScenarioStepBuilder {
  constructor(
    private readonly scenario: ClaudeMockScenarioBuilder,
    private readonly atMs: number,
  ) {}

  appendJsonl(
    record: Record<string, unknown>,
    options?: { session?: string },
  ): ClaudeMockScenarioBuilder {
    this.scenario.pushAction({
      kind: 'appendJsonl',
      atMs: this.atMs,
      session: options?.session ?? 'self',
      record,
    });
    return this.scenario;
  }

  emitHook(payload: Record<string, unknown>): ClaudeMockScenarioBuilder {
    this.scenario.pushAction({
      kind: 'emitHook',
      atMs: this.atMs,
      payload,
    });
    return this.scenario;
  }

  writeJson(filePath: string, value: Record<string, unknown>): ClaudeMockScenarioBuilder {
    this.scenario.pushAction({
      kind: 'writeJson',
      atMs: this.atMs,
      filePath,
      value,
    });
    return this.scenario;
  }

  deletePath(filePath: string): ClaudeMockScenarioBuilder {
    this.scenario.pushAction({
      kind: 'deletePath',
      atMs: this.atMs,
      filePath,
    });
    return this.scenario;
  }

  exit(code = 0): ClaudeMockScenarioBuilder {
    this.scenario.pushAction({
      kind: 'exit',
      atMs: this.atMs,
      code,
    });
    return this.scenario;
  }
}

export class ClaudeMockScenarioBuilder {
  private autoInit = true;
  private holdOpenMs = DEFAULT_HOLD_OPEN_MS;
  private readonly sessions: ClaudeMockSessionDefinition[] = [];
  private readonly actions: ClaudeMockAction[] = [];

  constructor(private readonly name?: string) {}

  defineSession(
    alias: string,
    sessionIdTemplate: string,
    options?: {
      cwdTemplate?: string;
      transcriptPathTemplate?: string;
      sidecarPathTemplate?: string;
      sidecarJson?: Record<string, unknown>;
    },
  ): ClaudeMockScenarioBuilder {
    this.sessions.push({
      alias,
      sessionIdTemplate,
      cwdTemplate: options?.cwdTemplate,
      transcriptPathTemplate: options?.transcriptPathTemplate,
      sidecarPathTemplate: options?.sidecarPathTemplate,
      sidecarJson: options?.sidecarJson,
    });
    return this;
  }

  withoutAutoInit(): ClaudeMockScenarioBuilder {
    this.autoInit = false;
    return this;
  }

  holdOpenFor(ms: number): ClaudeMockScenarioBuilder {
    this.holdOpenMs = ms;
    return this;
  }

  at(ms: number): TimedScenarioStepBuilder {
    return new TimedScenarioStepBuilder(this, ms);
  }

  exitAt(ms: number, code = 0): ClaudeMockScenarioBuilder {
    this.pushAction({
      kind: 'exit',
      atMs: ms,
      code,
    });
    return this;
  }

  pushAction(action: ClaudeMockAction): void {
    this.actions.push(action);
  }

  build(): ClaudeMockScenario {
    return {
      schemaVersion: SCENARIO_SCHEMA_VERSION,
      name: this.name,
      autoInit: this.autoInit,
      holdOpenMs: this.holdOpenMs,
      sessions: [...this.sessions],
      actions: [...this.actions].sort((left, right) => left.atMs - right.atMs),
    };
  }
}

export function claudeScenario(name?: string): ClaudeMockScenarioBuilder {
  return new ClaudeMockScenarioBuilder(name);
}

export function mockClaudeInitRecord(content = 'mock-claude-ready'): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    content,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMockRoot(tmpHome: string): string {
  return path.join(tmpHome, '.claude-mock');
}

function getScenarioQueuePath(tmpHome: string): string {
  return path.join(getMockRoot(tmpHome), 'scenario-queue.json');
}

function readScenarioQueue(tmpHome: string): ClaudeMockScenario[] {
  const queuePath = getScenarioQueuePath(tmpHome);
  try {
    const raw = fs.readFileSync(queuePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as ClaudeMockScenario[]) : [];
  } catch {
    return [];
  }
}

function writeScenarioQueue(tmpHome: string, queue: ClaudeMockScenario[]): void {
  const queuePath = getScenarioQueuePath(tmpHome);
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
}

function readTextIfExists(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function hooksInstalledInSettings(settingsPath: string): boolean {
  try {
    const raw = fs.readFileSync(settingsPath, 'utf8');
    const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown> };
    const hooks = parsed.hooks;
    return Boolean(
      hooks &&
      Array.isArray(hooks['SessionStart']) &&
      Array.isArray(hooks['PreToolUse']) &&
      Array.isArray(hooks['SessionEnd']),
    );
  } catch {
    return false;
  }
}

export async function waitForClaudeHookSetup(tmpHome: string): Promise<void> {
  await waitForHookServer(tmpHome);

  const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
  const hookScriptPath = path.join(tmpHome, '.pixel-agents', 'hooks', 'claude-hook.js');
  const deadline = Date.now() + HOOK_SETUP_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (fs.existsSync(hookScriptPath) && hooksInstalledInSettings(settingsPath)) {
      return;
    }
    await sleep(250);
  }

  throw new Error(
    `Timed out waiting for Claude hook setup at ${settingsPath} and ${hookScriptPath}`,
  );
}

export async function arrangeNextClaudeInvocation(
  tmpHome: string,
  scenario: ClaudeMockScenario,
): Promise<void> {
  const queue = readScenarioQueue(tmpHome);
  queue.push(scenario);
  writeScenarioQueue(tmpHome, queue);
}

function getMockClaudeBinaryPath(tmpHome: string): string {
  const binDir = path.resolve(tmpHome, '..', 'bin');
  return path.join(binDir, process.platform === 'win32' ? 'claude.cmd' : 'claude');
}

export interface ExternalClaudeSpawn {
  process: ChildProcess;
  sessionId: string;
}

export async function spawnExternalClaudeScenario(options: {
  tmpHome: string;
  workspaceDir: string;
  mockLogFile: string;
  scenario: ClaudeMockScenario;
  sessionId: string;
}): Promise<ExternalClaudeSpawn> {
  await arrangeNextClaudeInvocation(options.tmpHome, options.scenario);

  const claudeBinary = getMockClaudeBinaryPath(options.tmpHome);
  const env = {
    ...process.env,
    HOME: options.tmpHome,
    PATH: `${path.dirname(claudeBinary)}${path.delimiter}${process.env['PATH'] ?? ''}`,
    PIXEL_AGENTS_NODE_BIN: process.execPath,
  };

  const child = spawn(claudeBinary, ['--session-id', options.sessionId], {
    cwd: options.workspaceDir,
    env,
    shell: process.platform === 'win32',
    stdio: 'ignore',
  });

  const deadline = Date.now() + INVOCATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const invocationLog = readTextIfExists(options.mockLogFile);
    if (invocationLog.includes(`session-id=${options.sessionId}`)) {
      return {
        process: child,
        sessionId: options.sessionId,
      };
    }
    await sleep(250);
  }

  throw new Error(`Timed out waiting for external mock Claude session ${options.sessionId}`);
}
