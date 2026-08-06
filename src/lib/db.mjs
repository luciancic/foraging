// Shared SQLite data layer for the foraging site.
//
// One local database (data/foraging.db) is the runtime source of truth for plant
// guides and every map pin — confirmed spots AND unverified scouting leads now live
// in ONE `pins` table, distinguished by `source` + `verified`. It's mutable live
// state (edited from the field via the API), so it is NOT committed — db/seed.json
// is the git-tracked, human-readable snapshot that seeds a fresh VPS.
//
// Two lifecycles share the table, kept apart by `verified`:
//   • verified=1 — confirmed spots. Hand-curated, live-edited, the precious data.
//     These (and only these) are dumped to seed.json and restored on a fresh build.
//   • verified=0 — scouting leads (iNaturalist / Falling Fruit / Ville de Montréal).
//     Machine-generated, wholesale-replaced from the geojson on every deploy
//     (`importLeads`). A re-scout NEVER touches verified rows, and a promoted lead
//     (flipped to verified=1) survives the next regen.
//
// Written as .mjs so both the Astro build (plant pages, counts) and the plain-Node
// scripts/API import the exact same accessors.
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

// Anchor on the working directory, NOT import.meta.url — Astro's bundler relocates
// this module into dist/ at build time, so a URL-relative path would resolve wrong
// and silently open an empty DB. Every entry point runs with CWD = repo root; the
// FORAGING_DB env var overrides for anything that doesn't.
export const DB_PATH = process.env.FORAGING_DB || join(process.cwd(), 'data', 'foraging.db');

// Columns whose stored value is a JSON string; parsed on read, stringified on write.
const PLANT_JSON = ['commonNames', 'gallery', 'idCues', 'safety', 'guides'];
const PIN_JSON = ['photos', 'meta'];

// ── Category taxonomy ───────────────────────────────────────────────────────
// ONE axis for every pin: what it is / which food part (objective, browseable).
// Colour on the map keys off this. Effort/safety lives in the note + the `caution`
// flag (dangerous-lookalike), not in a second colour system.
export const PIN_CATEGORIES = ['fruit', 'nuts', 'greens', 'herbs', 'mushrooms', 'other'];

