#!/usr/bin/env python3
"""Montréal public-tree scouting-layer generator: pull the city's public street/park
tree inventory inside a bounding box and emit a GeoJSON of scouting pins — a THIRD
source/class alongside the iNaturalist and Falling Fruit layers.

Data: Ville de Montréal open-data portal (donnees.montreal.ca), dataset "Arbres
publics sur le territoire de la Ville" — ~335k municipally-owned trees, each with an
arborist-assigned species (`Essence_latin`) + lat/lon. Queried live via the CKAN
datastore SQL API (no bulk download). Licence **CC BY 4.0** — attribution required
(the map credits "Ville de Montréal"); commercial use is permitted (unlike Falling
Fruit's NC-SA). Public trees are legally forageable in Montréal.

Unlike iNat/FF (community *observations*, ID uncertain), this is an authoritative
inventory — the species IS the label. The catch is the opposite: the city plants
edible trees by the *thousand* (549 crabapples in Verdun alone). The map clusters
markers, so rendering thousands is fine — but the geojson is fetched over mobile
data, so payload is the real limit. So this generator does two things the others
don't:
  1. **Curates** to genuinely forageable species via the FORAGE table below (keyed
     by scientific name — full "genus species" wins over a bare genus). Ornamental
     maples, ash, elm, spruce, etc. are dropped. Toxic street trees present in the
     data (Kentucky coffeetree, horse-chestnut) are kept as `avoid` teaching pins.
  2. **Thins** the survivors to keep the download light: at most one tree per species
     per ~grid cell (even spread, kills dense duplicates), then a hard per-species
     cap. Every count dropped is logged — nothing is silently truncated. Raise
     --max-per-species / lower --cell-m for a denser pull of a smaller area.

Still NOT the source of truth (foraging-spots.geojson is) — these are leads to walk
to and confirm. The city's own disclaimer: tree locations "may be imprecise or out
of date," and some boroughs omit park trees.

Usage:
  scripts/montreal-trees-scout.py --bbox SWLAT SWLNG NELAT NELNG \
      --name "Verdun" --out public/data/montreal-trees.geojson
  # tuning: --max-per-species 30 --cell-m 180  (defaults; raise for a smaller area)
"""
import argparse, json, math, sys, urllib.request, urllib.parse

# Consolidated inventory resource ("Inventaire arbres publics - Fichier consolidé").
RESOURCE_ID = "64e28fe6-ef37-437a-972d-d1d3f1f7d891"
SQL_URL = "https://donnees.montreal.ca/api/3/action/datastore_search_sql"
DATASET_URL = "https://donnees.montreal.ca/dataset/arbres"

