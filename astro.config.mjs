// @ts-check
import { defineConfig } from 'astro/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pinsGeoJSON, plantsMeta } from './src/lib/db.mjs';

// Emit the current pins as static GeoJSON into the build output. The map fetches
// live confirmed pins from /api/pins (falling back to foraging-spots.geojson when
// the API is down), and reads the unverified leads from pins-leads.geojson — both
// exported here from the unified DB, so the static site never hard-depends on the
// data service and the lead layer always matches what got imported this deploy.
const exportPins = {
  name: 'export-pins',
  hooks: {
    'astro:build:done': ({ dir }) => {
      const outDir = new URL('data/', dir);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(new URL('foraging-spots.geojson', outDir), JSON.stringify(pinsGeoJSON({ verified: true }), null, 2));
      writeFileSync(new URL('pins-leads.geojson', outDir), JSON.stringify(pinsGeoJSON({ verified: false }), null, 2));
      // Per-plant metadata (title, category list, ripe window) the map joins onto
      // pins for colour, derived names, type + ripe-now + plant-name filters.
      writeFileSync(new URL('plants.json', outDir), JSON.stringify(plantsMeta()));
    },
  },
};

// Static site served by Caddy at https://foraging.condrea.dev — plant pages +
// spot counts render from the SQLite data layer at build time. Live pin reads/
// writes go through the separate Node API (server/api.mjs), reverse-proxied at /api.
export default defineConfig({
  site: 'https://foraging.condrea.dev',
  output: 'static',
  build: { format: 'directory' },
  integrations: [exportPins],
  vite: {
    // Native module — never bundle it into the SSR build; require it at runtime.
    ssr: { external: ['better-sqlite3'] },
    optimizeDeps: { exclude: ['better-sqlite3'] },
    // Dev: proxy /api → the local API service so the map calls it same-origin,
    // exactly as it does in prod behind Caddy. Override the target (e.g. to a
    // throwaway test API on another port) with FORAGING_API_PROXY.
    server: { proxy: { '/api': process.env.FORAGING_API_PROXY || 'http://localhost:8787' } },
  },
});
