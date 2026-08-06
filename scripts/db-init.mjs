// Prepare data/foraging.db from the committed db/seed.json + the scouting geojson.
// Run on every deploy.
//
//   Fresh DB (or --force): load plants + confirmed spots from the seed.
//   Existing DB:           re-sync PLANTS only (content follows git); leave CONFIRMED
//                          spots untouched so live field edits are never clobbered.
//   Always:                re-import the scouting LEADS from public/data/*.geojson
//                          (wholesale-replaces verified=0 rows; confirmed spots and
//                          already-promoted leads are never touched).
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  DB_PATH, loadSeed, replacePlants, replaceConfirmed, confirmedEmpty, importLeads, dumpSeed,
} from '../src/lib/db.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const seed = JSON.parse(readFileSync(join(root, 'db/seed.json'), 'utf-8'));
const fresh = !existsSync(DB_PATH);
const force = process.argv.includes('--force');

if (fresh || force) {
  loadSeed(seed);
  console.log(`${force ? 'Force-rebuilt' : 'Built'} ${DB_PATH} from seed.`);
} else {
  replacePlants(seed.plants);
  if (confirmedEmpty()) replaceConfirmed(seed.spots); // first deploy after table exists but empty
  console.log(`Synced plants from seed into ${DB_PATH}; live confirmed spots left in place.`);
}

// Import unverified scouting leads from the generated geojson (never committed).
const LEAD_FILES = ['scouting-spots.geojson', 'falling-fruit.geojson', 'montreal-trees.geojson'];
const features = [];
for (const f of LEAD_FILES) {
  const p = join(root, 'public', 'data', f);
  if (!existsSync(p)) continue;
  try { features.push(...(JSON.parse(readFileSync(p, 'utf-8')).features || [])); }
  catch (e) { console.warn(`  skipped ${f}: ${e.message}`); }
}
const r = importLeads(features);
console.log(`Imported leads: ${r.inserted} inserted, ${r.skipped} kept-as-promoted, ${r.unlinked} plant-link dropped.`);

const { plants, spots } = dumpSeed();
console.log(`  now: ${plants.length} plants, ${spots.length} confirmed spots, ${r.inserted} leads.`);
