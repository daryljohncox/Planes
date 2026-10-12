#!/usr/bin/env python3
"""Rebuild airports.json from OurAirports (public domain, https://ourairports.com/data/).

Usage: python3 tools/build-airports.py path/to/airports.csv > airports.json

Keeps every large and medium airport worldwide, plus small airfields in NZ and Australia.
Each entry: [code, name, lat, lon, elevation_ft, tier]  (tier 1 = large, 2 = medium, 3 = small)
"""
import csv, json, sys

SMALL_COUNTRIES = {"NZ", "AU"}
TIER = {"large_airport": 1, "medium_airport": 2, "small_airport": 3}

out = []
for r in csv.DictReader(open(sys.argv[1], encoding="utf-8")):
    t = TIER.get(r["type"])
    if not t or (t == 3 and r["iso_country"] not in SMALL_COUNTRIES):
        continue
    code = r["iata_code"] or r["icao_code"] or r["gps_code"] or r["ident"]
    elev = int(float(r["elevation_ft"])) if r["elevation_ft"] else 0
    out.append([code, r["name"], round(float(r["latitude_deg"]), 4), round(float(r["longitude_deg"]), 4), elev, t])
json.dump(out, sys.stdout, ensure_ascii=False, separators=(",", ":"))
