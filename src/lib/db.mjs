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
//   • verified=0 — scouting leads (iNaturalist / Falling Fruit / Ville de Montréal),
//     a ONE-TIME populated dataset. They live in the DB (captured by the Storj DB
//     backup) and are re-exported to pins-leads.geojson on each build; there is NO
//     deploy-time re-import. Promoting a lead just flips it to verified=1 in place.
//     Recover leads after a wipe by restoring data/foraging.db from the backup.
//
// Every human curation act on a pin (create / edit / move / delete / promote) is
// recorded in the append-only `pin_events` log with its actor, so who-changed-what
// is attributable and the state is reconstructable / reversible. Attribution is
// SELF-ASSERTED: a contributor's name rides along on each write; the edit token
// marks an ADMIN actor server-side but is not required to add or edit.
//
// Written as .mjs so both the Astro build (plant pages, counts) and the plain-Node
// scripts/API import the exact same accessors.
import Database from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// Anchor on the working directory, NOT import.meta.url — Astro's bundler relocates
// this module into dist/ at build time, so a URL-relative path would resolve wrong
// and silently open an empty DB. Every entry point runs with CWD = repo root; the
// FORAGING_DB env var overrides for anything that doesn't.
export const DB_PATH = process.env.FORAGING_DB || join(process.cwd(), 'data', 'foraging.db');

// Columns whose stored value is a JSON string; parsed on read, stringified on write.
// `category` is NOT here — plants store it as a JSON array but tolerate a legacy bare
// string, so it's normalized explicitly (normalizeCategories) rather than JSON.parsed.
const PLANT_JSON = ['commonNames', 'gallery', 'idCues', 'safety', 'guides'];
const PIN_JSON = ['photos', 'meta'];

// ── Category taxonomy ───────────────────────────────────────────────────────
// What a plant/pin is (which food part). A PLANT may carry SEVERAL categories —
// e.g. a maple gives both `sap` and (some) fruit — stored as an ordered JSON list
// where the first is primary (drives the map marker colour). A PIN stays a single
// string (a spot is one concrete harvest); guideless leads fall back to it, but a
// plant-linked pin takes its colour + type filters from the plant's list at render.
// Effort/safety lives in the note + the `caution` flag, not a second colour system.
export const PIN_CATEGORIES = ['fruit', 'nuts', 'greens', 'herbs', 'sap', 'mushrooms', 'other'];

/** Coerce a stored/seed category value (JSON array, bare string, or null) into a
 *  clean, de-duplicated array of known category slugs. Empty → ['other']. */
export function normalizeCategories(raw) {
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string') {
    const s = raw.trim();
    if (s.startsWith('[')) { try { list = JSON.parse(s); } catch { list = [s]; } }
    else if (s) list = [s];
  }
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const v = String(c || '').trim();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out.length ? out : ['other'];
}

// Canonical plant-slug → category, so a spot inherits its plant's type on migration
// and the seed stays consistent. (Trees are typed by their *product*, not habit.)
export const PLANT_TYPE = {
  mulberry: 'fruit', apple: 'fruit', crabapple: 'fruit', raspberry: 'fruit',
  aronia: 'fruit', serviceberry: 'fruit', 'black-currant': 'fruit', rowan: 'fruit',
  chokecherry: 'fruit', 'rose-hips': 'fruit', elderberry: 'fruit',
  'lambs-quarters': 'greens', purslane: 'greens', chicory: 'greens', linden: 'greens',
  'wood-sorrel': 'greens', 'broadleaf-plantain': 'greens',
  'staghorn-sumac': 'herbs',
  'sugar-maple': 'sap', birch: 'sap',
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
  id       INTEGER PRIMARY KEY AUTOINCREMENT,   -- AUTOINCREMENT: never reuse a deleted
                                                --   id, so pin_events history can't bleed
                                                --   from a removed pin into a new one.
  source   TEXT NOT NULL DEFAULT 'confirmed',   -- confirmed | inat | fallingfruit | montreal
  verified INTEGER NOT NULL DEFAULT 0,          -- 1 = confirmed spot, 0 = scouting lead
  ext_id   TEXT,                                -- external id (leads): dedup + delete tombstone key
  name     TEXT NOT NULL,
  category TEXT,                                -- fruit | nuts | greens | herbs | mushrooms | other
  caution  INTEGER NOT NULL DEFAULT 0,          -- 1 = has a dangerous lookalike / handle-with-care
  species  TEXT,
  season   TEXT,
  location TEXT,
  notes    TEXT,
  plant    TEXT,                                -- explicit plant link; validated in app
                                                --   code (promote/updatePin), not a hard
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

-- Contributors. Lightweight identity for a small, trusted group: a name typed on
-- entering edit mode, plus a client-generated id kept in localStorage so a device's
-- edits stay linked across renames. NOT authenticated — the name is self-asserted.
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,   -- client-generated uuid (from localStorage)
  name       TEXT NOT NULL,      -- self-asserted display name
  first_seen TEXT NOT NULL,
  last_seen  TEXT NOT NULL
);

