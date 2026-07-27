import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Reads the map's source-of-truth GeoJSON at build time so plant pages can
// tell whether (and how many) logged spots link back to them. The join key is
// the plant slug, stored on each feature's `properties.plant`.
const geojsonUrl = new URL('../../public/data/foraging-spots.geojson', import.meta.url);

type Feature = { properties?: { plant?: string } };

function loadFeatures(): Feature[] {
  try {
    const raw = readFileSync(fileURLToPath(geojsonUrl), 'utf-8');
    return JSON.parse(raw).features ?? [];
  } catch {
    return [];
  }
}

const counts: Map<string, number> = (() => {
  const m = new Map<string, number>();
  for (const f of loadFeatures()) {
    const slug = f.properties?.plant;
    if (slug) m.set(slug, (m.get(slug) ?? 0) + 1);
  }
  return m;
})();

/** How many logged map spots link to this plant slug (0 = not on the map). */
export function spotCount(slug: string): number {
  return counts.get(slug) ?? 0;
}
