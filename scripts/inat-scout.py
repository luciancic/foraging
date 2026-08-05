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
    # avoid — toxic; pinned to learn & steer clear
    59778:  ("avoid",   "Wild parsnip",     "Pastinaca sativa",      "DO NOT TOUCH bare-skinned — sap + sunlight causes burning blisters (phytophotodermatitis). Yellow flat flower umbels, celery-like ridged stem.", None),
    54811:  ("avoid",   "Common buckthorn", "Rhamnus cathartica",    "Black berries are a violent purgative — toxic. Learn it: thorn-tipped twigs, 3-5 curved leaf veins. Do not eat.", None),
    55972:  ("avoid",   "Alder buckthorn",  "Frangula alnus",        "Toxic laxative berries (red→black). Do not eat.", None),
    55620:  ("avoid",   "Bittersweet nightshade","Solanum dulcamara","Red egg-shaped berries + purple/yellow flowers — toxic. Do not eat.", None),
    124544: ("avoid",   "Cow parsley",      "Anthriscus sylvestris", "White umbel — the family that includes deadly poison hemlock. Not worth the risk; learn it as a 'do-not-touch' benchmark.", None),
    47779:  ("avoid",   "Yellow iris",      "Iris pseudacorus",      "Waterside yellow flag — all parts toxic/irritant. Do not forage.", None),
}

TIER_LABEL = {"snack": "Snackable", "prep": "Needs prep", "caution": "Caution — lookalike", "avoid": "Toxic — avoid"}


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
        props = {
            "name": common, "species": sci, "tier": tier, "notes": blurb,
            "source": "inat", "inat": f"https://www.inaturalist.org/observations/{o['id']}",
            "observed": o.get("observed_on"), "observer": (o.get("user") or {}).get("login"),
            "obscured": bool(obscured),
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
    by_tier = {}
    for feat in feats:
        by_tier[feat["properties"]["tier"]] = by_tier.get(feat["properties"]["tier"], 0) + 1
    print(f"{len(feats)} pins → {a.out}", file=sys.stderr)
    print("  by tier: " + ", ".join(f"{k}={v}" for k, v in sorted(by_tier.items())), file=sys.stderr)
    print(f"  species: {len(counts)}", file=sys.stderr)


if __name__ == "__main__":
    main()
