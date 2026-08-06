// Build-time reader for the unverified scouting-lead GeoJSON (iNaturalist, Falling
// Fruit, Ville de Montréal) that lives in public/data/. Unlike confirmed spots
// (SQLite, via spots.ts) these are static assets, so a plant page can show how
// many *leads* reference it alongside its confirmed count. Counts features whose
// properties.plant === slug across all three sources. Parsed once, memoised.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Anchor on the working directory, NOT import.meta.url — Astro's bundler relocates
// this module into dist/ at build time, so a URL-relative path would miss (same
// reasoning as db.mjs). The build always runs from the project root.
const DATA_DIR = join(process.cwd(), 'public', 'data');
const FILES = ['scouting-spots.geojson', 'falling-fruit.geojson', 'montreal-trees.geojson'];

let _counts = null;
function counts() {
  if (_counts) return _counts;
  const m = new Map();
  for (const f of FILES) {
    let geo;
    try { geo = JSON.parse(readFileSync(join(DATA_DIR, f), 'utf8')); }
    catch { continue; } // a missing/empty source just contributes nothing
    for (const feat of geo.features || []) {
      const slug = feat?.properties?.plant;
      if (slug) m.set(slug, (m.get(slug) || 0) + 1);
    }
  }
  _counts = m;
  return _counts;
}

/** How many unverified scouting leads (all sources) reference this plant slug. */
export function scoutCount(slug) {
  return counts().get(slug) || 0;
}
