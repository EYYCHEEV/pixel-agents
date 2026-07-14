import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';

import type { FleetAgentProjection, FleetSnapshot } from '../../../core/src/fleet.js';
import type { RecoveryScanner } from './types.js';

const MAX_REGISTRIES = 64;
const MAX_REGISTRY_BYTES = 4 * 1024;
const MAX_CHILDREN = 64;
const MAX_DEPTH = 8;
const MAX_DIRECTORY_ENTRIES = 128;
const MAX_VISITED_NODES = 512;
const TAIL_BYTES = 16 * 1024;
const RUNNING_WINDOW_MS = 15_000;
const IDLE_WINDOW_MS = 2 * 60_000;

interface RegistryRecord {
  cwd: string;
  sessionFile: string;
  mtimeMs: number;
  size: number;
}

interface ChildArtifact {
  path: string;
  relativePath: string;
  mtimeMs: number;
  size: number;
}
type ArtifactClassification = 'live' | 'inFlight' | 'terminal';

function sequenceFromTimestamp(timestamp: number): number {
  return Math.max(0, Math.floor(timestamp));
}

function sessionIdFromFile(sessionFile: string): string | undefined {
  const name = basename(sessionFile, '.jsonl');
  const separator = name.lastIndexOf('_');
  const sessionId = separator >= 0 ? name.slice(separator + 1) : name;
  return sessionId || undefined;
}

async function readRegistry(path: string): Promise<RegistryRecord | undefined> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_REGISTRY_BYTES) return undefined;

    const lines = (await readFile(path, 'utf8')).split(/\r?\n/);
    const cwd = lines[0]?.trim();
    const sessionFile = lines[1]?.trim();
    if (!cwd || !sessionFile || extname(sessionFile) !== '.jsonl') return undefined;

    const sessionMetadata = await stat(sessionFile);
    if (!sessionMetadata.isFile()) return undefined;
    return {
      cwd,
      sessionFile,
      mtimeMs: Math.max(metadata.mtimeMs, sessionMetadata.mtimeMs),
      size: sessionMetadata.size,
    };
  } catch {
    return undefined;
  }
}

async function collectArtifacts(root: string): Promise<ChildArtifact[]> {
  const artifacts: ChildArtifact[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let visited = 0;

  while (queue.length > 0 && visited < MAX_VISITED_NODES) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = (await readdir(current.path, { withFileTypes: true }))
        .filter(
          (entry) =>
            entry.isDirectory() || (entry.isFile() && extname(entry.name) === '.jsonl'),
        )
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, MAX_DIRECTORY_ENTRIES);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (visited++ >= MAX_VISITED_NODES) break;
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < MAX_DEPTH) queue.push({ path, depth: current.depth + 1 });
        continue;
      }

      try {
        const metadata = await stat(path);
        if (!metadata.isFile()) continue;
        artifacts.push({
          path,
          relativePath: relative(root, path),
          mtimeMs: metadata.mtimeMs,
          size: metadata.size,
        });
      } catch {
        // Concurrent writers may rename an artifact between directory and metadata reads.
      }
    }
  }

  return artifacts.sort((left, right) =>
    right.mtimeMs - left.mtimeMs || left.relativePath.localeCompare(right.relativePath),
  ).slice(0, MAX_CHILDREN);
}

async function readTail(artifact: ChildArtifact): Promise<string> {
  const length = Math.min(artifact.size, TAIL_BYTES);
  if (length === 0) return '';

  const handle = await open(artifact.path, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    const { bytesRead } = await handle.read(buffer, 0, length, artifact.size - length);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function classifyTail(tail: string): ArtifactClassification | undefined {
  const lines = tail.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith('{')) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type !== 'message' || !value.message || typeof value.message !== 'object') continue;
      const message = value.message as Record<string, unknown>;
      const role = message.role;
      if (role === 'assistant') {
        const content = Array.isArray(message.content) ? message.content : [];
        const hasToolCall = content.some(
          (item) =>
            !!item &&
            typeof item === 'object' &&
            (item as Record<string, unknown>).type === 'toolCall',
        );
        return message.stopReason === 'toolUse' || hasToolCall ? 'inFlight' : 'terminal';
      }
      if (role === 'toolResult' || role === 'user') return 'live';
    } catch {
      // A partial first tail line can occur when a bounded read starts mid-event.
    }
  }
  return undefined;
}

