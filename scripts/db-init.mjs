// Prepare data/foraging.db from the committed db/seed.json. Run on every deploy.
//
//   Fresh DB (or --force): load plants + confirmed spots from the seed.
//   Existing DB:           re-sync PLANTS only (content follows git); leave CONFIRMED
//                          spots untouched so live field edits are never clobbered.
//   Always:                backfill a 'genesis' event for any confirmed pin that has
//                          none, so the audit log has a baseline (idempotent).
//
// Scouting LEADS are a one-time populated dataset that lives in the DB (captured by
// the Storj DB backup) — there is NO deploy-time re-import. Recover them after a wipe
// by restoring data/foraging.db from the backup.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  DB_PATH, loadSeed, replacePlants, replaceConfirmed, confirmedEmpty, backfillGenesis,
  syncPinsToPlants, dumpSeed,
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

// Bind every resolvable pin to its plant guide (name/category/caution follow the
// plant). Idempotent — safe on every deploy; leaves the guideless ornamental tail
// untouched. Runs after plants are (re)synced so slugs exist to link against.
const linked = syncPinsToPlants();
if (linked) console.log(`Synced ${linked} pin(s) to their plant guide (name/category/caution).`);

const genesis = backfillGenesis();
if (genesis) console.log(`Backfilled ${genesis} genesis event(s) for confirmed pins with no history.`);

const { plants, spots } = dumpSeed();
console.log(`  now: ${plants.length} plants, ${spots.length} confirmed spots.`);