# tier vocabulary matches inat-scout.py / fallingfruit-scout.py:
#   snack / prep / caution (dangerous lookalike or careful handling) / avoid (toxic —
#   pinned so you learn NOT to pick it). Keyed by lowercase scientific name; a full
#   "genus species" key wins over a bare "genus" key. (tier, display, how-to, slug).
# Every genus here was confirmed present in Montréal's Verdun inventory during recon.
FORAGE = {
    # ── snack: eat off the tree, minimal prep ──────────────────────────────────
    "malus":              ("snack",   "Crabapple / apple", "Street crabapples — taste one; most are tart but good, cook the sour ones into jelly. The city plants dozens of cultivars.", "apple"),
    "amelanchier":        ("snack",   "Serviceberry",      "Sweet blueberry-like pomes in late June — eat raw off the branch before the birds strip them.", "serviceberry"),
    "celtis":             ("snack",   "Hackberry",         "Small orange-brown drupes in fall — thin sweet date-like flesh over a crunchable seed. Eat whole.", None),
    "morus":              ("snack",   "Mulberry",          "Ripe near-black berries eat raw; unripe/white ones can upset the stomach.", "mulberry"),
    "rhus typhina":       ("snack",   "Staghorn sumac",    "Steep the fuzzy red drupe cones in cold water for pink lemonade.", "staghorn-sumac"),
    "crataegus":          ("snack",   "Hawthorn",          "Red haws off the tree in fall — nibble the thin flesh, spit the seeds (never chew them).", None),
    "corylus":            ("snack",   "Hazelnut",          "Filberts in late summer — crack and eat raw once the husks brown.", None),
    "tilia":              ("snack",   "Linden",            "Young heart-shaped leaves are a mild salad green in spring; the fragrant flowers make a calming tea.", "linden"),
    "pyrus":              ("snack",   "Pear",              "Most street pears are ornamental Callery — tiny hard fruit, only edible frost-softened. The odd 'Bartlett' is a real pear.", None),

    # ── prep: needs cooking / leaching / a season & tools ──────────────────────
    "quercus":            ("prep",    "Oak (acorns)",      "Gather sound acorns in fall; leach the ground meal in several changes of water to pull the tannins, then use as flour. White-oak group leaches easier.", None),
    "juglans":            ("prep",    "Walnut / butternut","Husk and cure the nuts in fall — the husks stain everything, wear gloves. Butternut (J. cinerea) is milder than black walnut.", None),
    "carya":              ("prep",    "Hickory",           "Shagbark (C. ovata) nuts are sweet — crack and pick; bitternut (C. cordiformis) is too bitter to bother. Bark makes a syrup.", None),
    "fagus":              ("prep",    "Beech",             "Beechnuts in fall are edible in small amounts raw, better roasted; the raw nut skin is mildly bitter/laxative in quantity.", None),
    "prunus":             ("prep",    "Cherry / chokecherry", "Chokecherry & black cherry — cook the ripe fruit for jelly/syrup; astringent raw and the pits are cyanogenic. Never eat the pits.", None),
    "sorbus":             ("prep",    "Rowan",             "Cook the orange berries into a tart jelly after frost — raw they're astringent and mildly upsetting.", None),
    "betula":             ("prep",    "Birch",             "Tap the sap in early spring (boil down for birch syrup) and the aromatic inner bark/twigs for tea. A sap, not a snack.", None),
    "acer saccharum":     ("prep",    "Sugar maple",       "Tap in the Feb–Mar freeze/thaw and boil the sap to syrup — ~40:1. Needs a spile, bucket, and a lot of firewood.", None),
    "acer nigrum":        ("prep",    "Black maple",       "Sugar-maple's twin — tap and boil the sap to syrup exactly the same way.", None),

    # ── caution: edible only with a real catch — dangerous lookalikes / handling ─
    "ginkgo":             ("caution", "Ginkgo",            "Only female trees fruit; the fallen flesh reeks and blisters skin (handle with gloves). The inner nut is edible COOKED and in small amounts only — raw/excess is toxic. Most street ginkgos are fruitless male cultivars.", None),
    "gleditsia":          ("caution", "Honey locust",      "Sweet pulp inside the long twisted pods is edible — but do NOT confuse it with the TOXIC Kentucky coffeetree (thick flat pods) or black locust. Honey locust has fine branching thorns and tiny leaflets.", None),
    "robinia":            ("caution", "Black locust",      "The flowers are edible (fritters); everything else — bark, leaves, pods, seeds — is TOXIC. Take only the blossoms, and be sure it's not a look-alike.", None),

}

# One category (type / food-part) per taxon — the single colour axis on the map,
# keyed like FORAGE (full "genus species" wins over a bare genus). fruit | nuts |
# greens | herbs | mushrooms | other. `caution` (dangerous lookalike / handle-with-
# care) is derived from the FORAGE tier instead of a second colour.
CATEGORY = {
    "malus": "fruit", "amelanchier": "fruit", "celtis": "fruit", "morus": "fruit",
    "crataegus": "fruit", "pyrus": "fruit", "prunus": "fruit", "sorbus": "fruit",
    "quercus": "nuts", "juglans": "nuts", "carya": "nuts", "fagus": "nuts",
    "corylus": "nuts", "ginkgo": "nuts",
    "tilia": "greens",
    "rhus typhina": "herbs", "betula": "herbs", "acer saccharum": "herbs",
    "acer nigrum": "herbs", "robinia": "herbs",
    "gleditsia": "other",
}