-- Append-only audit log: one row per human curation act on a pin. before/after hold
-- full pin snapshots (JSON) so history renders and reverts without a diff library.
-- pin_id is deliberately NOT a hard FK — the log outlives the pins it records (a
-- 'delete' event keeps the removed pin in its "before" snapshot).
CREATE TABLE IF NOT EXISTS pin_events (
  id         INTEGER PRIMARY KEY,
  pin_id     INTEGER NOT NULL,
  type       TEXT NOT NULL,             -- genesis | create | edit | move | delete | promote
  user_id    TEXT,                      -- → users.id (null for admin/system/genesis)
  actor_name TEXT NOT NULL,             -- name SNAPSHOT at event time (survives renames)
  at         TEXT NOT NULL,             -- ISO timestamp
  before     TEXT,                      -- pin JSON before (null for create/genesis)
  after      TEXT,                      -- pin JSON after  (null for delete)
  source     TEXT NOT NULL DEFAULT 'field'  -- field | seed
);
CREATE INDEX IF NOT EXISTS pin_events_pin ON pin_events(pin_id);
CREATE INDEX IF NOT EXISTS pin_events_at ON pin_events(id);
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
  migratePinsAutoincrement(_db);
  // Deploy-time lead re-import (and its tombstones) is gone; drop the dead table.
  _db.exec(`DROP TABLE IF EXISTS deleted_leads;`);
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

// Rebuild an existing pins table (created before AUTOINCREMENT) so deleted ids are
// never reused — required for a clean per-pin audit trail. No-op on a fresh DB (the
// SCHEMA already declares AUTOINCREMENT) or once already migrated. Ids are preserved;
// re-inserting them advances sqlite_sequence so future auto-ids stay above the max.
function migratePinsAutoincrement(db) {
  const ddl = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='pins'`).get();
  if (!ddl || /AUTOINCREMENT/i.test(ddl.sql)) return;
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`CREATE TABLE pins_new (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      source   TEXT NOT NULL DEFAULT 'confirmed',
      verified INTEGER NOT NULL DEFAULT 0,
      ext_id   TEXT, name TEXT NOT NULL, category TEXT,
      caution  INTEGER NOT NULL DEFAULT 0, species TEXT, season TEXT,
      location TEXT, notes TEXT, plant TEXT,
      lon REAL NOT NULL, lat REAL NOT NULL,
      photos TEXT NOT NULL DEFAULT '[]', source_url TEXT,
      meta TEXT NOT NULL DEFAULT '{}', added TEXT, updated TEXT
    );`);
    db.exec(`INSERT INTO pins_new
      (id,source,verified,ext_id,name,category,caution,species,season,location,notes,plant,lon,lat,photos,source_url,meta,added,updated)
      SELECT id,source,verified,ext_id,name,category,caution,species,season,location,notes,plant,lon,lat,photos,source_url,meta,added,updated FROM pins;`);
    db.exec(`DROP TABLE pins;`);
    db.exec(`ALTER TABLE pins_new RENAME TO pins;`);
    db.exec(`CREATE INDEX IF NOT EXISTS pins_plant ON pins(plant);`);
    db.exec(`CREATE INDEX IF NOT EXISTS pins_verified ON pins(verified);`);
    db.exec(`CREATE INDEX IF NOT EXISTS pins_source_ext ON pins(source, ext_id);`);
  })();
  db.pragma('foreign_keys = ON');
  console.log('Migrated pins → AUTOINCREMENT ids (no reuse).');
}

function decode(row, jsonCols) {
  if (!row) return row;
  const out = { ...row };
  for (const c of jsonCols) out[c] = JSON.parse(row[c] ?? (c === 'meta' ? '{}' : '[]'));
  return out;
}

// A plant row → app shape: the JSON columns parsed AND `category` normalized to an
// ordered array (first = primary). Tolerates the legacy bare-string category still
// sitting in an un-migrated DB or seed.
function decodePlant(row) {
  if (!row) return row;
  const out = decode(row, PLANT_JSON);
  out.category = normalizeCategories(row.category);
  return out;
}

// ── Plants ──────────────────────────────────────────────────────────────────
export function allPlants() {
  return getDb().prepare(`SELECT * FROM plants ORDER BY "order" ASC, title ASC`).all()
    .map(decodePlant);
}
export function getPlant(slug) {
  return decodePlant(getDb().prepare(`SELECT * FROM plants WHERE slug = ?`).get(slug));
}

/** Compact per-plant metadata for the map to join onto pins client-side: display
 *  title, category list (colour + type filters), and the ripening window (so the
 *  map computes "ripe now" against the real current date, not the build date).
 *  Keyed by slug. Emitted to dist/data/plants.json at build. */
export function plantsMeta() {
  const out = {};
  for (const p of allPlants()) {
    out[p.slug] = {
      title: p.title,
      categories: p.category,
      status: p.status,
      ripeStart: p.ripeStart || null,
      ripeEnd: p.ripeEnd || null,
    };
  }
  return out;
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

// ── Events & users (append-only audit) ──────────────────────────────────────
// recordEvent runs INSIDE each mutator's transaction, so a pin change and its log
// entry commit atomically. `actor` is { id?, name } — id present ⇒ a named
// contributor (upserted into `users`); id absent ⇒ admin/system (name only).
const nowISO = () => new Date().toISOString();
const today = () => nowISO().slice(0, 10);

function upsertUserTx(db, actor) {
  if (!actor?.id || !actor?.name) return;
  db.prepare(
    `INSERT INTO users (id, name, first_seen, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
  ).run(actor.id, actor.name, nowISO(), nowISO());
}

