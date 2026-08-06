# foraging — project context

Lucian's personal foraging site: an interactive map of logged foraging spots + an
urban-edible plant field guide for Montréal. Live at **https://foraging.condrea.dev**.

## Stack & layout
- **Astro** static site (Node 22) for pages; a small **live data API** for pins.
  Build → `dist/`.
- **Data layer = local SQLite** at `data/foraging.db` (`better-sqlite3`), the runtime
  source of truth for both `plants` and `spots`. It's mutable live state, so it's
  **gitignored**; `db/seed.json` is the committed, human-readable snapshot. Access
  goes through `src/lib/db.mjs` (shared by the Astro build and the Node scripts/API).
- **Plants** render at **build time** from the DB (`src/lib/content.mjs` — body
  Markdown → HTML via markdown-it). Content follows git: every deploy re-syncs the
  `plants` table from `db/seed.json`.
- **Spots** are served **live** by `server/api.mjs` (`GET /api/pins`, and token-gated
  `POST`/`PATCH` to add/move) so field edits show without a rebuild. `ForagingMap.astro`
  fetches `/api/pins`, falling back to a build-time `dist/data/foraging-spots.geojson`
  export if the API is down. In prod Caddy reverse-proxies `/api/*` → `localhost:8787`.
- **Photos live in Storj** (bucket `foraging`, prefix `media/`), NOT in git. The API
  serves them at `/images/plants/*` (ID shots) and `/photos/spots/*` (map-pin shots) —
  a read-through cache (`media-cache/`) fetches each from Storj on first hit. Caddy
  reverse-proxies those paths to the API. To add a photo: upload it to
  `media/images/plants/<file>` or `media/photos/spots/<file>` in the bucket (reuse the
  Storj creds in `~/myclaw/.env`); reference it by the same `/images/...` or `/photos/...`
  URL. Image URLs are unchanged from before — only where they're served from changed.
- Status badges ("ripe now" etc.) are **date-driven** from each plant's `ripeStart`/
  `ripeEnd` window — `src/lib/season.ts`. A nightly systemd timer rebuilds so they stay current.

## Common tasks
- **Add / edit a plant:** edit its entry in `db/seed.json` (or upsert into the DB and
  run `npm run db:export` to refresh the snapshot), commit, deploy. `deploy.sh` runs
  `db:init`, which re-syncs the `plants` table from the seed. Fields mirror the old
  frontmatter (`title, scientificName, commonNames, category, season, status,
  ripeStart, ripeEnd, heroImage, gallery, idCues, safety, guides, order, updated`)
  plus a free-form Markdown `body`.
- **Add a map spot:** `POST /api/pins` with the edit token (Point via `lon`/`lat` +
  `name, category, species, season, location, notes, plant, photos[]`; categories:
  `tree berries greens herbs nuts mushrooms other`). This writes to the live DB —
  spots are NOT re-seeded on deploy, so don't hand-edit them in `seed.json` and expect
  propagation. `plant` = a plant slug interlinks the pin with its guide both ways;
  "on map" on a plant page is derived from these links at build time (`src/lib/spots.ts`).
- **Move a pin (fix bad photo-geolocation):** open `/map?edit=1`, drag the pin, drop
  it — it PATCHes `/api/pins/:id` and persists live. Needs the edit token (stored
  per-device in `localStorage`; the value is in `~/.config/foraging/foraging.env`).
- **Snapshot live edits back to git:** `npm run db:export` (DB → `db/seed.json`),
  then commit. This is a deliberate step — the nightly Storj backup captures the
  live `data/foraging.db` directly (so field edits are safe) but does NOT touch the
  git-tracked seed, to avoid a perpetually-dirty prod working tree.
- **Better photos:** replace the object in Storj under `media/images/plants/<file>`
  (or `media/photos/spots/<file>`); clear the API's `media-cache/<path>` so the new
  one is re-fetched.
- **Scout a mission area (iNaturalist leads):** `public/data/scouting-spots.geojson`
  is a *separate, unverified* pin class (distinct tier-coloured circles vs. the
  verified teardrop pins) — regenerate it with `scripts/inat-scout.py --bbox
  SWLAT SWLNG NELAT NELNG --name "..." --out public/data/scouting-spots.geojson`.
  It pulls iNat research-grade observations in the box and keeps only species in
  the script's curated `FORAGE` table (tier = snack/prep/caution/avoid + a how-to
  note + optional guide slug). The map shows it under a filter toggle (off by
  default, fullscreen map page only). Confirming a lead in person = promote it
  into a real pin — either `POST /api/pins`, or from the map itself: open
  `/map?edit=1`, click a scouting pin, hit **➕ Promote to confirmed spot**, pick
  a category, and it POSTs `/api/pins` (carrying the lead's name/species/notes +
  `plant` slug), drops the confirmed pin, and hides the lead locally. Extend
  `FORAGE` when ranging into new species; iNat gives *where*, the table gives
  *edible/how*. Plant guides count leads too: the "on map" badge shows the total
  with confirmed in parens (`31 on map (1 confirmed)`) and its `/map?plant=<slug>`
  deep-link surfaces that plant's leads alongside confirmed pins
  (`src/lib/scouting.mjs` reads the three scouting GeoJSON at build time).
