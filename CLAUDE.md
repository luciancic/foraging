# foraging — project context

Lucian's personal foraging site: an interactive map of logged foraging spots + an urban-edible plant field guide for Montréal. Live at **https://foraging.condrea.dev**. Astro static pages + a small live API (`server/api.mjs`) over SQLite. How it all works: `docs/ARCHITECTURE.md`. Machine-local paths (web root, edit token, Storj creds, systemd units): `CLAUDE.local.md`.

## Where data lives

- **Plant guides follow git:** edit `db/seed.json` (or upsert into the DB and `npm run db:export`), commit, deploy — every deploy re-syncs `plants` from the seed.
- **Pins live only in the DB:** confirmed pins are written live through the API and never re-seeded, so don't hand-edit them in `seed.json` and expect it to propagate; snapshot live edits back to git with `npm run db:export` + commit (a deliberate step — the nightly backup doesn't touch the seed, to keep prod's tree clean). Leads and the audit history exist only in the DB and its Storj backup.
- **Photos live in Storj, not git:** upload to `media/images/plants/<file>` or `media/photos/spots/<file>` and reference the same `/images/...` or `/photos/...` URL. When replacing one, clear its `media-cache/` entry (and `media-cache/_variants/*/<path>.webp`); after a hand upload, run `node scripts/optimize-media.mjs`.
- **Read photo EXIF/GPS with Python PIL** (`Image.open(f)._getexif()` + `PIL.ExifTags`) — this box has no `exiftool`, and a silent fallback looks like "no GPS". Photos uploaded via myclaw (`/tmp/myclaw-uploads/`) keep their GPS; never claim metadata is stripped unless the reader actually ran.

## Conventions

- **Ship autonomously:** commit finished, verified changes to `master` and run `scripts/deploy.sh` without asking; ship each independently-shippable piece the moment it's done rather than bundling it with blocked work. Fix stale docs, comments and refs in place (say what was stale). Push only if asked.
- **Verify external ids, never guess:** a wrong iNaturalist taxon id silently resolves to a real-but-wrong species, so check `curl -s "https://api.inaturalist.org/v1/taxa?q=<Genus%20species>&rank=species"` → `results[0].name` before committing a `taxa/<id>` link.
- **On any `.wrap` element, set vertical spacing with `padding-block`**, never the `padding` shorthand — it zeroes `.wrap`'s horizontal gutter.
- Verify UI changes in a real browser before claiming they work (Playwright lives in `~/myclaw/ui`; run scripts from inside that dir).
- Knowledge about foraging itself goes in the KB (`2.Areas/Foraging/`); this repo holds the site's code, content and its own docs.
