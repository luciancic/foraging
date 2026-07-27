# foraging

Lucian's personal foraging map + urban-edible plant field guide for Montréal.
Live at **https://foraging.condrea.dev**.

A small [Astro](https://astro.build) static site:

- **Map** (`/map`) — your logged foraging spots, rendered with Leaflet from
  `public/data/foraging-spots.geojson` (the source of truth — edit it in-repo).
- **Plants** (`/plants`) — one page per plant, authored as Markdown in
  `src/content/plants/`. ID cues, safety/lookalikes, harvest & prep notes, guide links, photos.

## Develop

```bash
npm install
npm run dev        # http://localhost:4321
npm run build      # static output → dist/
```

## Add / edit content

- **A plant:** add a Markdown file in `src/content/plants/`. Copy an existing one for the
  frontmatter shape (schema in `src/content/config.ts`). The body is free-form field notes.
- **Photos:** drop images in `public/images/plants/` (ID photos) or `public/photos/spots/`
  (map-pin photos) and reference them by `/images/plants/<file>` etc.
- **A map spot:** edit `public/data/foraging-spots.geojson`. Each feature is a
  `Point` `[lon, lat]` with `properties`: `name, category, species, season, location, notes,
  photos[]`. Categories (marker colours): `tree berries greens herbs nuts mushrooms other`.

## Deploy (this VPS)

Served by Caddy from `/srv/foraging`.

```bash
bash scripts/install.sh   # first time / after a VPS wipe: makes /srv/foraging, adds the
                          # Caddy block, builds + deploys. Needs DNS A record
                          # foraging.condrea.dev → 165.227.33.13 (already set).
bash scripts/deploy.sh    # thereafter: rebuild + publish
```

## Backups

Git is primary. `scripts/backup-storj.sh` pushes an extra offsite copy of the
irreplaceable bits (plant markdown, the GeoJSON, and all photos) to the personal Storj
`foraging` bucket — a versioned `backups/*.tar.gz` snapshot plus a plain `assets/` mirror.
It reuses the Storj S3 keys already in `~/myclaw/.env`, so no separate credentials are needed.

```bash
bash scripts/backup-storj.sh
```

## Notes

- The VPS is wipeable — everything needed to rebuild lives in this repo (`scripts/install.sh`
  reconstructs the serve dir + Caddy block).
- This supersedes the older single-file generated map at `maps.condrea.dev/p/forage-*.html`
  (from `myclaw/scripts/gis/`); the GeoJSON here was seeded from that one.
