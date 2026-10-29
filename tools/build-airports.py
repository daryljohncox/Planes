#!/usr/bin/env python3
"""Rebuild airports.json from OurAirports (public domain, https://ourairports.com/data/).

Usage: python3 tools/build-airports.py path/to/airports.csv [path/to/runways.csv] > airports.json

Keeps every large and medium airport worldwide, plus small airfields in NZ and Australia.
Each entry: [code, name, lat, lon, elevation_ft, tier, [runway headings]]  (tier 1 = large, 2 = medium, 3 = small)
Runway headings are degrees true, one per runway end, so 03/21 gives [28, 208]; the list is left out without runways.csv.
"""
import csv, json, re, sys

SMALL_COUNTRIES = {"NZ", "AU"}
TIER = {"large_airport": 1, "medium_airport": 2, "small_airport": 3}

# runway end headings by airport ident; falls back to the runway number (03 = 30 degrees) when the file has none
runways = {}
if len(sys.argv) > 2:
    for r in csv.DictReader(open(sys.argv[2], encoding="utf-8")):
        if r["closed"] == "1":
            continue
        for end in ("le", "he"):
            ident, hdg = r[end + "_ident"], r[end + "_heading_degT"]
            m = re.match(r"(\d\d)", ident)
            if hdg:
                h = float(hdg)
            elif m:
                h = int(m.group(1)) * 10
            else:
                continue
            runways.setdefault(r["airport_ident"], set()).add(round(h) % 360)

out = []
for r in csv.DictReader(open(sys.argv[1], encoding="utf-8")):
    t = TIER.get(r["type"])
    if not t or (t == 3 and r["iso_country"] not in SMALL_COUNTRIES):
        continue
    code = r["iata_code"] or r["icao_code"] or r["gps_code"] or r["ident"]
    elev = int(float(r["elevation_ft"])) if r["elevation_ft"] else 0
    row = [code, r["name"], round(float(r["latitude_deg"]), 4), round(float(r["longitude_deg"]), 4), elev, t]
    if runways.get(r["ident"]):
        row.append(sorted(runways[r["ident"]]))
    out.append(row)
json.dump(out, sys.stdout, ensure_ascii=False, separators=(",", ":"))
