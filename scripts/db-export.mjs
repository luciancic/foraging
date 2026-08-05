// Dump the live data/foraging.db back to db/seed.json — refreshes the committed,
// human-readable snapshot so git keeps a diffable history and a fresh VPS can
// re-seed. Run this after content changes (or on a schedule) so field edits made
// against the live DB eventually land in git.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { dumpSeed } from '../src/lib/db.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const outPath = join(root, 'db/seed.json');

const seed = dumpSeed();
writeFileSync(outPath, JSON.stringify(seed, null, 2) + '\n');
console.log(`Exported ${outPath}: ${seed.plants.length} plants, ${seed.spots.length} spots.`);