def category_for(sci):
    """Map a scientific name to a type category (same key resolution as FORAGE)."""
    s = _norm(sci)
    toks = s.split()
    if len(toks) >= 2 and " ".join(toks[:2]) in CATEGORY:
        return CATEGORY[" ".join(toks[:2])]
    if toks and toks[0] in CATEGORY:
        return CATEGORY[toks[0]]
    return "other"


def _norm(sci):
    return (sci or "").strip().lower()


def match_forage(sci):
    """Return (tier, name, note, slug) for a scientific name, or None."""
    s = _norm(sci)
    if not s:
        return None
    if s in FORAGE:                          # exact, incl. odd cultivar strings
        return FORAGE[s]
    toks = s.split()
    if len(toks) >= 2 and " ".join(toks[:2]) in FORAGE:   # "genus species"
        return FORAGE[" ".join(toks[:2])]
    if toks and toks[0] in FORAGE:           # bare genus
        return FORAGE[toks[0]]
    return None


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "foraging-scout/1.0"})
    return json.load(urllib.request.urlopen(req, timeout=90))


def fetch_rows(bbox):
    """Pull every inventory row inside the bbox with real coordinates."""
    swlat, swlng, nelat, nelng = bbox
    # Guard the ~text~ lat/lon columns against non-numeric junk before ::float.
    sql = (
        f'SELECT "_id","Essence_latin","Essence_fr","Latitude","Longitude",'
        f'"NOM_PARC","Rue","Date_Plantation" FROM "{RESOURCE_ID}" '
        f"WHERE \"Latitude\" ~ '^-?[0-9.]+$' AND \"Longitude\" ~ '^-?[0-9.]+$' "
        f'AND "Latitude"::float BETWEEN {swlat} AND {nelat} '
        f'AND "Longitude"::float BETWEEN {swlng} AND {nelng}'
    )
    url = SQL_URL + "?" + urllib.parse.urlencode({"sql": sql})
    d = get(url)
    if not d.get("success"):
        raise SystemExit("datastore SQL query failed: " + json.dumps(d)[:400])
    return d["result"]["records"]


def thin(feats_by_group, cell_m, cap):
    """Even spatial thinning per forage category: keep ≤1 tree per ~cell, then
    hard-cap. Grouped by the forage display name (all crabapple cultivars share one
    bucket, not one per cultivar) so the cap means what a forager expects.
    Returns (kept_feats, dropped_total). Deterministic (no RNG)."""
    kept, dropped = [], 0
    deg = cell_m / 111_320.0  # rough metres→degrees; fine at this latitude for a grid
    for _group, feats in feats_by_group.items():
        # 1) one representative per grid cell — kills clustered duplicates evenly.
        seen, per_cell = {}, []
        for f in feats:
            lon, lat = f["geometry"]["coordinates"]
            cellkey = (round(lat / deg), round(lon / deg))
            if cellkey not in seen:
                seen[cellkey] = True
                per_cell.append(f)
        # 2) if a species still exceeds the cap, keep an evenly-spaced subset.
        if len(per_cell) > cap:
            step = len(per_cell) / cap
            picked = [per_cell[int(i * step)] for i in range(cap)]
        else:
            picked = per_cell
        dropped += len(feats) - len(picked)
        kept.extend(picked)
    return kept, dropped


