#!/usr/bin/env bash
# Back up the human-authored content (plant markdown, map GeoJSON, photos) to the
# personal Storj "foraging" bucket. Git is the primary source of truth; this is an
# extra offsite copy of the irreplaceable bits (your notes + your photos).
#
# Credentials: reuses the Storj S3 keys already in ~/myclaw/.env (STORJ_ACCESS_KEY_ID /
# STORJ_SECRET_ACCESS_KEY). Override via a local .env or environment if you prefer.
#
# Uploads two things to bucket `foraging`:
#   backups/foraging-content-<UTC timestamp>.tar.gz   — full snapshot (versioned history)
#   assets/…                                           — a plain mirror of current photos + geojson
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Load creds: repo-local .env first, then fall back to myclaw/.env
[ -f "$REPO_DIR/.env" ] && { set -a; . "$REPO_DIR/.env"; set +a; }
if [ -z "${STORJ_ACCESS_KEY_ID:-}" ] && [ -f "$HOME/myclaw/.env" ]; then
  set -a; . "$HOME/myclaw/.env"; set +a
fi
: "${STORJ_ACCESS_KEY_ID:?missing STORJ_ACCESS_KEY_ID}"
: "${STORJ_SECRET_ACCESS_KEY:?missing STORJ_SECRET_ACCESS_KEY}"
export STORJ_ENDPOINT="${STORJ_ENDPOINT:-https://gateway.storjshare.io}"
export STORJ_BUCKET="${STORJ_BACKUP_BUCKET:-foraging}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
TARBALL="/tmp/foraging-content-${TS}.tar.gz"

echo "==> Snapshotting content → $TARBALL"
tar -czf "$TARBALL" -C "$REPO_DIR" \
  src/content \
  public/data/foraging-spots.geojson \
  public/photos \
  public/images

echo "==> Uploading to Storj bucket '$STORJ_BUCKET'"
REPO_DIR="$REPO_DIR" TARBALL="$TARBALL" TS="$TS" python3 - <<'PY'
import os, mimetypes, boto3
from botocore.config import Config

s3 = boto3.client(
    's3',
    endpoint_url=os.environ['STORJ_ENDPOINT'],
    aws_access_key_id=os.environ['STORJ_ACCESS_KEY_ID'],
    aws_secret_access_key=os.environ['STORJ_SECRET_ACCESS_KEY'],
    config=Config(signature_version='s3v4'),
)
bucket = os.environ['STORJ_BUCKET']
repo = os.environ['REPO_DIR']
tarball = os.environ['TARBALL']
ts = os.environ['TS']

# 1) versioned snapshot
key = f"backups/{os.path.basename(tarball)}"
s3.upload_file(tarball, bucket, key)
print("  uploaded", key)

# 2) plain mirror of the current photos + geojson (easy to browse/restore individually)
mirror = [
    ("public/data/foraging-spots.geojson", "assets/data/foraging-spots.geojson"),
]
for d in ("public/photos/spots", "public/images/plants"):
    ad = os.path.join(repo, d)
    if os.path.isdir(ad):
        for f in os.listdir(ad):
            mirror.append((f"{d}/{f}", f"assets/{d.split('public/')[1]}/{f}"))

for rel, key in mirror:
    p = os.path.join(repo, rel)
    if not os.path.isfile(p):
        continue
    ctype = mimetypes.guess_type(p)[0] or 'application/octet-stream'
    s3.upload_file(p, bucket, key, ExtraArgs={'ContentType': ctype})
print(f"  mirrored {len(mirror)} asset(s) → assets/")
print("done.")
PY

rm -f "$TARBALL"
echo "==> Backup complete (bucket: $STORJ_BUCKET, snapshot ts: $TS)"
