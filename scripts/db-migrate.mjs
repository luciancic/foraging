// One-time migration: the legacy file-based data (plant Markdown + the map
// GeoJSON) → db/seed.json, the committed snapshot the DB is built from.
//
// Idempotent: re-running regenerates seed.json from the legacy files. After the
// DB becomes the live source of truth, db-export.mjs (DB → seed.json) is the one
// to use instead; this script is only for the original cutover / a re-derive.
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import matter from 'gray-matter';

const root = fileURLToPath(new URL('..', import.meta.url));
const plantsDir = join(root, 'src/content/plants');
const geojsonPath = join(root, 'public/data/foraging-spots.geojson');
const outPath = join(root, 'db/seed.json');

// ── Plants: parse each Markdown file's frontmatter + body ───────────────────
const plants = readdirSync(plantsDir)
  .filter((f) => f.endsWith('.md'))
  .map((f) => {
    const slug = f.replace(/\.md$/, '');
    const { data, content } = matter(readFileSync(join(plantsDir, f), 'utf-8'));
    return {
      slug,
      title: data.title,
      scientificName: data.scientificName ?? null,
      commonNames: data.commonNames ?? [],
      category: data.category,
      season: data.season ?? null,
      status: data.status ?? 'year-round',
      ripeStart: data.ripeStart ?? null,
      ripeEnd: data.ripeEnd ?? null,
      heroImage: data.heroImage ?? null,
      gallery: data.gallery ?? [],
      idCues: data.idCues ?? [],
      safety: data.safety ?? [],
      guides: data.guides ?? [],
      order: data.order ?? 100,
      updated: data.updated ?? null,
      body: content.trim(),
    };
  })
  .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

// ── Spots: GeoJSON features → flat rows with stable integer ids ─────────────
const geo = JSON.parse(readFileSync(geojsonPath, 'utf-8'));
const spots = (geo.features ?? []).map((f, i) => {
  const [lon, lat] = f.geometry.coordinates;
  const p = f.properties ?? {};
  return {
    id: i + 1,
    name: p.name,
    category: p.category,
    species: p.species ?? null,
    season: p.season ?? null,
    location: p.location ?? null,
    notes: p.notes ?? null,
    added: p.added ?? null,
    plant: p.plant ?? null,
    lon,
    lat,
    photos: Array.isArray(p.photos) ? p.photos : [],
    updated: null,
  };
});

mkdirSync(join(root, 'db'), { recursive: true });
writeFileSync(outPath, JSON.stringify({ plants, spots }, null, 2) + '\n');
console.log(`Wrote ${outPath}: ${plants.length} plants, ${spots.length} spots.`);
