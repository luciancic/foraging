# foraging — project context

Lucian's personal foraging site: an interactive map of logged foraging spots + an
urban-edible plant field guide for Montréal. Live at **https://foraging.condrea.dev**.

## Stack & layout
- **Astro** static site (Node 22). Build → `dist/`.
- Plants are Markdown content: `src/content/plants/*.md` (schema `src/content/config.ts`).
  The frontmatter body is free-form field notes (harvest, prep, recipes).
- The map is **Leaflet** rendering `public/data/foraging-spots.geojson` client-side —
  that GeoJSON is the source of truth for pins. `src/components/ForagingMap.astro`.
- Photos: `public/images/plants/` (ID shots), `public/photos/spots/` (map-pin shots).
- Status badges ("ripe now" etc.) are **date-driven** from each plant's `ripeStart`/
  `ripeEnd` window — `src/lib/season.ts`. A nightly systemd timer rebuilds so they stay current.

## Common tasks
- **Add a plant:** new `.md` in `src/content/plants/` (copy an existing one).
- **Add a map spot:** edit `public/data/foraging-spots.geojson` (feature = Point `[lon,lat]`
  + properties `name, category, species, season, location, notes, photos[]`;
  categories: `tree berries greens herbs nuts mushrooms other`). Add optional `plant`
  = a plant slug (filename in `src/content/plants/`) to interlink the pin with its
  guide both ways; leave it out if no guide exists yet. Whether a plant shows as
  "on map" is derived from these links at build time (`src/lib/spots.ts`) — no flag
  to maintain on the plant.
- **Better photos:** replace files in `public/images/plants/`.

## Deploy & backup (this VPS)
- Served by Caddy from `/srv/foraging`. `scripts/deploy.sh` = rebuild + publish;
  `scripts/install.sh` = first-time / post-wipe (Caddy block + nightly timer + deploy).
- `scripts/backup-storj.sh` → personal Storj `foraging` bucket (reuses the Storj creds
  in `~/myclaw/.env`; no separate credentials). Git is the primary source of truth.
- VPS is wipeable — everything needed to rebuild lives in this repo.

## Conventions
- Verify UI changes in a real browser before claiming they work (Playwright lives in
  `~/myclaw/ui`; run the script from inside that dir so `playwright` resolves).
- Knowledge/notes about foraging itself belong in the KB vault (`2.Areas/Foraging/`),
  not here — this repo is code + content only.