function statusFromAge(now: number, mtimeMs: number): FleetAgentProjection['status'] {
  const age = Math.max(0, now - mtimeMs);
  if (age <= RUNNING_WINDOW_MS) return 'running';
  if (age <= IDLE_WINDOW_MS) return 'idle';
  return 'parked';
}

function identityFromArtifact(sessionId: string, relativePath: string): Pick<FleetAgentProjection, 'agentId' | 'parent'> {
  const segments = relativePath.split(sep);
  const agentId = basename(segments.at(-1)!, '.jsonl');
  const parentAgentId = segments.length === 1 ? 'Main' : segments.at(-2)!;
  return {
    agentId,
    parent: { sessionId, agentId: parentAgentId },
  };
}

export const scanOmpRecovery: RecoveryScanner = async (context): Promise<FleetSnapshot> => {
  const registryRoot = join(context.homeDir, '.omp', 'agent', 'terminal-sessions');
  let registryNames: string[] = [];
  try {
    registryNames = (await readdir(registryRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && context.activeTerminalKeys.has(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(0, MAX_REGISTRIES);
  } catch {
    // Missing OMP state is a valid empty recovery snapshot.
  }

  const agents: FleetAgentProjection[] = [];
  for (const registryName of registryNames) {
    const registry = await readRegistry(join(registryRoot, registryName));
    if (!registry) continue;

    const sessionsRoot = join(context.homeDir, '.omp', 'agent', 'sessions');
    const relativeSessionPath = relative(sessionsRoot, registry.sessionFile);
    if (
      relativeSessionPath === '' ||
      relativeSessionPath === '..' ||
      relativeSessionPath.startsWith(`..${sep}`) ||
      isAbsolute(relativeSessionPath)
    ) continue;

    const sessionId = sessionIdFromFile(registry.sessionFile);
    if (!sessionId) continue;
    const projectLabel = basename(registry.cwd) || registry.cwd;
    let mainClassification: ArtifactClassification | undefined;
    try {
      mainClassification = classifyTail(
        await readTail({
          path: registry.sessionFile,
          relativePath: basename(registry.sessionFile),
          mtimeMs: registry.mtimeMs,
          size: registry.size,
        }),
      );
    } catch {
      // Fall back to bounded activity age when the active session tail cannot be read.
    }
    const mainStatus =
      mainClassification === 'live' || mainClassification === 'inFlight'
        ? 'running'
        : mainClassification === 'terminal'
          ? 'idle'
          : statusFromAge(context.now, registry.mtimeMs);
    agents.push({
      sessionId,
      agentId: 'Main',
      role: 'main',
      projectLabel,
      status: mainStatus,
      sequence: sequenceFromTimestamp(registry.mtimeMs),
      updatedAt: registry.mtimeMs,
    });

    const artifactRoot = join(dirname(registry.sessionFile), basename(registry.sessionFile, '.jsonl'));
    for (const artifact of await collectArtifacts(artifactRoot)) {
      let classification: ArtifactClassification | undefined;
      try {
        classification = classifyTail(await readTail(artifact));
      } catch {
        continue;
      }
      if (classification === undefined || classification === 'terminal') continue;

      const identity = identityFromArtifact(sessionId, artifact.relativePath);
      agents.push({
        sessionId,
        ...identity,
        role: identity.agentId,
        projectLabel,
        status:
          classification === 'inFlight' ? 'running' : statusFromAge(context.now, artifact.mtimeMs),
        sequence: sequenceFromTimestamp(artifact.mtimeMs),
        updatedAt: artifact.mtimeMs,
      });
    }
  }

  return {
    protocolVersion: 1,
    providerId: 'omp',
    hostId: context.hostId,
    sourceId: 'recovery:omp',
    sentAt: context.now,
    leaseTtlMs: 4_000,
    inferred: true,
    agents,
  };
};
