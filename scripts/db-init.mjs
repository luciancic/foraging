// Prepare data/foraging.db from the committed db/seed.json. Run on every deploy.
//
//   Fresh DB (or --force): load both plants and spots from the seed.
//   Existing DB:           re-sync PLANTS only (content follows git); leave SPOTS
//                          untouched so live field edits are never clobbered.
//                          (Spots are still seeded here if the table is empty.)
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DB_PATH, loadSeed, replacePlants, replaceSpots, spotsEmpty, dumpSeed } from '../src/lib/db.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const seed = JSON.parse(readFileSync(join(root, 'db/seed.json'), 'utf-8'));
const fresh = !existsSync(DB_PATH);
const force = process.argv.includes('--force');

if (fresh || force) {
  loadSeed(seed);
  console.log(`${force ? 'Force-rebuilt' : 'Built'} ${DB_PATH} from seed.`);
} else {
  replacePlants(seed.plants);
  if (spotsEmpty()) replaceSpots(seed.spots); // first deploy after the table exists but is empty
  console.log(`Synced plants from seed into ${DB_PATH}; live spots left in place.`);
}

const { plants, spots } = dumpSeed();
console.log(`  now: ${plants.length} plants, ${spots.length} spots.`);