// Canonical plant-slug → category, so a spot inherits its plant's type on migration
// and the seed stays consistent. (Trees are typed by their *product*, not habit.)
export const PLANT_TYPE = {
  mulberry: 'fruit', apple: 'fruit', crabapple: 'fruit', raspberry: 'fruit',
  aronia: 'fruit', serviceberry: 'fruit', 'black-currant': 'fruit', rowan: 'fruit',
  chokecherry: 'fruit', 'rose-hips': 'fruit', elderberry: 'fruit',
  'lambs-quarters': 'greens', purslane: 'greens', chicory: 'greens', linden: 'greens',
  'wood-sorrel': 'greens', 'broadleaf-plantain': 'greens',
  'staghorn-sumac': 'herbs',
};
// Fallback when there's no plant link: map the legacy habit/part category onto a type.
const LEGACY_TO_TYPE = {
  berries: 'fruit', tree: 'fruit', greens: 'greens', herbs: 'herbs',
  nuts: 'nuts', mushrooms: 'mushrooms', fruit: 'fruit', other: 'other',
};
/** Best type for a pin given its (legacy) category and optional plant slug. */
export function pinType(category, plant) {
  return PLANT_TYPE[plant] || LEGACY_TO_TYPE[category] || category || 'other';
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS plants (
  slug           TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  scientificName TEXT,
  commonNames    TEXT NOT NULL DEFAULT '[]',
  category       TEXT NOT NULL,
  season         TEXT,
  status         TEXT NOT NULL DEFAULT 'year-round',
  ripeStart      TEXT,
  ripeEnd        TEXT,
  heroImage      TEXT,
  gallery        TEXT NOT NULL DEFAULT '[]',
  idCues         TEXT NOT NULL DEFAULT '[]',
  safety         TEXT NOT NULL DEFAULT '[]',
  guides         TEXT NOT NULL DEFAULT '[]',
  "order"        INTEGER NOT NULL DEFAULT 100,
  updated        TEXT,
  body           TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS pins (
  id       INTEGER PRIMARY KEY,
  source   TEXT NOT NULL DEFAULT 'confirmed',   -- confirmed | inat | fallingfruit | montreal
  verified INTEGER NOT NULL DEFAULT 0,          -- 1 = confirmed spot, 0 = scouting lead
  ext_id   TEXT,                                -- external id (leads): dedup + client hide key
  name     TEXT NOT NULL,
  category TEXT,                                -- fruit | nuts | greens | herbs | mushrooms | other
  caution  INTEGER NOT NULL DEFAULT 0,          -- 1 = has a dangerous lookalike / handle-with-care
  species  TEXT,
  season   TEXT,
  location TEXT,
  notes    TEXT,
  plant    TEXT,                                -- explicit plant link; validated in app
                                                --   code (importLeads/promote), not a hard
                                                --   FK — plants are wholesale re-synced each
                                                --   deploy, which a live FK would deadlock.
  lon      REAL NOT NULL,
  lat      REAL NOT NULL,
  photos   TEXT NOT NULL DEFAULT '[]',
  source_url TEXT,                              -- provenance link (iNat obs / FF loc / dataset)
  meta     TEXT NOT NULL DEFAULT '{}',          -- source-specific display bits (observer, where…)
  added    TEXT,
  updated  TEXT
);
CREATE INDEX IF NOT EXISTS pins_plant ON pins(plant);
CREATE INDEX IF NOT EXISTS pins_verified ON pins(verified);
CREATE INDEX IF NOT EXISTS pins_source_ext ON pins(source, ext_id);
`;

let _db;
/** Open (and cache) the connection, ensuring the schema exists + migrating. */
export function getDb() {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.pragma('busy_timeout = 5000');
  _db.exec(SCHEMA);
  migrateSpotsToPins(_db);
  return _db;
}

// One-time migration: the legacy `spots` table (confirmed-only) → the unified `pins`
// table. Copies every spot as a verified confirmed pin, retyping its category, then
// drops `spots`. Idempotent: only runs while the old table still exists.
function migrateSpotsToPins(db) {
  const hasSpots = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='spots'`)
    .get();
  if (!hasSpots) return;
  const rows = db.prepare(`SELECT * FROM spots`).all();
  const ins = db.prepare(
    `INSERT INTO pins (id, source, verified, name, category, species, season, location, notes, plant, lon, lat, photos, added, updated)
     VALUES (@id, 'confirmed', 1, @name, @category, @species, @season, @location, @notes, @plant, @lon, @lat, @photos, @added, @updated)`,
  );
  db.transaction(() => {
    for (const s of rows) {
      ins.run({
        id: s.id, name: s.name, category: pinType(s.category, s.plant),
        species: s.species ?? null, season: s.season ?? null, location: s.location ?? null,
        notes: s.notes ?? null, plant: s.plant ?? null, lon: s.lon, lat: s.lat,
        photos: s.photos ?? '[]', added: s.added ?? null, updated: s.updated ?? null,
      });
    }
    db.exec(`DROP TABLE spots;`);
  })();
  console.log(`Migrated ${rows.length} spots → pins (verified confirmed).`);
}

function decode(row, jsonCols) {
  if (!row) return row;
  const out = { ...row };
  for (const c of jsonCols) out[c] = JSON.parse(row[c] ?? (c === 'meta' ? '{}' : '[]'));
  return out;
}

// ── Plants ──────────────────────────────────────────────────────────────────
export function allPlants() {
  return getDb().prepare(`SELECT * FROM plants ORDER BY "order" ASC, title ASC`).all()
    .map((r) => decode(r, PLANT_JSON));
}
export function getPlant(slug) {
  return decode(getDb().prepare(`SELECT * FROM plants WHERE slug = ?`).get(slug), PLANT_JSON);
}

// ── Pins ──────────────────────────────────────────────────────────────────
/** All pins (confirmed + leads). Pass {verified:true} for confirmed only. */
export function allPins({ verified } = {}) {
  const where = verified === true ? `WHERE verified = 1` : verified === false ? `WHERE verified = 0` : ``;
  return getDb().prepare(`SELECT * FROM pins ${where} ORDER BY id ASC`).all().map((r) => decode(r, PIN_JSON));
}

/** Confirmed spots + leads linked to a plant slug — the explicit build-time join
 *  that replaces the old GeoJSON keyword scan. */
export function pinCountsFor(slug) {
  const row = getDb().prepare(
    `SELECT SUM(verified = 1) confirmed, SUM(verified = 0) leads FROM pins WHERE plant = ?`,
  ).get(slug);
  return { confirmed: row.confirmed || 0, leads: row.leads || 0 };
}

