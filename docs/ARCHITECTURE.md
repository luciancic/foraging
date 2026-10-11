# foraging — architecture

How the site works. Agent rules live in `CLAUDE.md`; this is the on-demand reference.

## Data

- **SQLite** at `data/foraging.db` (`better-sqlite3`, gitignored) is the runtime source of truth for `plants` and `pins`; `db/seed.json` is the committed, human-readable snapshot. All access goes through `src/lib/db.mjs` (shared by the Astro build, the scripts and the API).
- **Plants** render at build time from the DB (`src/lib/content.mjs`, Markdown body → HTML via markdown-it). Every deploy re-syncs `plants` from `db/seed.json`, so plant content follows git. Fields: `title, scientificName, commonNames, category, season, status, ripeStart, ripeEnd, heroImage, gallery, idCues, safety, guides, order, updated` + a Markdown `body`. `category` is an ordered JSON list (first = primary / map colour; a bare string is tolerated), values `fruit nuts greens herbs sap mushrooms other` — e.g. elderberry = fruit+herbs, sugar maple = sap.
- **One `pins` table holds every map pin**, split by `verified`: `1` = confirmed spots (hand-curated, live-edited), `0` = scouting leads (a fixed dataset from iNaturalist, Falling Fruit and Ville de Montréal that lives only in the DB). `pins.id` is `AUTOINCREMENT`, so a deleted id is never reused.
- **Every pin belongs to a plant guide.** `plant` is a validated soft link (checked in app code; a hard FK would deadlock the plant re-sync). `syncPinsToPlants()` runs on every deploy (via `db:init`) and resolves each pin's species → plant slug, derives the pin `name` from the plant title, sets `category` from the plant's primary, and ORs `caution` for hazardous plants. A pin has one category; its colour and type filters come from its plant's list at render time. Pin `notes` hold access details only (fence, gate…) — picking and cooking live in the guide. Ornamentals with no guide (honey locust, Callery pear, generic Prunus) stay species-tagged and unlinked.
- **Audit log:** every human pin change appends to `pin_events` (`create`/`edit`/`move`/`delete`/`promote`, plus a `genesis` baseline per pre-existing pin) with actor, timestamp and full before/after snapshots — reversible by re-applying a snapshot. `backfillGenesis()` runs on every deploy and only touches pins with zero events, so a git-only reseed self-heals and a backup restore is left alone. Contributors are rows in `users`. History lives in the DB (backed up), never in `seed.json`.

## Who can do what

- Readers are anonymous. A **named contributor** (a self-asserted name + a client-generated id from `localStorage`, sent as `{actor:{id,name}}`) can add a spot — it lands confirmed immediately — and edit a pin's text.
- The **admin** holds `FORAGING_EDIT_TOKEN` (stored per device in `localStorage`) and can also move, delete and promote pins, and read history.
- This is a deliberate, scoped loosening: anyone who finds `/map?edit=1` can add or edit, which is acceptable for the current small trusted group and is moderated reactively through the log. Only the token is verified server-side. For provable identity, map per-person tokens to users server-side; the event schema doesn't change.

## API (`server/api.mjs`, :8787)

- `GET /api/pins` — confirmed pins. `POST /api/pins` (a Point via `lon`/`lat` + `name, category, species, season, location, notes, plant, caution, photos[]`; set `plant` and the rest is derived) and `PATCH /api/pins/:id` — named contributors. Moving (`PATCH` with `lon`/`lat`), `DELETE /api/pins/:id`, `POST /api/pins/:id/promote`, `GET /api/pins/:id/history` and `GET /api/activity?limit=N` are admin-only.
- Field edits show without a rebuild. Promote flips `verified` in place, keeping `source`/`ext_id` provenance; delete removes a pin outright (its final snapshot stays in the log).

## Map (`ForagingMap.astro`)

- Confirmed pins come from `/api/pins` (fallback `dist/data/foraging-spots.geojson`); leads from the build-time `dist/data/pins-leads.geojson`. Both share one feature shape and one clustered layer. `dist/data/plants.json` (per-plant title, categories, ripe window — `plantsMeta()` in `astro.config.mjs`) is joined onto every pin for colour, display name, the type filter, a "ripe now" toggle and a searchable multi-select plant filter.
- Colour = category; shape = provenance (confirmed teardrop, iNat circle, Falling Fruit diamond, city triangle); an amber ring flags `caution`. Each source has a panel toggle (leads off by default, fullscreen only).
- Filters are deep-linkable and sync back to the URL: `?plants=slug,slug`, `?ripe=1`, `?cat=fruit,greens` (`?plant=` is a back-compat alias; plant guides link with it).
- Edit mode is `/map?edit=1`: drag to move, open a pin to delete, open a lead to promote.
- A plant page's "on map" badge counts linked pins (`31 on map (1 confirmed)`) — `pinCounts` in `src/lib/spots.ts`.
- Lead licences still bind: Falling Fruit is CC BY-NC-SA (panel attribution + per-pin source link, non-commercial), Ville de Montréal is CC BY 4.0 (panel credit). The city's "may be imprecise/outdated" caveat is why a lead is confirmed in person before promotion.

## Media

- Photos live in Storj (bucket `foraging`, prefix `media/`), not git. The API serves `/images/plants/*` (ID shots) and `/photos/spots/*` (pin shots) through a read-through cache (`media-cache/`).
- Uploads (`POST /api/photos`) go through `optimizeImage()`: auto-orient, strip metadata, cap the long edge at 2048px, recompress in the same format (HEIC → JPEG). The full-res original is kept at `media/originals/<rel>`. `scripts/optimize-media.mjs` does the same for hand-uploaded objects (idempotent, `--dry` to preview).
- `?v=thumb` (480px) and `?v=card` (800px) serve cached WebP variants from `media-cache/_variants/<v>/` (`mediaVariant()` in `src/lib/media.ts`); the bare URL is full-res.
- "Ripe now" badges are date-driven from each plant's `ripeStart`/`ripeEnd` (`src/lib/season.ts`); a nightly systemd timer rebuilds to keep them current.

## Deploy, backup, recovery

- Caddy serves the static web root and reverse-proxies `/api/*`, `/photos/*` and `/images/*` to the API (a systemd user service). Machine paths and service names: `CLAUDE.local.md`.
- `scripts/deploy.sh` = `db:init` (sync plants and pins-to-plants, backfill `genesis`) + build + publish + restart the API. `scripts/install.sh` is the first-time / post-wipe setup (Caddy block, edit token, timers, API service, DB seed, then deploy).
- `scripts/backup-storj.sh` backs up `data/foraging.db` + `db/seed.json` nightly to the Storj `foraging` bucket (photos are already there).
- After a wipe, `install.sh` rebuilds plants and confirmed spots from `db/seed.json`; restore `data/foraging.db` from the backup for everything only in the live DB — edits since the last `db:export`, the leads, and the `pin_events`/`users` history.
