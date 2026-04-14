#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-$HOME/.openclaw/extensions/openclaw-codex-app-server}"

mkdir -p "$TARGET"
rm -rf "$TARGET/node_modules/openclaw"

rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'coverage' \
  --exclude '.turbo' \
  --exclude '.DS_Store' \
  "$REPO_ROOT/" "$TARGET/"

printf 'Deployed repo -> %s\n' "$TARGET"