/** A pin row → GeoJSON Feature (the shape the map consumes). */
function toFeature(p) {
  return {
    type: 'Feature',
    id: p.id,
    geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    properties: {
      source: p.source, verified: !!p.verified, ext_id: p.ext_id, name: p.name,
      category: p.category, caution: !!p.caution, species: p.species, season: p.season,
      location: p.location, notes: p.notes, plant: p.plant, photos: p.photos,
      sourceUrl: p.source_url, added: p.added, updated: p.updated, ...p.meta,
    },
  };
}

/** Pins as a GeoJSON FeatureCollection. {verified:true} = confirmed only. */
export function pinsGeoJSON(opts = {}) {
  return { type: 'FeatureCollection', name: 'foraging-pins', features: allPins(opts).map(toFeature) };
}

/** Move a pin. Returns the updated pin, or null if the id doesn't exist. */
export function movePin(id, lon, lat, when) {
  const info = getDb().prepare(`UPDATE pins SET lon = ?, lat = ?, updated = ? WHERE id = ?`)
    .run(lon, lat, when ?? null, id);
  if (info.changes === 0) return null;
  return decode(getDb().prepare(`SELECT * FROM pins WHERE id = ?`).get(id), PIN_JSON);
}

/** Insert a confirmed spot; returns it with its assigned id. */
export function addPin(s) {
  const info = getDb().prepare(
    `INSERT INTO pins (source, verified, name, category, caution, species, season, location, notes, plant, lon, lat, photos, added, updated)
     VALUES ('confirmed', 1, @name, @category, @caution, @species, @season, @location, @notes, @plant, @lon, @lat, @photos, @added, @updated)`,
  ).run({
    name: s.name, category: s.category, caution: s.caution ? 1 : 0,
    species: s.species ?? null, season: s.season ?? null, location: s.location ?? null,
    notes: s.notes ?? null, plant: s.plant ?? null, lon: s.lon, lat: s.lat,
    photos: JSON.stringify(s.photos ?? []), added: s.added ?? null, updated: s.updated ?? null,
  });
  return decode(getDb().prepare(`SELECT * FROM pins WHERE id = ?`).get(info.lastInsertRowid), PIN_JSON);
}

/** Promote a lead to a confirmed spot in place (verified=1). Keeps the origin
 *  `source` + `ext_id` as provenance — `verified` is what marks it confirmed — so
 *  a later re-scout dedups against it and won't resurrect a duplicate lead.
 *  Optionally override category/plant. Returns the pin, or null if it isn't a lead. */
export function promotePin(id, patch = {}) {
  const p = getDb().prepare(`SELECT * FROM pins WHERE id = ? AND verified = 0`).get(id);
  if (!p) return null;
  const when = new Date().toISOString().slice(0, 10);
  getDb().prepare(
    `UPDATE pins SET verified = 1, category = ?, plant = ?, updated = ?, added = COALESCE(added, ?) WHERE id = ?`,
  ).run(patch.category ?? p.category, patch.plant ?? p.plant, when, when, id);
  return decode(getDb().prepare(`SELECT * FROM pins WHERE id = ?`).get(id), PIN_JSON);
}

// ── Lead import (deploy-time regen) ─────────────────────────────────────────
// Replace ALL unverified leads with a fresh batch parsed from the scout geojson.
// Scoped to verified=0 so confirmed spots are never touched; skips any lead whose
// (source, ext_id) was already promoted to a confirmed pin, so a promotion sticks.
export function importLeads(features) {
  const db = getDb();
  const promoted = new Set(
    db.prepare(`SELECT source || char(0) || ext_id k FROM pins WHERE verified = 1 AND ext_id IS NOT NULL`)
      .all().map((r) => r.k),
  );
  const validPlant = new Set(db.prepare(`SELECT slug FROM plants`).all().map((r) => r.slug));
  const ins = db.prepare(
    `INSERT INTO pins (source, verified, ext_id, name, category, caution, species, season, location, notes, plant, lon, lat, source_url, meta, added)
     VALUES (@source, 0, @ext_id, @name, @category, @caution, @species, @season, @location, @notes, @plant, @lon, @lat, @source_url, @meta, @added)`,
  );
  let inserted = 0, skipped = 0, unlinked = 0;
  db.transaction(() => {
    db.exec(`DELETE FROM pins WHERE verified = 0;`);
    for (const f of features) {
      const p = f.properties || {};
      const source = p.source || 'inat';
      const ext_id = f.id != null ? String(f.id) : null;
      if (ext_id && promoted.has(source + '\0' + ext_id)) { skipped++; continue; }
      // A plant link must reference a real guide, else drop it (no dangling FKs).
      let plant = p.plant || null;
      if (plant && !validPlant.has(plant)) { plant = null; unlinked++; }
      const [lon, lat] = f.geometry.coordinates;
      ins.run({
        source, ext_id, name: p.name ?? 'Lead', category: p.category ?? 'other',
        caution: p.caution ? 1 : 0, species: p.species ?? null, season: p.season ?? null,
        location: p.location ?? null, notes: p.notes ?? null, plant,
        lon, lat, source_url: p.sourceUrl ?? p.ff ?? p.inat ?? p.mtl ?? null,
        meta: JSON.stringify(p.meta ?? {}), added: p.added ?? null,
      });
      inserted++;
    }
  })();
  return { inserted, skipped, unlinked };
}

