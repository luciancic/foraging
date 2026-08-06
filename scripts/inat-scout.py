#!/usr/bin/env python3
"""Scouting-layer generator: pull iNaturalist research-grade observations inside a
bounding box, keep only species in the curated forage table below, and emit a
GeoJSON of "scouting" pins (unverified leads to go check in person).

This is NOT the source of truth for the map — the SQLite data layer (served via
/api/pins) is. This produces a *separate*, deliberately-distinct layer.

Usage:
  scripts/inat-scout.py --bbox SWLAT SWLNG NELAT NELNG \
      --name "Quai de la Tortue → Parc Desmarchais" \
      --out public/data/scouting-spots.geojson

The forage table (FORAGE) is hand-curated foraging knowledge for the Montréal
urban-edible palette — tier + one-line approach note + optional existing guide
slug. Add rows as you range into new species; iNat only supplies *where*, not
*whether it's edible or how* — that judgment stays here.
"""
import argparse, json, sys, urllib.request, urllib.parse

API = "https://api.inaturalist.org/v1/observations"

# tier vocabulary:
#   snack   — easy ID, eat raw / trivial prep, no dangerous lookalike
#   prep    — edible but must be cooked / processed first
#   caution — edible BUT has a dangerous lookalike; be 100% certain
#   avoid   — toxic; pinned so you learn to recognize & NOT pick it
FORAGE = {
    # snack
    167829: ("snack",   "Staghorn sumac",   "Rhus typhina",          "Steep the red drupe cones in cold water for pink lemonade. No toxic lookalike (poison sumac has white berries, lives in swamps).", "staghorn-sumac"),
    51875:  ("snack",   "Red clover",       "Trifolium pratense",    "Nibble the flower heads or dry for tea. Ubiquitous, safe.", None),
    55745:  ("snack",   "White clover",     "Trifolium repens",      "Flowers & young leaves edible raw; better cooked in quantity.", None),
    52913:  ("snack",   "Chicory",          "Cichorium intybus",     "Young leaves (bitter) in salad; roast the root as a coffee sub. Sky-blue flowers confirm ID.", "chicory"),
    51148:  ("snack",   "Hawthorn",         "Crataegus sp.",         "Eat the red haws off the tree (spit the seeds — don't chew them). Thorns + lobed leaves.", None),
    54431:  ("snack",   "Red currant",      "Ribes rubrum",          "Translucent red berries in hanging clusters, eat raw or jelly.", None),
    54857:  ("snack",   "Common hackberry", "Celtis occidentalis",   "Small sweet date-like drupes on a warty-barked tree; crunch the whole thing.", None),
    56061:  ("snack",   "Garlic mustard",   "Alliaria petiolata",    "Invasive — forage freely. Crush a leaf: garlic smell confirms it. Raw in pesto/salad.", None),
    52992:  ("snack",   "Pineappleweed",    "Matricaria discoidea",  "Cone-shaped flowerheads smell of pineapple when crushed; steep for tea.", None),
    469472: ("snack",   "Apple",            "Malus domestica",       "Wild/feral apples — taste one; many roadside trees fruit well.", "apple"),
    132600: ("snack",   "Little-leaf linden","Tilia cordata",        "Young heart-shaped leaves are a mild salad green; flowers for tea.", "linden"),
    54854:  ("snack",   "Basswood (linden)","Tilia americana",       "Same as little-leaf linden — young leaves edible, flowers for tea.", "linden"),
    # prep
    47911:  ("prep",    "Common milkweed",  "Asclepias syriaca",     "Cook shoots / flower buds / young pods (change water). NOT raw. Young shoots resemble toxic dogbane — milkweed has hairy stem + milky sap.", None),
    54835:  ("prep",    "Chokecherry",      "Prunus virginiana",     "Cook only for jelly/syrup — raw fruit is astringent and the seeds are cyanogenic. Never eat the pits.", None),
    56063:  ("prep",    "Rowan",            "Sorbus aucuparia",      "Cook the orange berries into jelly after first frost; bitter & mildly purgative raw.", "rowan"),
    59571:  ("prep",    "Burdock",          "Arctium sp.",           "Dig first-year taproot (gobo); peel & cook. Big rhubarb-like basal leaves.", None),
    54504:  ("prep",    "Black walnut",     "Juglans nigra",         "Husk & cure the nuts (staining!) in fall. Round green husks under the tree.", None),
    76584:  ("prep",    "Yellow nutsedge",  "Cyperus esculentus",    "Dig the tiny tubers (tigernuts) — sweet, nutty; triangular stem.", None),
    49005:  ("prep",    "Red oak",          "Quercus rubra",         "Acorns need leaching (cold-water, several changes) to remove tannins, then flour.", None),
    54781:  ("prep",    "Bur oak",          "Quercus macrocarpa",    "Big low-tannin acorns; still leach before use.", None),
    52856:  ("prep",    "Mugwort",          "Artemisia vulgaris",    "Bitter aromatic herb — dry young leaves as a poultry seasoning; silver leaf underside.", None),
    # caution — dangerous lookalike, be certain
    76610:  ("caution", "Wild carrot",      "Daucus carota",         "Edible taproot BUT the carrot family has DEADLY lookalikes (poison hemlock, water hemlock). Only forage if 100% certain: hairy stem, carrot smell, single dark central floret. When unsure, don't.", None),
    119936: ("caution", "Riverbank grape",  "Vitis riparia",         "Grapes for jelly, leaves for dolmas. Lookalike: moonseed (toxic) — grapes have tendrils + several seeds; moonseed has one crescent seed & no tendrils.", None),
    52821:  ("caution", "Yarrow",           "Achillea millefolium",  "Feathery leaves for tea/medicinal. Its ferny foliage can be confused with poison hemlock before flowering — confirm the flat white flower clusters + strong scent.", None),
    56077:  ("caution", "St. John's wort",  "Hypericum perforatum",  "Medicinal (not food); photosensitizing and interacts with many meds. Learn it, harvest sparingly.", None),
    55969:  ("caution", "Guelder-rose",     "Viburnum opulus",       "Highbush-cranberry-type fruit — edible cooked, mildly toxic & unpleasant raw. Cook into jelly.", None),
}

