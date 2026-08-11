// Small live data API for the foraging map — the one dynamic surface on an
// otherwise static site. Reads pins from the SQLite data layer, and (behind a
// bearer token) lets pins be moved or added from the field without a rebuild.
//
// In prod, Caddy reverse-proxies /api/* here on the same origin (and /photos/* +
// /images/*, which this also serves from Storj). Run under the systemd user
// service (scripts/systemd/foraging-api.service).
//
//   Env:
//     FORAGING_EDIT_TOKEN     the ADMIN secret. Named contributors add/edit pins with
//                             just a name (no token); the token unlocks admin-only
//                             actions (move, delete, promote, history). If unset,
//                             admin actions are refused and the token can't be checked.
//     FORAGING_API_PORT       default 8787
//     FORAGING_DB             optional DB path override (see src/lib/db.mjs)
//     STORJ_ACCESS_KEY_ID / STORJ_SECRET_ACCESS_KEY / STORJ_ENDPOINT / STORJ_BACKUP_BUCKET
//                             Storj S3 creds for serving photos (media/*). If unset,
//                             image routes return 503 (pins still work).
import { createServer } from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { writeFile, readFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { allPins, pinsGeoJSON, updatePin, addPin, promotePin, deletePin, pinHistory, recentEvents } from '../src/lib/db.mjs';

const PORT = Number(process.env.FORAGING_API_PORT || 8787);
const TOKEN = process.env.FORAGING_EDIT_TOKEN || '';
// The unified type taxonomy (see db.mjs PIN_CATEGORIES).
const CATEGORIES = new Set(['fruit', 'nuts', 'greens', 'herbs', 'mushrooms', 'other']);

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

// Stored originals are capped at this long edge; new uploads (and the one-time
// scripts/optimize-media.mjs backfill) recompress to it. Full-res source is kept
// in Storj under media/originals/ so the downscale stays reversible.
const MAX_EDGE = 2048;
// On-the-fly derivatives, generated + cached on first request and keyed by ?v=.
// Small WebP thumbnails for the gallery grid / map-popup shots (shown ~180–480px)
// so a card doesn't pull the full image. WebP because every target browser takes it.
const VARIANTS = { thumb: { width: 480, quality: 72 }, card: { width: 800, quality: 78 } };

// Re-encode a buffer to an optimized image, preserving the format implied by `ext`
// (so the Storj key + its URL stay stable). Auto-orients from EXIF, strips metadata,
// caps the long edge at MAX_EDGE. Shared by the upload path and the backfill script.
async function optimizeImage(buf, ext) {
  const sharp = (await import('sharp')).default;
  let img = sharp(buf, { failOn: 'none' }).rotate();          // bake in EXIF orientation
  const meta = await img.metadata();
  if (Math.max(meta.width || 0, meta.height || 0) > MAX_EDGE) {
    img = img.resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true });
  }
  const e = String(ext).toLowerCase();
  if (e === 'png') return { buf: await img.png({ compressionLevel: 9, palette: true }).toBuffer(), ext: 'png', ct: 'image/png' };
  if (e === 'webp') return { buf: await img.webp({ quality: 80 }).toBuffer(), ext: 'webp', ct: 'image/webp' };
  return { buf: await img.jpeg({ quality: 80, mozjpeg: true }).toBuffer(), ext: 'jpg', ct: 'image/jpeg' };
}

// Fetch the base image bytes for `rel` from the local cache, falling back to Storj
// (warming the cache atomically). Returns { buf, ct } or { error: <status> }.
async function readBaseBytes(rel) {
  const cacheFile = join(MEDIA_CACHE, rel);
  if (existsSync(cacheFile)) return { buf: await readFile(cacheFile), ct: contentType(rel) };
  let r;
  try { r = await storj.fetch(`${STORJ_ENDPOINT}/${STORJ_BUCKET}/media/${rel}`); }
  catch (e) { console.error('media upstream error:', e); return { error: 502 }; }
  if (!r.ok) return { error: r.status === 404 ? 404 : 502 };
  const buf = Buffer.from(await r.arrayBuffer());
  try {                                          // cache atomically (temp + rename)
    mkdirSync(dirname(cacheFile), { recursive: true });
    const tmp = `${cacheFile}.tmp`;
    await writeFile(tmp, buf);
    await rename(tmp, cacheFile);
  } catch (e) { console.error('media cache write failed:', e); }
  return { buf, ct: r.headers.get('content-type') || contentType(rel) };
}

