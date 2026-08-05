// Shared SQLite data layer for the foraging site.
//
// One local database (data/foraging.db) is the runtime source of truth for both
// plant guides and map spots. It's mutable live state (edited from the field via
// the API), so it is NOT committed — db/seed.json is the git-tracked, human-
// readable snapshot that seeds a fresh VPS and gives git a diffable history.
//
// Written as .mjs so both the Astro build (plant pages, spot counts) and the
// plain-Node scripts/API can import the exact same accessors.
import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const DB_PATH = process.env.FORAGING_DB || join(repoRoot, 'data', 'foraging.db');

// Columns whose stored value is a JSON string; parsed on read, stringified on write.
const PLANT_JSON = ['commonNames', 'gallery', 'idCues', 'safety', 'guides'];
const SPOT_JSON = ['photos'];

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

CREATE TABLE IF NOT EXISTS spots (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  category TEXT NOT NULL,
  species  TEXT,
  season   TEXT,
  location TEXT,
  notes    TEXT,
  added    TEXT,
  plant    TEXT,
  lon      REAL NOT NULL,
  lat      REAL NOT NULL,
  photos   TEXT NOT NULL DEFAULT '[]',
  updated  TEXT
);
CREATE INDEX IF NOT EXISTS spots_plant ON spots(plant);
`;

let _db;
/** Open (and cache) the database connection, ensuring the schema exists. */
export function getDb() {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _db.exec(SCHEMA);
  return _db;
}

function decode(row, jsonCols) {
  if (!row) return row;
  const out = { ...row };
  for (const c of jsonCols) out[c] = JSON.parse(row[c] ?? '[]');
  return out;
}

// ── Plants ────────────────────────────────────────────────────────────────
export function allPlants() {
  return getDb()
    .prepare(`SELECT * FROM plants ORDER BY "order" ASC, title ASC`)
    .all()
    .map((r) => decode(r, PLANT_JSON));
}
export function getPlant(slug) {
  return decode(getDb().prepare(`SELECT * FROM plants WHERE slug = ?`).get(slug), PLANT_JSON);
}

// ── Spots ─────────────────────────────────────────────────────────────────
export function allSpots() {
  return getDb().prepare(`SELECT * FROM spots ORDER BY id ASC`).all().map((r) => decode(r, SPOT_JSON));
}

/** How many spots link to a plant slug (0 = not on the map) — the build-time join. */
export function spotCountFor(slug) {
  return getDb().prepare(`SELECT COUNT(*) n FROM spots WHERE plant = ?`).get(slug).n;
}

/** All spots as a GeoJSON FeatureCollection — the shape the map already consumes. */
export function spotsGeoJSON() {
  const features = allSpots().map((s) => ({
    type: 'Feature',
    id: s.id,
    geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
    properties: {
      name: s.name, category: s.category, species: s.species, season: s.season,
      location: s.location, notes: s.notes, added: s.added, plant: s.plant,
      photos: s.photos, updated: s.updated,
    },
  }));
  return { type: 'FeatureCollection', name: 'foraging-spots', features };
}

/** Move a pin. Returns the updated spot, or null if the id doesn't exist. */
export function moveSpot(id, lon, lat, when) {
  const info = getDb()
    .prepare(`UPDATE spots SET lon = ?, lat = ?, updated = ? WHERE id = ?`)
    .run(lon, lat, when ?? null, id);
  if (info.changes === 0) return null;
  return decode(getDb().prepare(`SELECT * FROM spots WHERE id = ?`).get(id), SPOT_JSON);
}

/** Insert a new spot; returns it with its assigned id. */
export function addSpot(s) {
  const info = getDb()
    .prepare(
      `INSERT INTO spots (name, category, species, season, location, notes, added, plant, lon, lat, photos, updated)
       VALUES (@name, @category, @species, @season, @location, @notes, @added, @plant, @lon, @lat, @photos, @updated)`,
    )
    .run({
      name: s.name, category: s.category, species: s.species ?? null, season: s.season ?? null,
      location: s.location ?? null, notes: s.notes ?? null, added: s.added ?? null,
      plant: s.plant ?? null, lon: s.lon, lat: s.lat,
      photos: JSON.stringify(s.photos ?? []), updated: s.updated ?? null,
    });
  return decode(getDb().prepare(`SELECT * FROM spots WHERE id = ?`).get(info.lastInsertRowid), SPOT_JSON);
}

// ── Seed (init / export) ────────────────────────────────────────────────────
// The two domains propagate differently. Plants are content: git (db/seed.json)
// is authoritative and every deploy re-syncs them into the DB. Spots are live
// state: the field-editing API owns them, so a re-seed must NOT clobber them —
// db-init only loads spots when the table is empty (fresh install).

/** Replace the plants table from a seed's plants[] (content follows git). */
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

/** Replace the spots table from a seed's spots[] (used only on a fresh/forced load). */
export function replaceSpots(spots) {
  const db = getDb();
  const ins = db.prepare(
    `INSERT INTO spots (id,name,category,species,season,location,notes,added,plant,lon,lat,photos,updated)
     VALUES (@id,@name,@category,@species,@season,@location,@notes,@added,@plant,@lon,@lat,@photos,@updated)`,
  );
  db.transaction(() => {
    db.exec(`DELETE FROM spots;`);
    for (const s of spots ?? []) {
      ins.run({
        id: s.id ?? null, name: s.name, category: s.category, species: s.species ?? null,
        season: s.season ?? null, location: s.location ?? null, notes: s.notes ?? null,
        added: s.added ?? null, plant: s.plant ?? null, lon: s.lon, lat: s.lat,
        photos: JSON.stringify(s.photos ?? []), updated: s.updated ?? null,
      });
    }
  })();
}

export function spotsEmpty() {
  return getDb().prepare(`SELECT COUNT(*) n FROM spots`).get().n === 0;
}

/** Full replace of both tables — the fresh-install / --force path. */
export function loadSeed(seed) {
  replacePlants(seed.plants);
  replaceSpots(seed.spots);
}

/** Dump the whole DB back to a plain seed object for db/seed.json. */
export function dumpSeed() {
  return { plants: allPlants(), spots: allSpots() };
}
