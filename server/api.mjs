// Small live data API for the foraging map — the one dynamic surface on an
// otherwise static site. Reads pins from the SQLite data layer, and (behind a
// bearer token) lets pins be moved or added from the field without a rebuild.
//
// In prod, Caddy reverse-proxies /api/* here on the same origin (and /photos/* +
// /images/*, which this also serves from Storj). Run under the systemd user
// service (scripts/systemd/foraging-api.service).
//
//   Env:
//     FORAGING_EDIT_TOKEN     required for writes; if unset, writes are refused (read-only).
//     FORAGING_API_PORT       default 8787
//     FORAGING_DB             optional DB path override (see src/lib/db.mjs)
//     STORJ_ACCESS_KEY_ID / STORJ_SECRET_ACCESS_KEY / STORJ_ENDPOINT / STORJ_BACKUP_BUCKET
//                             Storj S3 creds for serving photos (media/*). If unset,
//                             image routes return 503 (pins still work).
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { allSpots, spotsGeoJSON, moveSpot, addSpot } from '../src/lib/db.mjs';

const PORT = Number(process.env.FORAGING_API_PORT || 8787);
const TOKEN = process.env.FORAGING_EDIT_TOKEN || '';
const CATEGORIES = new Set(['tree', 'berries', 'greens', 'herbs', 'nuts', 'mushrooms', 'other']);

// ── Media (photos) served from Storj with an on-disk cache ──────────────────
// Photos live only in Storj (bucket prefix `media/`), not in git. This streams
// them at /photos/spots/* and /images/plants/*, caching each to media-cache/ on
// first hit so repeat views don't re-fetch. URL path maps 1:1 to media/<path>.
const STORJ_ENDPOINT = process.env.STORJ_ENDPOINT || 'https://gateway.storjshare.io';
const STORJ_BUCKET = process.env.STORJ_BACKUP_BUCKET || 'foraging';
const MEDIA_CACHE = join(process.cwd(), 'media-cache');
const MEDIA_PATH = /^\/(photos\/spots|images\/plants)\/[\w.-]+\.(jpe?g|png|webp)$/i;
const CT = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
const storj = process.env.STORJ_ACCESS_KEY_ID && process.env.STORJ_SECRET_ACCESS_KEY
  ? new AwsClient({
      accessKeyId: process.env.STORJ_ACCESS_KEY_ID,
      secretAccessKey: process.env.STORJ_SECRET_ACCESS_KEY,
      region: 'us-east-1', service: 's3',
    })
  : null;
mkdirSync(MEDIA_CACHE, { recursive: true });

const contentType = (p) => CT[p.split('.').pop().toLowerCase()] || 'application/octet-stream';

