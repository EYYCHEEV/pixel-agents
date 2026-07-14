import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import type { RecoveryProcess, RecoveryScanContext } from './types.js';

const execFileAsync = promisify(execFile);
const MAX_COMMAND_OUTPUT_BYTES = 1024 * 1024;

export function parseProcessList(output: string): RecoveryProcess[] {
  const processes: RecoveryProcess[] = [];
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    processes.push({
      pid,
      ...(match[2] === '??' || match[2] === '-' ? {} : { tty: path.basename(match[2]) }),
      command: match[3],
    });
  }
  return processes;
}

export function isOmpProcess(processInfo: RecoveryProcess): boolean {
  return /(?:^|[\s/])omp(?:\s|$)/i.test(processInfo.command);
}

export function parseTmuxTerminalKeys(output: string, ompTtys: ReadonlySet<string>): Set<string> {
  const keys = new Set<string>();
  for (const line of output.split('\n')) {
    const [paneId, paneTty] = line.split('\t');
    if (!paneId || !paneTty || !ompTtys.has(path.basename(paneTty))) continue;
    keys.add(`tmux-${paneId}`);
  }
  return keys;
}

async function commandOutput(command: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      timeout: 750,
    });
    return result.stdout;
  } catch {
    return '';
  }
}

export async function collectRecoveryContext(
  hostId: string,
  now = Date.now(),
  homeDir = os.homedir(),
): Promise<RecoveryScanContext> {
  const processOutput = await commandOutput('/bin/ps', ['-axo', 'pid=,tty=,command=']);
  const processes = parseProcessList(processOutput);
  const ompTtys = new Set(
    processes
      .filter((processInfo) => processInfo.tty && isOmpProcess(processInfo))
      .map((processInfo) => processInfo.tty as string),
  );
  const activeTerminalKeys = new Set(ompTtys);

  const tmuxOutput = await commandOutput('tmux', [
    'list-panes',
    '-a',
    '-F',
    '#{pane_id}\t#{pane_tty}',
  ]);
  for (const key of parseTmuxTerminalKeys(tmuxOutput, ompTtys)) activeTerminalKeys.add(key);

  return { homeDir, hostId, now, processes, activeTerminalKeys };
}