function recordEvent(db, { pin_id, type, actor, before, after, source = 'field', at }) {
  db.prepare(
    `INSERT INTO pin_events (pin_id, type, user_id, actor_name, at, before, after, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    pin_id, type, actor?.id ?? null, actor?.name ?? 'system', at ?? nowISO(),
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    source,
  );
}

const getPin = (db, id) => decode(db.prepare(`SELECT * FROM pins WHERE id = ?`).get(id), PIN_JSON);

// Fields a pin edit may touch (coordinates handled separately as a 'move').
const EDITABLE = ['name', 'category', 'caution', 'species', 'season', 'location', 'notes', 'plant'];

/** Edit and/or move a pin. `patch` carries any subset of EDITABLE, `photos`, and/or
 *  `lon`+`lat`. Records a 'move' event when coordinates change, else 'edit'. Returns
 *  the updated pin, or null if the id doesn't exist. */
export function updatePin(id, patch = {}, actor) {
  const db = getDb();
  return db.transaction(() => {
    const before = getPin(db, id);
    if (!before) return null;
    const cols = [], vals = [];
    for (const k of EDITABLE) {
      if (patch[k] === undefined) continue;
      cols.push(`${k} = ?`);
      vals.push(k === 'caution' ? (patch[k] ? 1 : 0) : patch[k]);
    }
    if ('photos' in patch) { cols.push(`photos = ?`); vals.push(JSON.stringify(patch.photos ?? [])); }
    const moving = patch.lon !== undefined && patch.lat !== undefined;
    if (moving) { cols.push(`lon = ?`, `lat = ?`); vals.push(patch.lon, patch.lat); }
    if (!cols.length) return before;                       // nothing to change
    cols.push(`updated = ?`); vals.push(today());
    db.prepare(`UPDATE pins SET ${cols.join(', ')} WHERE id = ?`).run(...vals, id);
    const after = getPin(db, id);
    upsertUserTx(db, actor);
    recordEvent(db, { pin_id: id, type: moving ? 'move' : 'edit', actor, before, after });
    return after;
  })();
}

/** Insert a confirmed spot; returns it with its assigned id. */
export function addPin(s, actor) {
  const db = getDb();
  return db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO pins (source, verified, name, category, caution, species, season, location, notes, plant, lon, lat, photos, added, updated)
       VALUES ('confirmed', 1, @name, @category, @caution, @species, @season, @location, @notes, @plant, @lon, @lat, @photos, @added, @updated)`,
    ).run({
      // Caution is a property of the PLANT (a dangerous lookalike is the same for
      // every pin of that species), not a per-pin choice — derive it from the plant
      // link, mirroring syncPinsToPlants. Guideless finds carry no caution.
      name: s.name, category: s.category, caution: CAUTION_PLANTS.has(s.plant) ? 1 : 0,
      species: s.species ?? null, season: s.season ?? null, location: s.location ?? null,
      notes: s.notes ?? null, plant: s.plant ?? null, lon: s.lon, lat: s.lat,
      photos: JSON.stringify(s.photos ?? []), added: s.added ?? null, updated: s.updated ?? null,
    });
    const pin = getPin(db, info.lastInsertRowid);
    upsertUserTx(db, actor);
    recordEvent(db, { pin_id: pin.id, type: 'create', actor, before: null, after: pin });
    return pin;
  })();
}

