#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_HOLD_OPEN_MS = 30_000;
const SCENARIO_SCHEMA_VERSION = 1;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseSessionId(argv) {
  let previous = '';
  for (const arg of argv) {
    if (previous === '--session-id') {
      return arg;
    }
    previous = arg;
  }
  return '';
}

function claudeProjectDirName(workspacePath) {
  return workspacePath.replace(/[^a-zA-Z0-9-]/g, '-');
}

function getMockRoot(homeDir) {
  return path.join(homeDir, '.claude-mock');
}

function getScenarioQueuePath(homeDir) {
  return path.join(getMockRoot(homeDir), 'scenario-queue.json');
}

function readScenarioQueue(homeDir) {
  try {
    const raw = fs.readFileSync(getScenarioQueuePath(homeDir), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeScenarioQueue(homeDir, queue) {
  const queuePath = getScenarioQueuePath(homeDir);
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(queuePath, JSON.stringify(queue, null, 2));
}

function claimScenario(homeDir) {
  const queue = readScenarioQueue(homeDir);
  if (queue.length === 0) {
    return null;
  }

  const [scenario, ...rest] = queue;
  writeScenarioQueue(homeDir, rest);
  return scenario;
}

function logLine(homeDir, fileName, line) {
  const logDir = getMockRoot(homeDir);
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(path.join(logDir, fileName), `${line}\n`);
}

function logInvocation(homeDir, sessionId, cwd, args) {
  logLine(
    homeDir,
    'invocations.log',
    `${new Date().toISOString()} session-id=${sessionId} cwd=${cwd} args=${args.join(' ')}`,
  );
}

function logAction(homeDir, message) {
  logLine(homeDir, 'actions.log', `${new Date().toISOString()} ${message}`);
}

function ensureSessionContext(homeDir, sessionId, cwd) {
  const projectDir = path.join(homeDir, '.claude', 'projects', claudeProjectDirName(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  return {
    sessionId,
    cwd,
    projectDir,
    transcriptPath: path.join(projectDir, `${sessionId}.jsonl`),
  };
}

function ensureSessionContextWithTranscript(homeDir, sessionId, cwd, transcriptPath) {
  const context = ensureSessionContext(homeDir, sessionId, cwd);
  if (!transcriptPath) {
    return context;
  }
  return {
    ...context,
    transcriptPath,
  };
}

function ensureTranscriptExists(transcriptPath) {
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  if (!fs.existsSync(transcriptPath)) {
    fs.writeFileSync(transcriptPath, '');
  }
}

function appendJsonl(transcriptPath, record) {
  ensureTranscriptExists(transcriptPath);
  fs.appendFileSync(transcriptPath, `${JSON.stringify(record)}\n`);
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function deletePathTarget(filePath) {
  fs.rmSync(filePath, { recursive: true, force: true });
}

function readSettings(homeDir) {
  try {
    const raw = fs.readFileSync(path.join(homeDir, '.claude', 'settings.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function normalizePathForMatch(value) {
  return String(value).replace(/\\/g, '/');
}

function isPixelAgentsHookCommand(homeDir, command) {
  if (typeof command !== 'string' || command.length === 0) {
    return false;
  }

  const normalizedCommand = normalizePathForMatch(command);
  const currentHookPath = normalizePathForMatch(
    path.join(homeDir, '.pixel-agents', 'hooks', 'claude-hook.js'),
  );

  return (
    normalizedCommand.includes(currentHookPath)
  );
}

function resolveTemplateString(template, context) {
  if (typeof template !== 'string') {
    return template;
  }

  return template.replace(/\{\{([^}]+)\}\}/g, (_match, rawKey) => {
    const key = rawKey.trim();
    const value = key.split('.').reduce((accumulator, segment) => {
      if (accumulator && Object.prototype.hasOwnProperty.call(accumulator, segment)) {
        return accumulator[segment];
      }
      return undefined;
    }, context);

    return value === undefined || value === null ? '' : String(value);
  });
}

function resolveValue(value, context) {
  if (typeof value === 'string') {
    return resolveTemplateString(value, context);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveValue(item, context));
  }

  if (value && typeof value === 'object') {
    const resolved = {};
    for (const [key, nested] of Object.entries(value)) {
      resolved[key] = resolveValue(nested, context);
    }
    return resolved;
  }

  return value;
}

function buildContext(homeDir, scenario, sessionId, cwd) {
  const self = ensureSessionContextWithTranscript(homeDir, sessionId, cwd);
  const context = {
    sessionId: self.sessionId,
    cwd: self.cwd,
    projectDir: self.projectDir,
    transcriptPath: self.transcriptPath,
    sessions: {
      self: {
        sessionId: self.sessionId,
        cwd: self.cwd,
        projectDir: self.projectDir,
        transcriptPath: self.transcriptPath,
      },
    },
  };

  for (const sessionDefinition of scenario.sessions || []) {
    const resolvedSessionId = resolveTemplateString(sessionDefinition.sessionIdTemplate, context);
    const resolvedCwd = resolveTemplateString(
      sessionDefinition.cwdTemplate || '{{cwd}}',
      context,
    );
    const resolvedTranscriptPath = sessionDefinition.transcriptPathTemplate
      ? resolveTemplateString(sessionDefinition.transcriptPathTemplate, context)
      : undefined;
    const sessionContext = ensureSessionContextWithTranscript(
      homeDir,
      resolvedSessionId,
      resolvedCwd,
      resolvedTranscriptPath,
    );
    const resolvedSidecarPath = sessionDefinition.sidecarPathTemplate
      ? resolveTemplateString(sessionDefinition.sidecarPathTemplate, {
          ...context,
          sessions: {
            ...context.sessions,
            [sessionDefinition.alias]: sessionContext,
          },
        })
      : undefined;
    const resolvedSidecarJson = sessionDefinition.sidecarJson
      ? resolveValue(sessionDefinition.sidecarJson, {
          ...context,
          sessions: {
            ...context.sessions,
            [sessionDefinition.alias]: sessionContext,
          },
        })
      : undefined;

    context.sessions[sessionDefinition.alias] = {
      ...sessionContext,
      sidecarPath: resolvedSidecarPath,
      sidecarJson: resolvedSidecarJson,
    };
  }

  return context;
}

function runHookCommand(command, payload, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      env,
      shell: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });

    child.on('error', () => resolve());
    child.on('close', () => resolve());
    child.stdin.end(JSON.stringify(payload));
  });
}

async function emitHook(homeDir, context, payload) {
  const eventName = payload.hook_event_name;
  if (typeof eventName !== 'string' || eventName.length === 0) {
    return;
  }

  const settings = readSettings(homeDir);
  const entries = Array.isArray(settings.hooks?.[eventName]) ? settings.hooks[eventName] : [];

  for (const entry of entries) {
    const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
    for (const hook of hooks) {
      if (hook?.type !== 'command' || typeof hook.command !== 'string' || hook.command.length === 0) {
        continue;
      }
      if (!isPixelAgentsHookCommand(homeDir, hook.command)) {
        continue;
      }
      await runHookCommand(hook.command, payload, process.env, context.cwd);
    }
  }
}

async function playScenario(homeDir, scenario, context) {
  for (const [alias, session] of Object.entries(context.sessions)) {
    if (!session.sidecarPath || session.sidecarJson === undefined) {
      continue;
    }
    writeJsonFile(session.sidecarPath, session.sidecarJson);
    logAction(
      homeDir,
      `writeJson ${alias} ${path.basename(session.sidecarPath)} ${JSON.stringify(session.sidecarJson)}`,
    );
  }

  if (scenario.autoInit !== false) {
    appendJsonl(context.transcriptPath, {
      type: 'system',
      subtype: 'init',
      content: 'mock-claude-ready',
    });
    logAction(homeDir, `appendJsonl self init ${path.basename(context.transcriptPath)}`);
  }

  const actions = Array.isArray(scenario.actions) ? [...scenario.actions] : [];
  actions.sort((left, right) => (left.atMs || 0) - (right.atMs || 0));

  const startedAt = Date.now();
  for (const action of actions) {
    const atMs = typeof action.atMs === 'number' ? action.atMs : 0;
    const delayMs = Math.max(0, startedAt + atMs - Date.now());
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    if (action.kind === 'appendJsonl') {
      const sessionAlias = action.session || 'self';
      const target = context.sessions[sessionAlias];
      if (!target) {
        throw new Error(`Unknown mock session alias "${sessionAlias}"`);
      }

      const record = resolveValue(action.record, context);
      appendJsonl(target.transcriptPath, record);
      logAction(
        homeDir,
        `appendJsonl ${sessionAlias} ${path.basename(target.transcriptPath)} ${JSON.stringify(record)}`,
      );
      continue;
    }

    if (action.kind === 'emitHook') {
      const payload = resolveValue(action.payload, context);
      await emitHook(homeDir, context, payload);
      logAction(homeDir, `emitHook ${payload.hook_event_name} ${JSON.stringify(payload)}`);
      continue;
    }

    if (action.kind === 'writeJson') {
      const filePath = resolveTemplateString(action.filePath, context);
      const value = resolveValue(action.value, context);
      writeJsonFile(filePath, value);
      logAction(
        homeDir,
        `writeJson ${path.basename(filePath)} ${JSON.stringify({ filePath, value })}`,
      );
      continue;
    }

    if (action.kind === 'deletePath') {
      const filePath = resolveTemplateString(action.filePath, context);
      deletePathTarget(filePath);
      logAction(homeDir, `deletePath ${JSON.stringify({ filePath })}`);
      continue;
    }

    if (action.kind === 'exit') {
      logAction(homeDir, `exit code=${action.code || 0}`);
      process.exit(typeof action.code === 'number' ? action.code : 0);
    }
  }

  const holdOpenMs =
    typeof scenario.holdOpenMs === 'number' ? scenario.holdOpenMs : DEFAULT_HOLD_OPEN_MS;
  if (holdOpenMs > 0) {
    await sleep(holdOpenMs);
  }
}

async function main() {
  const sessionId = parseSessionId(process.argv.slice(2));
  const cwd = process.cwd();
  const homeDir = os.homedir();
  const scenario = claimScenario(homeDir) || {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    autoInit: true,
    holdOpenMs: DEFAULT_HOLD_OPEN_MS,
    sessions: [],
    actions: [],
  };

  logInvocation(homeDir, sessionId, cwd, process.argv.slice(2));

  const context = buildContext(homeDir, scenario, sessionId, cwd);
  await playScenario(homeDir, scenario, context);
}

main()
  .catch((error) => {
    const homeDir = os.homedir();
    logAction(
      homeDir,
      `error ${error instanceof Error ? error.stack || error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
