#!/usr/bin/env python3
"""Build towns.json (NZ town names for spoken announcements) from GeoNames data.

Source: cities.json from the npm package "cities.json" (GeoNames cities1000).
  python3 tools/build-towns.py path/to/cities.json > towns.json
Output: [[name, lat, lon], ...]
Suburbs (anything within SUBURB_KM of a city centre) are dropped so we say
"Palmerston North", not "Awapuni". GeoNames misses some small Manawatu /
Rangitikei towns, so EXTRA adds them (approximate centres).
"""
import json, math, sys

SUBURB_KM = 6
# City centres (GeoNames, population >= 20,000)
CITIES = [
    ("Wellington", -41.28664, 174.77557), ("Whanganui", -39.93333, 175.05), ("Timaru", -44.39672, 171.25364),
    ("Taupo", -38.68333, 176.08333), ("Pukekohe", -37.2, 174.95), ("Porirua", -41.13333, 174.85),
    ("Paraparaumu", -40.91667, 175.01667), ("Palmerston North", -40.35636, 175.61113), ("New Plymouth", -39.06667, 174.08333),
    ("Nelson", -41.27078, 173.28404), ("Napier", -39.4926, 176.91233), ("Lower Hutt", -41.21667, 174.91667),
    ("Invercargill", -46.4, 168.35), ("Hastings", -39.6381, 176.84918), ("Hamilton", -37.78333, 175.28333),
    ("Dunedin", -45.87416, 170.50361), ("Christchurch", -43.53333, 172.63333), ("Auckland", -36.84853, 174.76349),
    ("Gisborne", -38.65333, 178.00417), ("Masterton", -40.95972, 175.6575), ("Tauranga", -37.68611, 176.16667),
    ("Papakura", -37.06573, 174.94393), ("Ashburton", -43.89834, 171.73011), ("Whangarei", -35.73167, 174.32391),
    ("Rotorua", -38.13874, 176.24516), ("Blenheim", -41.51603, 173.9528), ("Upper Hutt", -41.13827, 175.0502),
]
# Auckland is a sprawl of suburbs; keep only these main names inside it
AUCKLAND_KM = 25
EXTRA = [
    ("Feilding", -40.2250, 175.5660), ("Sanson", -40.2190, 175.4240), ("Hunterville", -39.9360, 175.5690),
    ("Ratana", -39.9990, 175.1720), ("Halcombe", -40.1500, 175.5000), ("Rongotea", -40.2920, 175.4250),
    ("Himatangi", -40.3960, 175.3110), ("Turakina", -40.0420, 175.2130), ("Mangaweka", -39.8090, 175.7880),
    ("Kimbolton", -40.0560, 175.7790), ("Ohakea", -40.2060, 175.3880), ("Tangimoana", -40.3020, 175.2550),
    ("Cheltenham", -40.1630, 175.6550), ("Apiti", -39.9700, 175.8800), ("Waiouru", -39.4770, 175.6690),
    ("Santoft", -40.1350, 175.2400), ("Kakariki", -40.1340, 175.4720),
]

def km(a, b, c, d):
    p = math.pi / 180
    x = (d - b) * p * math.cos((a + c) / 2 * p)
    return 6371 * math.hypot(x, (c - a) * p)

rows = [c for c in json.load(open(sys.argv[1])) if c["country"] == "NZ"]
out = {name: (lat, lon) for name, lat, lon in CITIES}
for c in rows:
    name, lat, lon = c["name"], float(c["lat"]), float(c["lng"])
    if name in out or name == "Wanganui":
        continue
    if km(lat, lon, -36.84853, 174.76349) < AUCKLAND_KM:
        continue
    if any(km(lat, lon, cl, co) < SUBURB_KM for _, cl, co in CITIES):
        continue
    out[name] = (lat, lon)
for name, lat, lon in EXTRA:
    out[name] = (lat, lon)
print(json.dumps([[n, round(la, 4), round(lo, 4)] for n, (la, lo) in sorted(out.items())], separators=(",", ":")))