/** Promote a lead to a confirmed spot in place (verified=1). Keeps the origin
 *  `source` + `ext_id` as provenance — `verified` is what marks it confirmed.
 *  Optionally override category/plant. Returns the pin, or null if it isn't a lead. */
export function promotePin(id, patch = {}, actor) {
  const db = getDb();
  return db.transaction(() => {
    const before = decode(db.prepare(`SELECT * FROM pins WHERE id = ? AND verified = 0`).get(id), PIN_JSON);
    if (!before) return null;
    const when = today();
    db.prepare(
      `UPDATE pins SET verified = 1, category = ?, plant = ?, updated = ?, added = COALESCE(added, ?) WHERE id = ?`,
    ).run(patch.category ?? before.category, patch.plant ?? before.plant, when, when, id);
    const after = getPin(db, id);
    upsertUserTx(db, actor);
    recordEvent(db, { pin_id: id, type: 'promote', actor, before, after });
    return after;
  })();
}

/** Delete a pin (confirmed or lead), removed outright. With the deploy-time lead
 *  re-import gone there is nothing to resurrect a deleted lead, so no tombstone is
 *  needed. Records a 'delete' event (the removed pin lives on in `before`). Returns
 *  true if a row was removed. */
export function deletePin(id, actor) {
  const db = getDb();
  return db.transaction(() => {
    const before = getPin(db, id);
    if (!before) return false;
    db.prepare(`DELETE FROM pins WHERE id = ?`).run(id);
    upsertUserTx(db, actor);
    recordEvent(db, { pin_id: id, type: 'delete', actor, before, after: null });
    return true;
  })();
}

// ── History (audit read) ────────────────────────────────────────────────────
function decodeEvent(e) {
  if (!e) return e;
  return { ...e, before: e.before ? JSON.parse(e.before) : null, after: e.after ? JSON.parse(e.after) : null };
}
/** Full event history for one pin, oldest → newest. */
export function pinHistory(id) {
  return getDb().prepare(`SELECT * FROM pin_events WHERE pin_id = ? ORDER BY id ASC`).all(id).map(decodeEvent);
}
/** Recent events across all pins, newest → oldest (activity feed). */
export function recentEvents(limit = 100) {
  return getDb().prepare(`SELECT * FROM pin_events ORDER BY id DESC LIMIT ?`).all(limit).map(decodeEvent);
}
/** Idempotent: give every confirmed pin with no events a synthetic 'genesis' event
 *  capturing its current state — the baseline the log grows from, timestamped at the
 *  pin's own `added` date. Safe to run every deploy; only touches pins with zero
 *  events, so a git-only reseed self-heals and a backup restore (real history intact)
 *  is left alone. Returns the count added. */