async function serveMedia(res, pathname) {
  if (!storj) { res.writeHead(503); res.end('media not configured'); return; }
  const rel = pathname.slice(1);               // e.g. photos/spots/x.jpg
  const cacheFile = join(MEDIA_CACHE, rel);
  const cacheHeaders = { 'Content-Type': contentType(rel), 'Cache-Control': 'public, max-age=604800' };
  if (existsSync(cacheFile)) {
    res.writeHead(200, cacheHeaders);
    createReadStream(cacheFile).pipe(res);
    return;
  }
  let r;
  try { r = await storj.fetch(`${STORJ_ENDPOINT}/${STORJ_BUCKET}/media/${rel}`); }
  catch (e) { console.error('media upstream error:', e); res.writeHead(502); res.end('upstream error'); return; }
  if (!r.ok) { res.writeHead(r.status === 404 ? 404 : 502); res.end(r.status === 404 ? 'not found' : 'upstream error'); return; }
  const buf = Buffer.from(await r.arrayBuffer());
  try {                                          // cache atomically (temp + rename)
    mkdirSync(dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.tmp`;
    await writeFile(tmp, buf);
    await rename(tmp, cacheFile);
  } catch (e) { console.error('media cache write failed:', e); }
  res.writeHead(200, { ...cacheHeaders, 'Content-Type': r.headers.get('content-type') || cacheHeaders['Content-Type'] });
  res.end(buf);
}
// Only these origins may make cross-origin (esp. write) calls. Same-origin prod
// requests through Caddy need no CORS at all; the dev server is the one exception.
const ALLOWED_ORIGINS = new Set(['https://foraging.condrea.dev', 'http://localhost:4321']);
const SAFE_FILE = /^[\w.-]+\.(jpe?g|png|webp)$/i;

// Reflect an allowlisted Origin rather than a wildcard; unknown origins get no
// ACAO header (same-origin still works, cross-origin JS is blocked).
function setCors(req, res) {
  const o = req.headers.origin;
  if (o && ALLOWED_ORIGINS.has(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function authed(req) {
  if (!TOKEN) return false;
  const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  // Constant-time compare (avoids a token-length/timing side-channel).
  const a = Buffer.from(m[1]), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) { req.destroy(); reject(new Error('body too large')); } // hard cap — stop buffering
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);
const inLat = (v) => isFiniteNum(v) && v >= -90 && v <= 90;
const inLon = (v) => isFiniteNum(v) && v >= -180 && v <= 180;
// Keep only safe image basenames — these get interpolated into the map popups.
const cleanPhotos = (arr) => (Array.isArray(arr) ? arr.filter((f) => typeof f === 'string' && SAFE_FILE.test(f)) : []);

const server = createServer(async (req, res) => {
  try {
    setCors(req, res);
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/$/, '') || '/';

    if (req.method === 'OPTIONS') return send(res, 204, {});

    // ── Photos (served from Storj) ───────────────────────────────────────────
    if (req.method === 'GET' && MEDIA_PATH.test(path)) return serveMedia(res, path);

    // ── Public read ─────────────────────────────────────────────────────────
    if (req.method === 'GET' && (path === '/api/pins' || path === '/api/pins.geojson')) {
      return send(res, 200, spotsGeoJSON());
    }
    if (req.method === 'GET' && path === '/api/health') {
      return send(res, 200, { ok: true, spots: allSpots().length, writable: !!TOKEN });
    }

    // ── Writes (token-gated) ──────────────────────────────────────────────────
    const moveMatch = path.match(/^\/api\/pins\/(\d+)$/);
    if (req.method === 'PATCH' && moveMatch) {
      if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
      const id = Number(moveMatch[1]);
      const body = await readBody(req);
      if (!inLon(body.lon) || !inLat(body.lat)) return send(res, 400, { error: 'lon/lat required and must be valid coordinates' });
      const spot = moveSpot(id, body.lon, body.lat, new Date().toISOString().slice(0, 10));
      if (!spot) return send(res, 404, { error: 'no such pin' });
      return send(res, 200, { ok: true, spot });
    }

    if (req.method === 'POST' && path === '/api/pins') {
      if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
      const body = await readBody(req);
      if (!body.name || typeof body.name !== 'string') return send(res, 400, { error: 'name required' });
      if (!CATEGORIES.has(body.category)) return send(res, 400, { error: 'category must be one of ' + [...CATEGORIES].join(', ') });
      if (!inLon(body.lon) || !inLat(body.lat)) return send(res, 400, { error: 'lon/lat required and must be valid coordinates' });
      const spot = addSpot({
        name: body.name.trim(), category: body.category,
        species: body.species ?? null, season: body.season ?? null,
        location: body.location ?? null, notes: body.notes ?? null,
        added: new Date().toISOString().slice(0, 10),
        plant: body.plant ?? null, lon: body.lon, lat: body.lat,
        photos: cleanPhotos(body.photos),
        updated: new Date().toISOString().slice(0, 10),
      });
      return send(res, 201, { ok: true, spot });
    }

    return send(res, 404, { error: 'not found' });
  } catch (err) {
    // Log details server-side; return a generic message so we don't leak internals.
    console.error('api error:', err);
    return send(res, 400, { error: 'bad request' });
  }
});

server.listen(PORT, () => {
  console.log(`foraging API on :${PORT} (writes ${TOKEN ? 'enabled' : 'DISABLED — set FORAGING_EDIT_TOKEN'})`);
});
