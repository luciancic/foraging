#!/usr/bin/env python3
"""Falling Fruit scouting-layer generator: pull community-submitted edible-plant
locations inside a bounding box from the Falling Fruit API and emit a GeoJSON of
scouting pins — a SEPARATE source/class from the iNaturalist layer.

Falling Fruit data is CC BY-NC-SA: non-commercial use is fine (this is a personal
site) but attribution is required — the map credits Falling Fruit and each pin
links back to its source location page. https://fallingfruit.org

Like inat-scout.py this is NOT the source of truth (foraging-spots.geojson is);
it's unverified leads to go confirm in person.

Usage:
  scripts/fallingfruit-scout.py --bbox SWLAT SWLNG NELAT NELNG \
      --name "Verdun" --out public/data/falling-fruit.geojson

FORAGE maps Falling Fruit taxa (matched by scientific name, species then genus)
to our tier vocabulary + a how-to note + optional existing guide slug. Falling
Fruit types are often genus-level, so genus keys do most of the work. Types with
no scientific-name match (e.g. the "Dumpster (edible)" freegan class) are skipped
— this is a plant-foraging map. Extend FORAGE when ranging into new species.
"""
import argparse, json, sys, urllib.request, urllib.parse

API = "https://fallingfruit.org/api/0.3"
# Production read key, published in Falling Fruit's own open-source web-app setup
# docs (REACT_APP_API_KEY). Read-only use.
API_KEY = "AKDJGHSD"
FF_LOC_URL = "https://fallingfruit.org/locations/{id}"

# tier vocabulary matches inat-scout.py:
#   snack / prep / caution (dangerous lookalike) / avoid (toxic — pinned to learn)
# Keyed by lowercase scientific name; a full "genus species" key wins over a bare
# "genus" key. (tier, display name, how-to note, guide slug or None)
FORAGE = {
    "malus":                 ("snack",   "Apple / crabapple", "Wild & feral apples/crabapples — taste one; cook the sour crabapples into jelly.", "apple"),
    "amelanchier":           ("snack",   "Serviceberry",      "Sweet blueberry-like pomes in early summer — eat raw off the branch.", "serviceberry"),
    "fragaria":              ("snack",   "Wild strawberry",   "Tiny, intense berries; safe and easy. (Bland mock-strawberry is harmless too.)", None),
    "rubus parviflorus":     ("snack",   "Thimbleberry",      "Soft red raspberry-like fruit — eat raw.", None),
    "rubus":                 ("snack",   "Bramble berry",     "Raspberries/blackberries — eat raw when fully coloured and they pull free easily.", None),
    "morus":                 ("snack",   "Mulberry",          "Ripe near-black berries eat raw; unripe/white ones can upset the stomach.", "mulberry"),
    "ribes":                 ("snack",   "Currant / gooseberry", "Berries edible raw or cooked.", None),
    "crataegus":             ("snack",   "Hawthorn",          "Red haws off the tree — spit the seeds.", None),
    "tilia":                 ("snack",   "Linden",            "Young heart-shaped leaves are a mild salad green; flowers for tea.", "linden"),
    "rhus typhina":          ("snack",   "Staghorn sumac",    "Steep the red drupe cones in cold water for pink lemonade.", "staghorn-sumac"),
    "matricaria discoidea":  ("snack",   "Pineappleweed",     "Pineapple-scented flowerheads — steep for tea.", None),
    "rosa":                  ("snack",   "Rose (hips)",       "Rosehips after frost for tea/syrup; strain out the irritating seed hairs.", None),
    "vaccinium":             ("snack",   "Blueberry/cranberry", "Eat the berries raw.", None),
    "prunus virginiana":     ("prep",    "Chokecherry",       "Cook only for jelly/syrup — astringent raw and the seeds are cyanogenic. Never eat the pits.", None),
    "prunus":                ("prep",    "Wild cherry/plum",  "Flesh edible when ripe; never eat the cyanogenic pits/seeds. Many are best cooked.", None),
    "sambucus":              ("prep",    "Elderberry",        "Cook the ripe blue-black berries (and elderflowers). Raw berries/stems are mildly toxic; red elder is a different, riskier species.", "elderberry"),
    "urtica":                ("prep",    "Stinging nettle",   "Wear gloves; cook or blanch the young tops to kill the sting. Excellent cooked green.", None),
    "juglans":               ("prep",    "Walnut",            "Husk and cure the nuts in fall (the husks stain everything).", None),
    "castanea":              ("prep",    "Sweet chestnut",    "Roast or boil the nuts — spiny burr, unlike the toxic horse-chestnut.", None),
    "quercus":               ("prep",    "Oak (acorns)",      "Leach acorns in several changes of water to remove tannins, then use as flour.", None),
    "vitis":                 ("caution", "Grape",             "Grapes + young leaves edible. Moonseed is a toxic lookalike — grapes have tendrils and several seeds; moonseed has one crescent seed and no tendrils.", None),
    "allium":                ("caution", "Wild onion / garlic", "Edible ONLY if it smells of onion/garlic — no smell means a toxic lookalike (e.g. death camas). Confirm the smell.", None),
    "hypericum":             ("caution", "St. John's wort",   "Medicinal, not a food; photosensitizing and interacts with many meds. Learn it, harvest sparingly.", None),
    "aesculus":              ("avoid",   "Horse-chestnut",    "TOXIC — this is NOT the edible sweet chestnut (Castanea). Do not eat the conkers.", None),
}


