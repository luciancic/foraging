#!/usr/bin/env bash
# Build the static site and publish it to the Caddy serve dir.
# Idempotent; safe to re-run. Assumes install.sh has set up /srv/foraging + Caddy.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVE_DIR="/srv/foraging"

cd "$REPO_DIR"

echo "==> Installing deps (npm ci if lockfile, else npm install)"
if [ -f package-lock.json ]; then npm ci; else npm install; fi

echo "==> Building static site"
npm run build

echo "==> Publishing dist/ → $SERVE_DIR"
if [ ! -d "$SERVE_DIR" ]; then
  echo "!! $SERVE_DIR missing — run scripts/install.sh first" >&2
  exit 1
fi
rsync -a --delete "$REPO_DIR/dist/" "$SERVE_DIR/"

echo "==> Done. https://foraging.condrea.dev/"
