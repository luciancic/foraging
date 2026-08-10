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
  leads are a **one-time populated dataset** (iNat / Falling Fruit / Ville de Montréal)
  that just lives in the DB — there is **no deploy-time re-import**; recover them after
  a wipe by restoring the DB backup. One colour axis: `category` (fruit/nuts/greens/
  herbs/**sap**/mushrooms/other) + a `caution` boolean (dangerous lookalike). **Every
  pin belongs to a plant guide.** `plant` is a validated soft link (checked in app code,
  not a hard FK — a live FK would deadlock the plant re-sync). `syncPinsToPlants()` (in
  `db.mjs`, run idempotently by `db:init` every deploy, like `backfillGenesis`) resolves
  each pin's species → canonical plant slug, **derives the pin `name` from the plant
  title** (pins are no longer custom-named — the guide holds the species detail), sets
  `category` from the plant's primary, and OR-s `caution` for hazardous plants. Pin
  `notes` are **access precisions only** (behind a fence, which gate…) — picking/cooking
  live in the guide. The ornamental tail with no guide (honey locust, Callery pear,
  generic Prunus) stays species-tagged (unlinked). A **plant** may carry SEVERAL
  categories (`plants.category` is an ordered JSON list, first = primary/colour; e.g.
  elderberry = fruit+herbs, sugar-maple/birch = sap); a pin stays single-category
  (colour + type filters come from the plant's list at render). Promote a lead = flip
  `verified` in place (keeps provenance). `pins.id` is `AUTOINCREMENT` so a deleted id
  is never reused (keeps the audit log clean).
- **Every human pin change is logged** in an append-only `pin_events` table (`create`/
  `edit`/`move`/`delete`/`promote`, plus a `genesis` baseline per existing pin) with
  the actor, timestamp, and full before/after snapshots — so changes are attributable
  and reversible. Contributors are lightweight rows in `users` (a self-asserted name +
  a client-generated id from localStorage). Attribution is **not authenticated**: the
  name is claimed, the edit token is the only server-verified secret (marks an admin).
  History lives in the DB (backed up to Storj), never in `seed.json`. See the
  **Contributors & audit log** section below.
- **Plants** render at **build time** from the DB (`src/lib/content.mjs` — body
  Markdown → HTML via markdown-it). Content follows git: every deploy re-syncs the
  `plants` table from `db/seed.json`.
- **Confirmed pins** are served **live** by `server/api.mjs` (`GET /api/pins` = the
  verified pins; `POST`/`PATCH`/`DELETE`/`POST …/:id/promote` to add/edit/move/delete/
  promote). Writes are **name-gated, not all token-gated**: a named contributor can add
  a spot or edit a pin's text with just a name in the body; the edit token additionally
  unlocks the **admin-only** actions (move, delete, promote, `GET …/history`, `GET
  /api/activity`). Field edits show without a rebuild. `ForagingMap.astro` fetches `/api/pins`
  (fallback `dist/data/foraging-spots.geojson`) for confirmed + the static
  `dist/data/pins-leads.geojson` (verified=0 export) for leads; both share one feature
  shape and one clustered layer. It also fetches `dist/data/plants.json` (per-plant
  meta: title, category list, ripe window — emitted at build via `plantsMeta()` in
  `astro.config.mjs`) and **joins it onto every pin** for colour (primary category),
  display name, the type filter (matches any of a plant's categories), a **"ripe now"**
  toggle (computed against the live date, mirroring `season.ts`), and a **searchable
  multi-select plant filter**. Filters are **deep-linkable / shareable**: `?plants=slug,slug`
  (multi), `?ripe=1`, `?cat=fruit,greens` open the map in normal mode with them applied
  (plant guides link with `?plants=`; `?plant=` is a back-compat alias), and in-panel
  filter changes sync back to the URL. In prod Caddy reverse-proxies `/api/*` → `localhost:8787`.
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
  plus a free-form Markdown `body`. `category` is a **JSON list** (first = primary /
  map colour), tolerant of a legacy bare string; values: `fruit nuts greens herbs sap
  mushrooms other`.
- **Add a map spot:** the in-map ➕ contribute sheet makes the visitor **pick a plant**;
  the pin inherits its `name`/`category`/`species` from the guide (an `__other` escape
  hatch covers finds with no guide yet). Under the hood `POST /api/pins` with an actor
  (`{actor:{id,name}}`, or the edit token to post as admin) and a Point via `lon`/`lat`
  + `name, category, species, season, location, notes, plant, caution, photos[]`;
  categories: `fruit nuts greens herbs sap mushrooms other`. Prefer setting `plant` — a
  linked pin's `name`/`category` are re-derived from the plant by `syncPinsToPlants` on
  every deploy anyway (pins follow their guide). This writes a confirmed (`verified=1`) pin to the live DB
  immediately and records a `create` event — confirmed pins are NOT re-seeded on
  deploy, so don't hand-edit them in `seed.json` and expect propagation. `plant` = a
  plant slug interlinks the pin with its guide both ways; "on map" on a plant page is
  derived from these links at build time (`src/lib/spots.ts`).
- **Edit a pin's info:** `PATCH /api/pins/:id` with an actor + any of `name, category,
  caution, species, season, location, notes, plant, photos` — open to named
  contributors, records an `edit` event.
- **Move a pin (fix bad photo-geolocation):** open `/map?edit=1`, drag the pin, drop
  it — it PATCHes `/api/pins/:id` with `lon`/`lat` and persists live (records a `move`
  event). **Admin-only** (a drag is destructive to curated placement): needs the edit
  token, stored per-device in `localStorage`; the value is in `~/.config/foraging/foraging.env`.
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
  + a caution toggle apply across everything. **Delete a pin** in edit mode
  (`/map?edit=1`, open a pin → **🗑 Delete this pin** → `DELETE /api/pins/:id`) —
  **admin-only**; the pin is removed outright (confirmed or lead) and a `delete` event
  keeps its final snapshot. With deploy-time lead re-import gone there's nothing to
  resurrect a deleted lead, so there are no tombstones. Confirming a lead in person =
  **promote it** (admin-only): `/map?edit=1`, click the lead, one-click **➕ Promote to
  confirmed spot** → `POST /api/pins/:id/promote` flips `verified=1` in place (keeps
  `source`/`ext_id` provenance). Plant guides count leads too: the "on map" badge shows
  the total with confirmed in parens (`31 on map (1 confirmed)`) from one `WHERE plant =
  slug` query over the `pins` table (`src/lib/spots.ts` → `pinCounts`); `/map?plant=<slug>`
  deep-links that plant's leads + confirmed pins.
- **Scouting leads are a fixed, already-populated dataset.** The original per-source
  scout scripts (iNat / Falling Fruit / Ville de Montréal) and their raw geojson have
  been removed — leads now just live in the DB as `verified=0` rows and are re-exported
  to `dist/data/pins-leads.geojson` on each build. On the map, **shape encodes
  provenance** (confirmed teardrop / iNat circle / FF diamond / city triangle) and
  **colour is the category**; per-source toggles + a shared type filter apply across
  all layers. Attribution obligations still stand for the data already in the DB:
  **Falling Fruit** is CC BY-NC-SA (panel attribution + per-pin source link, non-commercial)
  and **Ville de Montréal** is CC BY 4.0 (panel credits "Ville de Montréal"); the city's
  caveat that locations "may be imprecise/outdated" is why leads must be confirmed in
  person before promoting. To re-populate leads (rare), restore from the DB backup or
  recover a scout script from git history.

## Contributors & audit log
- **Who can do what.** Anyone reading is anonymous. A **named contributor** (just a
  name, no secret) can add a spot (lands confirmed immediately) and edit a pin's text.
  The **admin** (holds `FORAGING_EDIT_TOKEN`) can additionally move, delete, promote,
  and read history. This is a deliberate, scoped loosening: the site is public, so
  name-only writes mean anyone who finds `/map?edit=1` can add/edit — acceptable for
  the current small trusted group, moderated reactively via the log.
- **Attribution is self-asserted.** A contributor's name + a client-generated `id` (kept
  in `localStorage`, upserted into `users`) ride along on every write as `{actor:{id,name}}`.
  Only the token is verified server-side; the name is claimed, not authenticated. Upgrade
  path if you ever need provable identity: per-person tokens mapped to a user server-side
  (the event schema doesn't change).
- **The log.** `pin_events` records `create/edit/move/delete/promote` (+ a `genesis`
  baseline per pre-existing confirmed pin) with actor, timestamp, and full before/after
  pin snapshots. Reversible by re-applying an old snapshot. Reads are admin-only:
  `GET /api/pins/:id/history` (one pin, oldest→newest) and `GET /api/activity?limit=N`
  (recent across all pins). `db:init` runs `backfillGenesis()` every deploy — idempotent,
  only touches pins with zero events, so a git-only reseed self-heals and a backup
  restore is left untouched. In `src/lib/db.mjs`: `pinHistory`, `recentEvents`,
  `backfillGenesis`, and the `actor`-aware mutators (`addPin`/`updatePin`/`promotePin`/
  `deletePin`).

## Deploy & backup (this VPS)
- Served by Caddy from `/srv/foraging` (static) + a reverse-proxy for `/api/*`,
  `/photos/*`, `/images/*` → `localhost:8787` (the `foraging-api` systemd user service
  running `server/api.mjs`, which needs the Storj creds from `~/myclaw/.env` to serve
  photos).
- `scripts/deploy.sh` = `db:init` (sync plants; keep live spots + leads; backfill any
  missing `genesis` events) + build + publish + restart the API. `scripts/install.sh`
  = first-time / post-wipe: Caddy block, edit
  token (`~/.config/foraging/foraging.env`, generated + printed once), nightly rebuild
  timer, the API service, DB seed, then deploy.
- `scripts/backup-storj.sh` → personal Storj `foraging` bucket (reuses the Storj creds
  in `~/myclaw/.env`); backs up `data/foraging.db` + `db/seed.json` (NOT photos — those
  already live in the bucket under `media/`). Git holds the code + `db/seed.json`
  snapshot; the **live DB is only in the backup**, not git.
- VPS is wipeable: `install.sh` rebuilds plants + confirmed spots from the committed
  `db/seed.json`. Restore `data/foraging.db` from the Storj backup to recover anything
  only in the live DB — field edits since the last `db:export`, the scouting **leads**,
  and the `pin_events`/`users` audit history (none of which are in git).

## Conventions
- Verify UI changes in a real browser before claiming they work (Playwright lives in
  `~/myclaw/ui`; run the script from inside that dir so `playwright` resolves).
- Knowledge/notes about foraging itself belong in the KB vault (`2.Areas/Foraging/`),
  not here — this repo is code + content only.