// Serve a cached WebP derivative (?v=thumb|card), rendering + caching it on first hit.
async function serveVariant(res, rel, name, spec) {
  const vFile = join(MEDIA_CACHE, '_variants', name, `${rel}.webp`);
  const headers = { 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=604800' };
  if (existsSync(vFile)) { res.writeHead(200, headers); createReadStream(vFile).pipe(res); return; }
  const base = await readBaseBytes(rel);
  if (base.error) { res.writeHead(base.error); res.end(base.error === 404 ? 'not found' : 'upstream error'); return; }
  let out;
  try {
    const sharp = (await import('sharp')).default;
    out = await sharp(base.buf, { failOn: 'none' }).rotate()
      .resize({ width: spec.width, withoutEnlargement: true })
      .webp({ quality: spec.quality }).toBuffer();
  } catch (e) { console.error('variant render failed:', e); res.writeHead(500); res.end('render error'); return; }
  try {
    mkdirSync(dirname(vFile), { recursive: true });
    const tmp = `${vFile}.tmp`;
    await writeFile(tmp, out);
    await rename(tmp, vFile);
  } catch (e) { console.error('variant cache write failed:', e); }
  res.writeHead(200, headers);
  res.end(out);
}

async function serveMedia(res, pathname, variant) {
  if (!storj) { res.writeHead(503); res.end('media not configured'); return; }
  const rel = pathname.slice(1);               // e.g. photos/spots/x.jpg
  if (variant && VARIANTS[variant]) return serveVariant(res, rel, variant, VARIANTS[variant]);
  // Full image: stream straight from the cache when warm, else fetch + cache.
  const cacheFile = join(MEDIA_CACHE, rel);
  const headers = { 'Content-Type': contentType(rel), 'Cache-Control': 'public, max-age=604800' };
  if (existsSync(cacheFile)) { res.writeHead(200, headers); createReadStream(cacheFile).pipe(res); return; }
  const base = await readBaseBytes(rel);
  if (base.error) { res.writeHead(base.error); res.end(base.error === 404 ? 'not found' : 'upstream error'); return; }
  res.writeHead(200, { ...headers, 'Content-Type': base.ct });
  res.end(base.buf);
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// True iff the request carries the valid admin (edit) token.
function isAdmin(req) {
  if (!TOKEN) return false;
  const m = (req.headers['authorization'] || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  // Constant-time compare (avoids a token-length/timing side-channel).
  const a = Buffer.from(m[1]), b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Resolve who is acting. A named contributor sends { actor: { id, name } }; an admin
// (valid token) may omit it and defaults to "Lucian". Returns { admin, actor } where
// actor is null when neither a name nor a valid token is present (⇒ reject the write).
// The name/id are self-asserted — the token is the only thing verified server-side.
function actorFrom(req, body) {
  const admin = isAdmin(req);
  const b = body && body.actor;
  if (b && typeof b.name === 'string' && b.name.trim()) {
    const id = typeof b.id === 'string' && b.id.trim() ? b.id.trim().slice(0, 64) : undefined;
    return { admin, actor: { id, name: b.name.trim().slice(0, 80) } };
  }
  if (admin) return { admin, actor: { name: 'Lucian' } };
  return { admin, actor: null };
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

// Collect a raw request body (image bytes) up to `cap`, rejecting if larger.
function readRawBody(req, cap) {
  return new Promise((resolve, reject) => {
    const chunks = []; let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > cap) { req.destroy(); reject(new Error('body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
// Accepted upload types → stored extension (must yield a SAFE_FILE basename).
// HEIC/HEIF (the iPhone default) is accepted and transcoded to JPEG on receipt so
// a contributor never has to convert in the field, and it renders everywhere.
const UPLOAD_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heic', 'image/heic-sequence': 'heic', 'image/heif-sequence': 'heic' };
const HEIC_CT = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const MAX_UPLOAD = 20 * 1024 * 1024;   // 20 MB — a full-res HEIC/phone photo

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
    if (req.method === 'GET' && MEDIA_PATH.test(path)) return serveMedia(res, path, url.searchParams.get('v'));

    // ── Public read ─────────────────────────────────────────────────────────
    // The live layer is the CONFIRMED spots; leads are served as a static export.
    if (req.method === 'GET' && (path === '/api/pins' || path === '/api/pins.geojson')) {
      return send(res, 200, pinsGeoJSON({ verified: true }));
    }
    if (req.method === 'GET' && path === '/api/health') {
      return send(res, 200, { ok: true, spots: allPins({ verified: true }).length, writable: !!TOKEN });
    }

    // ── Photo upload (name-gated) ─────────────────────────────────────────────
    // Store one image in Storj under media/photos/spots/ and return its generated
    // filename to reference in a pin's photos[]. Raw image bytes as the body (no
    // multipart); actor name via ?name= (or the admin token). Warms the local cache
    // so the new photo displays immediately. EXIF/geolocation is read client-side.
    if (req.method === 'POST' && path === '/api/photos') {
      const admin = isAdmin(req);
      const name = (url.searchParams.get('name') || '').trim();
      if (!admin && !name) return send(res, 401, { error: 'name required' });
      if (!storj) return send(res, 503, { error: 'media not configured' });
      const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      let ext = UPLOAD_EXT[ct];
      if (!ext) return send(res, 415, { error: 'image must be a jpeg, png, webp, or heic' });
      let buf;
      try { buf = await readRawBody(req, MAX_UPLOAD); }
      catch { return send(res, 413, { error: 'image too large (max 20MB)' }); }
      if (!buf.length) return send(res, 400, { error: 'empty body' });
      // Normalize every upload through sharp: auto-orient, cap resolution, strip EXIF,
      // recompress. HEIC/HEIF is transcoded to JPEG here too (sharp decodes it) so it
      // displays in every browser; other formats keep their type. Shrinks 3–7 MB phone
      // photos to a few hundred KB before they ever hit Storj.
      let outCt = ct;
      try {
        const opt = await optimizeImage(buf, HEIC_CT.has(ct) ? 'jpg' : ext);
        buf = opt.buf; ext = opt.ext; outCt = opt.ct;
      } catch (e) { console.error('image processing failed:', e); return send(res, 422, { error: 'could not process that photo' }); }
      const file = `spot-${randomUUID()}.${ext}`;
      const rel = `photos/spots/${file}`;
      let r;
      try {
        r = await storj.fetch(`${STORJ_ENDPOINT}/${STORJ_BUCKET}/media/${rel}`, {
          method: 'PUT', body: buf, headers: { 'Content-Type': outCt },
        });
      } catch (e) { console.error('photo upload error:', e); return send(res, 502, { error: 'upstream error' }); }
      if (!r.ok) { console.error('photo upload failed:', r.status); return send(res, 502, { error: 'upstream error' }); }
      try {                                          // warm the read-through cache
        const cacheFile = join(MEDIA_CACHE, rel);
        mkdirSync(dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, buf);
      } catch (e) { console.error('photo cache warm failed:', e); }
      return send(res, 201, { ok: true, file });
    }

    // ── Audit reads (admin-only) ──────────────────────────────────────────────
    // Full history of one pin, oldest → newest. Backend / agentic flow for now.
    const historyMatch = path.match(/^\/api\/pins\/(\d+)\/history$/);
    if (req.method === 'GET' && historyMatch) {
      if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
      return send(res, 200, { history: pinHistory(Number(historyMatch[1])) });
    }
    // Recent activity across all pins, newest → oldest.
    if (req.method === 'GET' && path === '/api/activity') {
      if (!isAdmin(req)) return send(res, 401, { error: 'unauthorized' });
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
      return send(res, 200, { events: recentEvents(limit) });
    }

    // ── Writes ────────────────────────────────────────────────────────────────
    // Named contributors add/edit with just a name; admin-only actions (move, delete,
    // promote) additionally require the edit token. Every write records an audit event.

    // Promote a lead → confirmed spot in place (flip verified=1). ADMIN-ONLY. Must
    // precede the bare /:id route so the longer path wins.
    const promoteMatch = path.match(/^\/api\/pins\/(\d+)\/promote$/);
    if (req.method === 'POST' && promoteMatch) {
      const body = await readBody(req);
      const { admin, actor } = actorFrom(req, body);
      if (!admin) return send(res, 401, { error: 'unauthorized' });
      if (body.category != null && !CATEGORIES.has(body.category)) {
        return send(res, 400, { error: 'category must be one of ' + [...CATEGORIES].join(', ') });
      }
      const spot = promotePin(Number(promoteMatch[1]), { category: body.category, plant: body.plant }, actor);
      if (!spot) return send(res, 404, { error: 'no such lead' });
      return send(res, 200, { ok: true, spot });
    }

    const idMatch = path.match(/^\/api\/pins\/(\d+)$/);
    // Edit a pin's fields and/or move it. Editing text is open to named contributors;
    // moving (lon/lat) is admin-only — a drag is destructive to curated placement.
    if (req.method === 'PATCH' && idMatch) {
      const id = Number(idMatch[1]);
      const body = await readBody(req);
      const { admin, actor } = actorFrom(req, body);
      if (!actor) return send(res, 401, { error: 'name required' });
      const moving = body.lon !== undefined || body.lat !== undefined;
      if (moving) {
        if (!admin) return send(res, 403, { error: 'moving a pin is admin-only' });
        if (!inLon(body.lon) || !inLat(body.lat)) return send(res, 400, { error: 'lon/lat must be valid coordinates' });
      }
      if (body.category != null && !CATEGORIES.has(body.category)) {
        return send(res, 400, { error: 'category must be one of ' + [...CATEGORIES].join(', ') });
      }
      const patch = {};
      for (const k of ['category', 'caution', 'species', 'season', 'location', 'notes', 'plant']) {
        if (body[k] !== undefined) patch[k] = body[k];
      }
      if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim();
      if (Array.isArray(body.photos)) patch.photos = cleanPhotos(body.photos);
      if (moving) { patch.lon = body.lon; patch.lat = body.lat; }
      const spot = updatePin(id, patch, actor);
      if (!spot) return send(res, 404, { error: 'no such pin' });
      return send(res, 200, { ok: true, spot });
    }

    // Delete a pin (confirmed or lead), removed outright. ADMIN-ONLY.
    if (req.method === 'DELETE' && idMatch) {
      const body = await readBody(req);
      const { admin, actor } = actorFrom(req, body);
      if (!admin) return send(res, 401, { error: 'unauthorized' });
      const ok = deletePin(Number(idMatch[1]), actor);
      if (!ok) return send(res, 404, { error: 'no such pin' });
      return send(res, 200, { ok: true });
    }

    // Add a spot. Open to named contributors (a name is required); lands as a
    // confirmed pin immediately. Admins may omit the actor (defaults to "Lucian").
    if (req.method === 'POST' && path === '/api/pins') {
      const body = await readBody(req);
      const { actor } = actorFrom(req, body);
      if (!actor) return send(res, 401, { error: 'name required' });
      if (!body.name || typeof body.name !== 'string') return send(res, 400, { error: 'name required' });
      if (!CATEGORIES.has(body.category)) return send(res, 400, { error: 'category must be one of ' + [...CATEGORIES].join(', ') });
      if (!inLon(body.lon) || !inLat(body.lat)) return send(res, 400, { error: 'lon/lat required and must be valid coordinates' });
      const spot = addPin({
        // caution is not a pin input — addPin derives it from the plant guide.
        name: body.name.trim(), category: body.category,
        species: body.species ?? null, season: body.season ?? null,
        location: body.location ?? null, notes: body.notes ?? null,
        added: new Date().toISOString().slice(0, 10),
        plant: body.plant ?? null, lon: body.lon, lat: body.lat,
        photos: cleanPhotos(body.photos),
        updated: new Date().toISOString().slice(0, 10),
      }, actor);
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