def build(bbox, cell_m, cap):
    rows = fetch_rows(bbox)
    by_species = {}          # species -> [feature]
    raw_totals = {}          # display name -> count matched (pre-thin)
    skipped = {}             # dropped genus -> count (curation transparency)
    for r in rows:
        sci = r.get("Essence_latin")
        m = match_forage(sci)
        if not m:
            genus = _norm(sci).split(" ")[0] or "(blank)"
            skipped[genus] = skipped.get(genus, 0) + 1
            continue
        tier, name, note, slug = m
        try:
            lat = round(float(r["Latitude"]), 6)
            lon = round(float(r["Longitude"]), 6)
        except (TypeError, ValueError):
            continue
        where = r.get("NOM_PARC") or r.get("Rue") or None
        planted = (r.get("Date_Plantation") or "")[:4] or None
        # Source-specific display bits go in `meta` (stored as a JSON column on
        # import, re-expanded into the popup); category/caution are the shared axes.
        meta = {}
        if where:
            meta["where"] = where.strip().title() if where.isupper() else where.strip()
        if planted and planted.isdigit():
            meta["planted"] = planted
        props = {
            "name": name, "species": sci, "category": category_for(sci),
            "caution": tier == "caution", "notes": note,
            "source": "montreal", "sourceUrl": DATASET_URL, "meta": meta,
        }
        if slug:
            props["plant"] = slug
        feat = {"type": "Feature", "id": f"mtl{r['_id']}",
                "geometry": {"type": "Point", "coordinates": [lon, lat]},
                "properties": props}
        by_species.setdefault(name, []).append(feat)
        raw_totals[name] = raw_totals.get(name, 0) + 1

    feats, dropped = thin(by_species, cell_m, cap)
    feats.sort(key=lambda f: f["id"])
    return feats, raw_totals, dropped, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("SWLAT", "SWLNG", "NELAT", "NELNG"), required=True)
    ap.add_argument("--name", default="scouting area")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max-per-species", type=int, default=120,
                    help="hard cap on pins per species after grid-thinning (default 120)")
    ap.add_argument("--cell-m", type=float, default=60.0,
                    help="grid cell size in metres for even thinning (default 60)")
    a = ap.parse_args()

    feats, raw_totals, dropped, skipped = build(a.bbox, a.cell_m, a.max_per_species)
    fc = {"type": "FeatureCollection", "name": "montreal-trees",
          "attribution": "Public-tree inventory © Ville de Montréal (donnees.montreal.ca), CC BY 4.0",
          "note": (f"Curated + spatially-thinned public-tree scouting leads for '{a.name}', from the "
                   "Ville de Montréal open-data tree inventory (CC BY 4.0) via "
                   "scripts/montreal-trees-scout.py. A SEPARATE source from the iNaturalist and Falling "
                   "Fruit scouting layers and from foraging-spots.geojson (the source of truth). Species "
                   "is the city's arborist label, but locations may be imprecise/outdated — confirm in "
                   "person before promoting to a real pin."),
          "features": feats}
    with open(a.out, "w") as f:
        json.dump(fc, f, indent=2, ensure_ascii=False)
        f.write("\n")

    by_cat = {}
    for feat in feats:
        c = feat["properties"]["category"]
        by_cat[c] = by_cat.get(c, 0) + 1
    n_caution = sum(1 for f in feats if f["properties"].get("caution"))
    print(f"{len(feats)} pins → {a.out}  (thinned from {sum(raw_totals.values())} forageable; "
          f"{dropped} dropped by cap/grid)", file=sys.stderr)
    print("  by category: " + ", ".join(f"{k}={v}" for k, v in sorted(by_cat.items()))
          + f"  ·  caution flagged: {n_caution}", file=sys.stderr)
    print("  species kept (shown / total in area): " + ", ".join(
        f"{n}={sum(1 for x in feats if x['properties']['name']==n)}/{raw_totals[n]}"
        for n in sorted(raw_totals, key=lambda k: -raw_totals[k])), file=sys.stderr)
    if skipped:
        top = sorted(skipped.items(), key=lambda kv: -kv[1])[:10]
        print("  skipped (non-forage species): " + ", ".join(f"{k}×{v}" for k, v in top), file=sys.stderr)


if __name__ == "__main__":
    main()