# One category (type / food-part) per taxon id — the single colour axis on the map.
# fruit | nuts | greens | herbs | mushrooms | other. `caution` (dangerous lookalike /
# handle-with-care) is derived from the FORAGE tier, not a separate colour.
CATEGORY = {
    167829: "herbs", 51875: "herbs", 55745: "herbs", 52913: "greens", 51148: "fruit",
    54431: "fruit", 54857: "fruit", 56061: "greens", 52992: "herbs", 469472: "fruit",
    132600: "greens", 54854: "greens", 47911: "greens", 54835: "fruit", 56063: "fruit",
    59571: "greens", 54504: "nuts", 76584: "nuts", 49005: "nuts", 54781: "nuts",
    52856: "herbs", 76610: "greens", 119936: "fruit", 52821: "herbs", 56077: "herbs",
    55969: "fruit",
}


def fetch(bbox, per_species_cap):
    swlat, swlng, nelat, nelng = bbox
    taxa = ",".join(str(t) for t in FORAGE)
    q = urllib.parse.urlencode({
        "taxon_id": taxa, "swlat": swlat, "swlng": swlng, "nelat": nelat, "nelng": nelng,
        "quality_grade": "research", "geo": "true", "per_page": 200, "order_by": "observed_on",
        # Exclude cultivated/planted observations — these are overwhelmingly the
        # "growing in someone's private garden / yard" pins we don't want to point
        # foragers at. Wild specimens only.
        "captive": "false",
    })
    req = urllib.request.Request(f"{API}?{q}", headers={"User-Agent": "foraging-scout/1.0"})
    data = json.load(urllib.request.urlopen(req, timeout=30))
    counts, feats = {}, []
    for o in data["results"]:
        taxon = o.get("taxon") or {}
        # match on the observed taxon or its ancestry (obs may be at species/subspecies level)
        tid = next((a for a in [taxon.get("id")] + (taxon.get("ancestor_ids") or []) if a in FORAGE), None)
        if tid is None:
            continue
        if not o.get("geojson"):
            continue
        if counts.get(tid, 0) >= per_species_cap:
            continue
        counts[tid] = counts.get(tid, 0) + 1
        tier, common, sci, blurb, slug = FORAGE[tid]
        lon, lat = o["geojson"]["coordinates"]
        obscured = o.get("obscured") or o.get("geoprivacy") == "obscured"
        # Source-specific display bits go in `meta` (stored as a JSON column on
        # import, re-expanded into the popup); category/caution are the shared axes.
        meta = {"observed": o.get("observed_on"), "observer": (o.get("user") or {}).get("login")}
        if obscured:
            meta["obscured"] = True
        props = {
            "name": common, "species": sci, "category": CATEGORY.get(tid, "other"),
            "caution": tier == "caution", "notes": blurb, "source": "inat",
            "sourceUrl": f"https://www.inaturalist.org/observations/{o['id']}", "meta": meta,
        }
        if slug:
            props["plant"] = slug
        feats.append({"type": "Feature", "id": o["id"],
                      "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]},
                      "properties": props})
    return feats, counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("SWLAT", "SWLNG", "NELAT", "NELNG"), required=True)
    ap.add_argument("--name", default="scouting area")
    ap.add_argument("--cap", type=int, default=8, help="max pins per species")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    feats, counts = fetch(a.bbox, a.cap)
    fc = {"type": "FeatureCollection", "name": "scouting-spots",
          "note": (f"UNVERIFIED scouting leads for '{a.name}', generated from iNaturalist "
                   "research-grade observations by scripts/inat-scout.py. NOT the source of "
                   "truth — that is the SQLite DB. Each pin is a lead to go confirm in "
                   "person; once confirmed, promote it into a real pin via POST /api/pins."),
          "features": feats}
    with open(a.out, "w") as f:
        json.dump(fc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    by_cat = {}
    for feat in feats:
        c = feat["properties"]["category"]
        by_cat[c] = by_cat.get(c, 0) + 1
    n_caution = sum(1 for f in feats if f["properties"].get("caution"))
    print(f"{len(feats)} pins → {a.out}", file=sys.stderr)
    print("  by category: " + ", ".join(f"{k}={v}" for k, v in sorted(by_cat.items()))
          + f"  ·  caution flagged: {n_caution}", file=sys.stderr)
    print(f"  species: {len(counts)}", file=sys.stderr)


if __name__ == "__main__":
    main()
