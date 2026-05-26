import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webviewDir = path.join(repoRoot, 'webview-ui');
const previewBase = process.env['WEBVIEW_PREVIEW_BASE'] ?? '/webview/';
const previewOutDir =
  process.env['WEBVIEW_PREVIEW_OUT_DIR'] ?? path.join(repoRoot, 'dist', 'webview-preview');

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCommand, ['run', 'build'], {
  cwd: webviewDir,
  env: {
    ...process.env,
    WEBVIEW_BASE: previewBase,
    WEBVIEW_OUT_DIR: previewOutDir,
  },
  stdio: 'inherit',
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
