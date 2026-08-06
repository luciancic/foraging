# foraging — project context

Lucian's personal foraging site: an interactive map of logged foraging spots + an
urban-edible plant field guide for Montréal. Live at **https://foraging.condrea.dev**.

## Stack & layout
- **Astro** static site (Node 22) for pages; a small **live data API** for pins.
  Build → `dist/`.
- **Data layer = local SQLite** at `data/foraging.db` (`better-sqlite3`), the runtime
  source of truth for `plants` and `pins`. It's mutable live state, so it's
  **gitignored**; `db/seed.json` is the committed, human-readable snapshot. Access
  goes through `src/lib/db.mjs` (shared by the Astro build and the Node scripts/API).
- **One `pins` table holds every map pin** — confirmed spots AND unverified scouting
  leads — split by `verified` (1 = confirmed, 0 = lead) + `source`. `verified=1` pins
  are the precious hand-curated data (dumped to seed.json, live-edited); `verified=0`
  leads are machine-generated and **wholesale-replaced from the geojson every deploy**
  (`importLeads`), which never touches a confirmed row and dedups already-promoted
  leads (by `source`+`ext_id`). One colour axis: `category` (fruit/nuts/greens/herbs/
  mushrooms/other) + a `caution` boolean (dangerous lookalike). `plant` is a validated
  soft link (checked in app code, not a hard FK — a live FK would deadlock the plant
  re-sync). Promote a lead = flip `verified` in place (keeps provenance).
- **Plants** render at **build time** from the DB (`src/lib/content.mjs` — body
  Markdown → HTML via markdown-it). Content follows git: every deploy re-syncs the
  `plants` table from `db/seed.json`.
- **Confirmed pins** are served **live** by `server/api.mjs` (`GET /api/pins` = the
  verified pins, token-gated `POST`/`PATCH`/`POST …/:id/promote` to add/move/promote)
  so field edits show without a rebuild. `ForagingMap.astro` fetches `/api/pins`
  (fallback `dist/data/foraging-spots.geojson`) for confirmed + the static
  `dist/data/pins-leads.geojson` (verified=0 export) for leads; both share one feature
  shape and one clustered layer. In prod Caddy reverse-proxies `/api/*` → `localhost:8787`.
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
  `name, category, species, season, location, notes, plant, caution, photos[]`;
  categories: `fruit nuts greens herbs mushrooms other`). This writes a confirmed
  (`verified=1`) pin to the live DB — confirmed pins are NOT re-seeded on deploy, so
  don't hand-edit them in `seed.json` and expect
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
- **Scouting leads render alongside confirmed pins** in ONE clustered layer, coloured
  by `category` and shaped by provenance (confirmed = teardrop, iNat = circle, FF =
  diamond, city = triangle); an amber ring flags `caution`. Each source has its own
  panel toggle (leads off by default, fullscreen map only); a shared "Filter by type"
  + a caution toggle apply across everything; per-pin Hide (leads) persists per-device
  keyed on `source:ext_id`. Confirming a lead in person = **promote it**: `/map?edit=1`,
  click the lead, **➕ Promote to confirmed spot**, pick a type → `POST /api/pins/:id/
  promote` flips `verified=1` in place (keeps `source`/`ext_id` provenance, so a
  re-scout dedups it). Plant guides count leads too: the "on map" badge shows the total
  with confirmed in parens (`31 on map (1 confirmed)`) from one `WHERE plant = slug`
  query over the `pins` table (`src/lib/spots.ts` → `pinCounts`); `/map?plant=<slug>`
  deep-links that plant's leads + confirmed pins.
- **Scout a mission area (iNaturalist leads):** regenerate `public/data/scouting-spots.geojson`
  with `scripts/inat-scout.py --bbox SWLAT SWLNG NELAT NELNG --name "..." --out
  public/data/scouting-spots.geojson`. It pulls iNat research-grade observations in the
  box and keeps only taxa in the script's curated `FORAGE` table, emitting a `category`
  + `caution` (dangerous-lookalike) + a how-to note + optional guide slug; toxic taxa
  are dropped entirely. Extend `FORAGE`/`CATEGORY` when ranging into new species; iNat
  gives *where*, the table gives *edible/how*. `db-init` imports the geojson into the
  `pins` table each deploy (the map reads the unified `pins-leads.geojson` export, not
  the raw per-source files).
- **Second scouting source — Falling Fruit:** `public/data/falling-fruit.geojson`
  is a parallel scouting class from the community edible-plant map
  [fallingfruit.org] — regenerate with `scripts/fallingfruit-scout.py --bbox
  SWLAT SWLNG NELAT NELNG --name "..." --out public/data/falling-fruit.geojson`.
  Same curated `FORAGE`/`CATEGORY` tables (keyed by scientific name/genus;
  uncurated/non-plant types like "Dumpster" are skipped) emitting `category` +
  `caution`. On the map, **shape encodes provenance** (confirmed teardrop / iNat
  circle / FF diamond / city triangle) and **colour is the category**; per-source
  toggles + a shared type filter apply across all layers. Data is **CC BY-NC-SA** — the
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
  genus/species `FORAGE`/`CATEGORY` tables (ornamental maples/ash/elm dropped; toxic
  Kentucky coffeetree + horse-chestnut dropped too) **and spatially thins**
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
