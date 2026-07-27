// @ts-check
import { defineConfig } from 'astro/config';

// Static site served by Caddy at https://foraging.condrea.dev
export default defineConfig({
  site: 'https://foraging.condrea.dev',
  output: 'static',
  build: { format: 'directory' },
});
