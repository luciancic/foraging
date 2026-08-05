// @ts-check
import { defineConfig } from 'astro/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { spotsGeoJSON } from './src/lib/db.mjs';

// Emit the current pins as a static GeoJSON into the build output. The map fetches
// live pins from /api/pins, but falls back to this file when the API is down — so
// the static site never hard-depends on the data service being up.
const exportSpotsFallback = {
  name: 'export-spots-fallback',
  hooks: {
    'astro:build:done': ({ dir }) => {
      const outDir = new URL('data/', dir);
      mkdirSync(outDir, { recursive: true });
      writeFileSync(new URL('foraging-spots.geojson', outDir), JSON.stringify(spotsGeoJSON(), null, 2));
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
  integrations: [exportSpotsFallback],
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
