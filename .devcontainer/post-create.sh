#!/usr/bin/env bash

set -euo pipefail

npm install

if ! command -v vsce >/dev/null 2>&1; then
  npm install -g @vscode/vsce
fi

rm -f pixel-agents-*.vsix
npm run package
vsce package --no-dependencies
