import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface StandaloneHostActions {
  openSessionsFolder(): Promise<void>;
  exportLayout(layout: Record<string, unknown>): Promise<void>;
  importLayout(): Promise<Record<string, unknown> | null>;
  chooseExternalAssetDirectory(): Promise<string | null>;
}

async function runAppleScript(script: string): Promise<string | null> {
  if (process.platform !== 'darwin') {
    throw new Error('Native file dialogs are currently supported only on macOS');
  }

  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', ['-e', script]);
    return stdout.trim() || null;
  } catch (error) {
    const result = error as NodeJS.ErrnoException & { stderr?: string };
    if (result.code === '1' && result.stderr?.includes('User canceled')) return null;
    throw error;
  }
}

async function openSessionsFolder(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('Opening the sessions folder is currently supported only on macOS');
  }
  await execFileAsync('/usr/bin/open', [join(homedir(), '.claude', 'projects')]);
}

async function exportLayout(layout: Record<string, unknown>): Promise<void> {
  const filePath = await runAppleScript(
    'POSIX path of (choose file name with prompt "Export Pixel Agents layout" default name "pixel-agents-layout.json")',
  );
  if (!filePath) return;
  await writeFile(filePath, `${JSON.stringify(layout, null, 2)}\n`, 'utf8');
}

async function importLayout(): Promise<Record<string, unknown> | null> {
  const filePath = await runAppleScript(
    'POSIX path of (choose file with prompt "Import Pixel Agents layout" of type {"public.json"})',
  );
  if (!filePath) return null;

  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Imported Pixel Agents layout must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

async function chooseExternalAssetDirectory(): Promise<string | null> {
  return runAppleScript(
    'POSIX path of (choose folder with prompt "Select Pixel Agents asset directory")',
  );
}

export const standaloneHostActions: StandaloneHostActions = {
  openSessionsFolder,
  exportLayout,
  importLayout,
  chooseExternalAssetDirectory,
};