- **Second scouting source — Falling Fruit:** `public/data/falling-fruit.geojson`
  is a parallel scouting class from the community edible-plant map
  [fallingfruit.org] — regenerate with `scripts/fallingfruit-scout.py --bbox
  SWLAT SWLNG NELAT NELNG --name "..." --out public/data/falling-fruit.geojson`.
  Same tier vocabulary + curated `FORAGE` table (keyed by scientific name/genus;
  uncurated/non-plant types like "Dumpster" are skipped). On the map, **shape
  encodes source** (iNat = circles, Falling Fruit = diamonds, Ville de Montréal =
  triangles) and **colour the tier**; each source has its own toggle in the layers
  panel, tier filters + Hide apply across all three. Data is **CC BY-NC-SA** — the
  panel carries a required Falling Fruit attribution and each pin links to its
  source page; keep both if you touch this. Uses Falling Fruit's public read API
  key (`AKDJGHSD`, from their own web-app setup docs). Non-commercial use only.
- **Third scouting source — Ville de Montréal public trees:**
  `public/data/montreal-trees.geojson` is the city's public street/park tree
  inventory ("Arbres publics", donnees.montreal.ca) filtered to forageable species —
  regenerate with `scripts/montreal-trees-scout.py --bbox SWLAT SWLNG NELAT NELNG
  --name "..." --out public/data/montreal-trees.geojson`. Pulled live from the CKAN
  datastore SQL API (resource `64e28fe6-…`, ~335k trees citywide; no bulk download).
  Unlike iNat/FF this is an **authoritative** inventory — `Essence_latin` IS the
  arborist's species label — but the city plants edibles by the thousand. The map
  **clusters** scouting markers (Leaflet.markercluster — nearby pins collapse into a
  counted bubble that splits as you zoom), so rendering thousands is fine; the real
  limit is the geojson payload over mobile data. So the generator **curates** via a
  genus/species `FORAGE` table (ornamental maples/ash/elm dropped; toxic Kentucky
  coffeetree + horse-chestnut kept as `avoid` teaching pins) **and spatially thins**
  the survivors to keep the download light (≤1 tree per ~`--cell-m` grid cell per
  species, then a `--max-per-species` cap, defaults 60 m / 120 — every dropped count
  is logged, nothing silently truncated; raise the cap / shrink the cell for a denser
  pull of a smaller area). Verdun ≈ 1,880 pins / 1.2 MB from ~12k forageable. Shape =
  **triangle ▲**. Licence **CC BY 4.0** (attribution
  required — panel credits "Ville de Montréal"; commercial use OK, unlike FF). Each
  pin links to the dataset and carries the city's own caveat that locations "may be
  imprecise/outdated" — confirm in person before promoting to a real pin.

## Deploy & backup (this VPS)
- Served by Caddy from `/srv/foraging` (static) + a reverse-proxy for `/api/*`,
  `/photos/*`, `/images/*` → `localhost:8787` (the `foraging-api` systemd user service
  running `server/api.mjs`, which needs the Storj creds from `~/myclaw/.env` to serve
  photos).
- `scripts/deploy.sh` = `db:init` (sync plants; keep live spots) + build + publish +
  restart the API. `scripts/install.sh` = first-time / post-wipe: Caddy block, edit
  token (`~/.config/foraging/foraging.env`, generated + printed once), nightly rebuild
  timer, the API service, DB seed, then deploy.
- `scripts/backup-storj.sh` → personal Storj `foraging` bucket (reuses the Storj creds
  in `~/myclaw/.env`); backs up `data/foraging.db` + `db/seed.json` (NOT photos — those
  already live in the bucket under `media/`). Git holds the code + `db/seed.json`
  snapshot; the **live DB is only in the backup**, not git.
- VPS is wipeable: `install.sh` rebuilds the DB from the committed `db/seed.json` (or
  restore `data/foraging.db` from the Storj backup to recover field edits since the
  last `db:export`).

## Conventions
- Verify UI changes in a real browser before claiming they work (Playwright lives in
  `~/myclaw/ui`; run the script from inside that dir so `playwright` resolves).
- Knowledge/notes about foraging itself belong in the KB vault (`2.Areas/Foraging/`),
  not here — this repo is code + content only.