export function backfillGenesis() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT * FROM pins WHERE verified = 1 AND id NOT IN (SELECT DISTINCT pin_id FROM pin_events)`,
  ).all();
  db.transaction(() => {
    for (const r of rows) {
      const pin = decode(r, PIN_JSON);
      recordEvent(db, {
        pin_id: pin.id, type: 'genesis', actor: { name: 'Lucian' },
        before: null, after: pin, source: 'seed',
        at: pin.added ? `${pin.added}T00:00:00.000Z` : nowISO(),
      });
    }
  })();
  return rows.length;
}

// ── Pin → plant normalization ────────────────────────────────────────────────
// Every pin now belongs to a plant guide. Leads carry Latin binomials (often with a
// cultivar in quotes); confirmed pins carry mixed "common (Latin)" strings. Resolve
// a species string to a canonical plant slug: disambiguating common-name keywords
// first (Rubus splits into blackberry vs raspberry; currants; grape), then a Latin
// species override, then genus. Returns null for the guideless ornamental tail
// (honey locust, Callery pear, generic ornamental Prunus…), which stays species-only.
const GENUS_TO_SLUG = {
  malus: 'crabapple', amelanchier: 'serviceberry', tilia: 'linden', acer: 'sugar-maple',
  juglans: 'black-walnut', carya: 'hickory', quercus: 'oak', ginkgo: 'ginkgo', betula: 'birch',
  celtis: 'hackberry', corylus: 'hazelnut', fagus: 'beech', crataegus: 'hawthorn', sorbus: 'rowan',
  rhus: 'staghorn-sumac', sambucus: 'elderberry', morus: 'mulberry', vitis: 'grape', ribes: 'black-currant',
  rosa: 'rose-hips', aronia: 'aronia',
  asclepias: 'milkweed', trifolium: 'red-clover', daucus: 'wild-carrot', alliaria: 'garlic-mustard',
  urtica: 'nettle', arctium: 'burdock', achillea: 'yarrow', matricaria: 'pineappleweed',
  fragaria: 'wild-strawberry', viburnum: 'highbush-cranberry', artemisia: 'mugwort',
  allium: 'chives', cichorium: 'chicory', chenopodium: 'lambs-quarters', portulaca: 'purslane',
  plantago: 'broadleaf-plantain', oxalis: 'wood-sorrel',
};
const SPECIES_TO_SLUG = {
  'juglans cinerea': 'butternut', 'juglans ailantifolia': 'butternut',
  'prunus serotina': 'black-cherry', 'prunus virginiana': 'chokecherry',
  'malus domestica': 'apple', 'ribes rubrum': 'red-currant', 'ribes nigrum': 'black-currant',
};
export function slugForSpecies(species) {
  if (!species) return null;
  const s = species.toLowerCase();
  if (s.includes('blackberry')) return 'blackberry';
  if (s.includes('raspberry')) return 'raspberry';
  if (s.includes('red currant')) return 'red-currant';
  if (s.includes('black currant')) return 'black-currant';
  if (s.includes('grape')) return 'grape';
  // Prefer a Latin name inside parentheses ("wild rose (Rosa sp.)"), else the whole string.
  const paren = species.match(/\(([^)]+)\)/);
  const latin = paren ? paren[1] : species;
  const m = latin.match(/[A-Z][a-zà-ÿ]+(?:\s+[a-zà-ÿ]+)?/); // Genus [species]
  if (!m) return null;
  const [genus, sp] = m[0].toLowerCase().split(/\s+/);
  return SPECIES_TO_SLUG[sp ? `${genus} ${sp}` : genus] || GENUS_TO_SLUG[genus] || null;
}

// Plants whose pins should carry the amber caution ring — a dangerous lookalike or a
// real handle-with-care hazard (raw-toxic, cyanogenic pits, contact irritant, deadly
// umbellifer cousins). syncPinsToPlants OR-s this in; it never clears a set caution.
const CAUTION_PLANTS = new Set([
  'wild-carrot', 'grape', 'milkweed', 'chives', 'ginkgo',
  'elderberry', 'chokecherry', 'black-cherry', 'highbush-cranberry',
]);

/** Idempotent deploy-time normalization (runs after plants are synced): bind every
 *  resolvable pin to its plant guide and make the pin's own fields follow the plant —
 *  name = the plant's title (pins are no longer custom-named; the guide holds the
 *  species detail), category = the plant's PRIMARY category, caution OR-ed up for
 *  hazardous plants. An existing valid plant link is kept; otherwise it's derived
 *  from the species. Pins that don't resolve (the ornamental tail) are left untouched.
 *  Returns the number of pins changed. */
export function syncPinsToPlants() {
  const db = getDb();
  const plants = {};
  for (const r of db.prepare(`SELECT slug, title, category FROM plants`).all())
    plants[r.slug] = { title: r.title, primary: normalizeCategories(r.category)[0] };
  const pins = db.prepare(`SELECT id, plant, species, name, category, caution FROM pins`).all();
  const upd = db.prepare(`UPDATE pins SET plant = ?, name = ?, category = ?, caution = ? WHERE id = ?`);
  let changed = 0;
  db.transaction(() => {
    for (const p of pins) {
      const slug = p.plant && plants[p.plant] ? p.plant : slugForSpecies(p.species);
      if (!slug || !plants[slug]) continue;                    // guideless tail
      const name = plants[slug].title;
      const category = plants[slug].primary;
      const caution = (p.caution || CAUTION_PLANTS.has(slug)) ? 1 : 0;
      if (p.plant === slug && p.name === name && p.category === category && p.caution === caution) continue;
      upd.run(slug, name, category, caution, p.id);
      changed++;
    }
  })();
  return changed;
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
        commonNames: JSON.stringify(p.commonNames ?? []),
        category: JSON.stringify(normalizeCategories(p.category)),
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