// ── Seed (init / export) ────────────────────────────────────────────────────
// Only CONFIRMED pins round-trip through git (seed.json) — leads are regenerated,
// never committed. Plants are content: git is authoritative, re-synced every deploy.

export function replacePlants(plants) {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO plants (slug,title,scientificName,commonNames,category,season,status,ripeStart,ripeEnd,heroImage,gallery,idCues,safety,guides,"order",updated,body)
     VALUES (@slug,@title,@scientificName,@commonNames,@category,@season,@status,@ripeStart,@ripeEnd,@heroImage,@gallery,@idCues,@safety,@guides,@order,@updated,@body)`,
  );
  db.transaction(() => {
    db.exec(`DELETE FROM plants;`);
    for (const p of plants ?? []) {
      ins.run({
        slug: p.slug, title: p.title, scientificName: p.scientificName ?? null,
        commonNames: JSON.stringify(p.commonNames ?? []), category: p.category,
        season: p.season ?? null, status: p.status ?? 'year-round',
        ripeStart: p.ripeStart ?? null, ripeEnd: p.ripeEnd ?? null, heroImage: p.heroImage ?? null,
        gallery: JSON.stringify(p.gallery ?? []), idCues: JSON.stringify(p.idCues ?? []),
        safety: JSON.stringify(p.safety ?? []), guides: JSON.stringify(p.guides ?? []),
        order: p.order ?? 100, updated: p.updated ?? null, body: p.body ?? '',
      });
    }
  })();
}

/** Replace the CONFIRMED pins from a seed's spots[] (fresh/forced load only). */
export function replaceConfirmed(spots) {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO pins (id, source, verified, name, category, caution, species, season, location, notes, plant, lon, lat, photos, added, updated)
     VALUES (@id, 'confirmed', 1, @name, @category, @caution, @species, @season, @location, @notes, @plant, @lon, @lat, @photos, @added, @updated)`,
  );
  db.transaction(() => {
    db.exec(`DELETE FROM pins WHERE verified = 1;`);
    for (const s of spots ?? []) {
      ins.run({
        id: s.id ?? null, name: s.name, category: s.category ?? pinType(s.category, s.plant),
        caution: s.caution ? 1 : 0, species: s.species ?? null, season: s.season ?? null,
        location: s.location ?? null, notes: s.notes ?? null, plant: s.plant ?? null,
        lon: s.lon, lat: s.lat, photos: JSON.stringify(s.photos ?? []),
        added: s.added ?? null, updated: s.updated ?? null,
      });
    }
  })();
}

export function confirmedEmpty() {
  return getDb().prepare(`SELECT COUNT(*) n FROM pins WHERE verified = 1`).get().n === 0;
}

/** Full replace of plants + confirmed pins — the fresh-install / --force path. */
export function loadSeed(seed) {
  replacePlants(seed.plants);
  replaceConfirmed(seed.spots);
}

/** Dump plants + CONFIRMED pins to a plain seed object for db/seed.json. Leads are
 *  excluded on purpose — they're regenerated, never committed. */
export function dumpSeed() {
  const spots = allPins({ verified: true }).map((p) => ({
    id: p.id, name: p.name, category: p.category, caution: p.caution || undefined,
    species: p.species, season: p.season, location: p.location, notes: p.notes,
    added: p.added, plant: p.plant, lon: p.lon, lat: p.lat, photos: p.photos, updated: p.updated,
  }));
  return { plants: allPlants(), spots };
}
