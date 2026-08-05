#!/usr/bin/env bash
# Build the static site and publish it to the Caddy serve dir.
# Idempotent; safe to re-run. Assumes install.sh has set up /srv/foraging + Caddy.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVE_DIR="/srv/foraging"

cd "$REPO_DIR"

echo "==> Installing deps (npm ci if lockfile, else npm install)"
if [ -f package-lock.json ]; then npm ci; else npm install; fi

echo "==> Ensuring the SQLite DB exists (create-if-missing; never clobbers live data)"
node scripts/db-init.mjs

echo "==> Building static site (plant pages render from the DB)"
npm run build

echo "==> Publishing dist/ → $SERVE_DIR"
if [ ! -d "$SERVE_DIR" ]; then
  echo "!! $SERVE_DIR missing — run scripts/install.sh first" >&2
  exit 1
fi
rsync -a --delete "$REPO_DIR/dist/" "$SERVE_DIR/"

# Restart the live data API so a new server/api.mjs is picked up. Best-effort:
# the static site is already published and stands on its own if this is a no-op
# (e.g. first deploy before install.sh has created the unit).
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
if systemctl --user list-unit-files foraging-api.service >/dev/null 2>&1; then
  echo "==> Restarting foraging-api service"
  systemctl --user restart foraging-api.service || echo "   (restart skipped — service not active)"
fi

echo "==> Done. https://foraging.condrea.dev/"
