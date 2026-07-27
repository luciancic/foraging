#!/usr/bin/env bash
# Stand up foraging.condrea.dev on this VPS: create the serve dir, add the Caddy
# block, then build + deploy. Re-run after a VPS wipe (the repo is the source of truth).
#
# DNS prerequisite (once, manual): A record foraging.condrea.dev → 165.227.33.13
# Caddy issues the TLS cert automatically once that record resolves.
#
# Idempotent.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVE_DIR="/srv/foraging"
CADDYFILE="/etc/caddy/Caddyfile"

echo "==> Creating serve dir $SERVE_DIR"
sudo mkdir -p "$SERVE_DIR"
sudo chown -R "$USER":"$USER" "$SERVE_DIR"
chmod 755 "$SERVE_DIR"

echo "==> Ensuring Caddy block for foraging.condrea.dev"
if ! grep -q "foraging.condrea.dev" "$CADDYFILE" 2>/dev/null; then
  sudo tee -a "$CADDYFILE" >/dev/null <<'EOF'

# Foraging site (static Astro build) — requires DNS A record
# foraging.condrea.dev → 165.227.33.13
foraging.condrea.dev {
    root * /srv/foraging
    encode gzip
    try_files {path} {path}/ =404
    file_server
}
EOF
  echo "   appended; reloading Caddy"
  sudo systemctl reload caddy
else
  echo "   already present; skipping"
fi

echo "==> Building + deploying"
bash "$REPO_DIR/scripts/deploy.sh"

echo
echo "Done. Once DNS resolves: https://foraging.condrea.dev/"