def _norm(sci):
    return (sci or "").strip().lower()


def match_forage(scientific_names):
    """Return (tier, name, note, slug) for the first taxon that maps, or None."""
    for sci in scientific_names or []:
        s = _norm(sci)
        if not s:
            continue
        if s in FORAGE:                       # exact "genus species"
            return FORAGE[s]
        genus = s.split(" ")[0]
        if genus in FORAGE:                   # fall back to genus
            return FORAGE[genus]
    return None


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "foraging-scout/1.0"})
    return json.load(urllib.request.urlopen(req, timeout=45))


def fetch(bbox):
    swlat, swlng, nelat, nelng = bbox
    bounds = f"{swlat},{swlng}|{nelat},{nelng}"
    locs = get(f"{API}/locations?" + urllib.parse.urlencode({
        "bounds": bounds, "muni": "true", "limit": 3000, "api_key": API_KEY,
    }))
    types = {t["id"]: t for t in get(f"{API}/types?" + urllib.parse.urlencode({"api_key": API_KEY}))}

    feats, skipped = [], {}
    for loc in locs:
        # a location can carry several type ids; use the first that maps to a
        # known edible (skip dumpsters / uncurated types).
        hit = None
        for tid in loc.get("type_ids") or []:
            t = types.get(tid)
            if not t:
                continue
            m = match_forage(t.get("scientific_names"))
            if m:
                hit = (t, m)
                break
        if not hit:
            for tid in loc.get("type_ids") or []:
                nm = ((types.get(tid) or {}).get("common_names") or {}).get("en") or []
                label = (nm[0] if nm else f"type {tid}")
                skipped[label] = skipped.get(label, 0) + 1
            continue
        t, (tier, name, note, slug) = hit
        sci = (t.get("scientific_names") or [None])[0]
        props = {
            "name": name, "species": sci, "tier": tier, "notes": note,
            "source": "fallingfruit", "ff": FF_LOC_URL.format(id=loc["id"]),
        }
        if slug:
            props["plant"] = slug
        feats.append({"type": "Feature", "id": f"ff{loc['id']}",
                      "geometry": {"type": "Point", "coordinates": [round(loc["lng"], 6), round(loc["lat"], 6)]},
                      "properties": props})
    return feats, skipped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("SWLAT", "SWLNG", "NELAT", "NELNG"), required=True)
    ap.add_argument("--name", default="scouting area")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    feats, skipped = fetch(a.bbox)
    fc = {"type": "FeatureCollection", "name": "falling-fruit",
          "attribution": "Locations from Falling Fruit (fallingfruit.org), CC BY-NC-SA",
          "note": (f"UNVERIFIED community scouting leads for '{a.name}', from the Falling Fruit "
                   "API (CC BY-NC-SA) via scripts/fallingfruit-scout.py. A SEPARATE source from "
                   "the iNaturalist scouting layer and from foraging-spots.geojson (the source of "
                   "truth). Confirm in person before promoting to a real pin."),
          "features": feats}
    with open(a.out, "w") as f:
        json.dump(fc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    by_tier = {}
    for feat in feats:
        by_tier[feat["properties"]["tier"]] = by_tier.get(feat["properties"]["tier"], 0) + 1
    print(f"{len(feats)} pins → {a.out}", file=sys.stderr)
    print("  by tier: " + ", ".join(f"{k}={v}" for k, v in sorted(by_tier.items())), file=sys.stderr)
    if skipped:
        top = sorted(skipped.items(), key=lambda kv: -kv[1])[:12]
        print("  skipped (uncurated/non-plant): " + ", ".join(f"{k}×{v}" for k, v in top), file=sys.stderr)


if __name__ == "__main__":
    main()
