// One-time (re-runnable) media optimizer for the Storj `media/` prefix.
//
// The site's photos were uploaded straight from phones — 3–7 MB each — and served
// full-resolution. This walks every object under media/photos/spots/ and
// media/images/plants/, and for each one:
//   1. copies the untouched original to media/originals/<rel> (so the downscale is
//      reversible — the full-res source is never lost),
//   2. re-encodes it with sharp: auto-orient from EXIF, strip metadata, cap the long
//      edge at 2048px, recompress (JPEG q80 mozjpeg / WebP q80 / PNG level 9) —
//      keeping the SAME key + extension so every existing URL stays valid,
//   3. writes the smaller version back to media/<rel> and drops the local
//      media-cache/ copy (base + derivatives) so the next request re-fetches.
//
// Idempotent: an object that already has a media/originals/<rel> copy is skipped, and
// a re-encode that isn't actually smaller is left untouched. New uploads are optimized
// inline by server/api.mjs, so this is only for the pre-existing backlog.
//
// Creds: repo-local .env first, then ~/myclaw/.env (same as backup-storj.sh).
// Usage:  node scripts/optimize-media.mjs [--dry]

import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { AwsClient } from 'aws4fetch';
import sharp from 'sharp';

// ── Config / creds ──────────────────────────────────────────────────────────
const DRY = process.argv.includes('--dry');
const MAX_EDGE = 2048;
const PREFIXES = ['media/photos/spots/', 'media/images/plants/'];
const MEDIA_CACHE = join(process.cwd(), 'media-cache');

async function loadEnv() {
  for (const f of [join(process.cwd(), '.env'), join(process.env.HOME || '', 'myclaw/.env')]) {
    if (process.env.STORJ_ACCESS_KEY_ID) break;
    if (!existsSync(f)) continue;
    for (const line of (await readFile(f, 'utf8')).split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}
await loadEnv();

const ENDPOINT = process.env.STORJ_ENDPOINT || 'https://gateway.storjshare.io';
const BUCKET = process.env.STORJ_BACKUP_BUCKET || 'foraging';
if (!process.env.STORJ_ACCESS_KEY_ID || !process.env.STORJ_SECRET_ACCESS_KEY) {
  console.error('missing STORJ_ACCESS_KEY_ID / STORJ_SECRET_ACCESS_KEY'); process.exit(1);
}
const s3 = new AwsClient({
  accessKeyId: process.env.STORJ_ACCESS_KEY_ID,
  secretAccessKey: process.env.STORJ_SECRET_ACCESS_KEY,
  region: 'us-east-1', service: 's3',
});
const url = (key) => `${ENDPOINT}/${BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`;

// ── S3 helpers ──────────────────────────────────────────────────────────────
async function listKeys(prefix) {
  const keys = [];
  let token;
  do {
    const q = new URLSearchParams({ 'list-type': '2', prefix });
    if (token) q.set('continuation-token', token);
    const r = await s3.fetch(`${ENDPOINT}/${BUCKET}?${q}`);
    if (!r.ok) throw new Error(`list ${prefix} → ${r.status}`);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(decodeXml(m[1]));
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] : null;
  } while (token);
  return keys;
}
const decodeXml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

async function exists(key) { const r = await s3.fetch(url(key), { method: 'HEAD' }); return r.ok; }
async function get(key) { const r = await s3.fetch(url(key)); if (!r.ok) throw new Error(`get ${key} → ${r.status}`); return Buffer.from(await r.arrayBuffer()); }
async function put(key, buf, ct) { const r = await s3.fetch(url(key), { method: 'PUT', body: buf, headers: { 'Content-Type': ct } }); if (!r.ok) throw new Error(`put ${key} → ${r.status}`); }

const CT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// ── Re-encode, preserving the format implied by the key's extension ───────────
async function optimize(buf, ext) {
  let img = sharp(buf, { failOn: 'none' }).rotate();
  const meta = await img.metadata();
  if (Math.max(meta.width || 0, meta.height || 0) > MAX_EDGE) {
    img = img.resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
  }
  const e = ext.toLowerCase();
  if (e === 'png') return img.png({ compressionLevel: 9, palette: true }).toBuffer();
  if (e === 'webp') return img.webp({ quality: 80 }).toBuffer();
  return img.jpeg({ quality: 80, mozjpeg: true }).toBuffer();
}

// Drop the local read-through cache (base + any ?v= derivatives) for a rel path.
async function bustCache(rel) {
  await rm(join(MEDIA_CACHE, rel), { force: true }).catch(() => {});
  for (const v of ['thumb', 'card']) await rm(join(MEDIA_CACHE, '_variants', v, `${rel}.webp`), { force: true }).catch(() => {});
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

// ── Run ─────────────────────────────────────────────────────────────────────
let totalOld = 0, totalNew = 0, processed = 0, skipped = 0;
for (const prefix of PREFIXES) {
  const keys = await listKeys(prefix);
  for (const key of keys) {
    const rel = key.slice('media/'.length);          // photos/spots/x.jpg
    const ext = key.split('.').pop().toLowerCase();
    if (!CT[ext]) { console.log(`skip  ${rel} (unsupported .${ext})`); skipped++; continue; }
    const orig = `media/originals/${rel}`;
    if (await exists(orig)) { console.log(`skip  ${rel} (already optimized)`); skipped++; continue; }

    const buf = await get(key);
    let out;
    try { out = await optimize(buf, ext); }
    catch (e) { console.log(`skip  ${rel} (decode failed: ${e.message})`); skipped++; continue; }
    if (out.length >= buf.length) { console.log(`keep  ${rel} (${kb(buf.length)}, already lean)`); skipped++; continue; }

    console.log(`${DRY ? 'DRY   ' : 'optim '}${rel}  ${kb(buf.length)} → ${kb(out.length)}  (-${(100 * (1 - out.length / buf.length)).toFixed(0)}%)`);
    totalOld += buf.length; totalNew += out.length; processed++;
    if (DRY) continue;
    await put(orig, buf, CT[ext]);                   // preserve full-res original first
    await put(key, out, CT[ext]);                    // then overwrite with the optimized one
    await bustCache(rel);
  }
}
console.log(`\n${DRY ? '[dry run] ' : ''}${processed} optimized, ${skipped} skipped.`);
if (processed) console.log(`total ${kb(totalOld)} → ${kb(totalNew)}  (saved ${kb(totalOld - totalNew)}, -${(100 * (1 - totalNew / totalOld)).toFixed(0)}%)`);
