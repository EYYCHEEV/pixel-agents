#!/usr/bin/env bash

set -euo pipefail

EXT_ID="pablodelucca.pixel-agents"
EXT_VERSION="$(node -p "require('./package.json').version")"

if code --list-extensions --show-versions | grep -qx "${EXT_ID}@${EXT_VERSION}"; then
  exit 0
fi

VSIX="$(ls -t pixel-agents-*.vsix 2>/dev/null | head -1 || true)"

if [ -z "$VSIX" ]; then
  if ! command -v vsce >/dev/null 2>&1; then
    npm install -g @vscode/vsce
  fi

  rm -f pixel-agents-*.vsix
  npm run package >/dev/null 2>&1
  vsce package --no-dependencies >/dev/null 2>&1
  VSIX="$(ls -t pixel-agents-*.vsix 2>/dev/null | head -1 || true)"
fi

if [ -n "$VSIX" ]; then
  code --install-extension "$VSIX" --force
fi
