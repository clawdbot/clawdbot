#!/usr/bin/env python3

import json
import sys
from pathlib import Path

DATA = Path("/mnt/ai-storage/ranchbrain")
ASSETS = DATA / "assets"

query = " ".join(sys.argv[1:]).lower().strip()

if not query:
    print('Usage: show_asset.py "asset name or asset id"')
    sys.exit(1)

matches = []

for f in ASSETS.rglob("*.json"):
    if f.name == "asset.schema.json":
        continue

    data = json.loads(f.read_text())
    haystack = " ".join([
        data.get("asset_id", ""),
        data.get("name", ""),
        data.get("manufacturer", ""),
        data.get("model", "")
    ]).lower()

    if query in haystack:
        matches.append((f, data))

if not matches:
    print(f"No asset found for: {query}")
    sys.exit(1)

f, data = matches[0]

print(f"Asset: {data.get('name','')}")
print(f"ID: {data.get('asset_id','')}")
print(f"Manufacturer: {data.get('manufacturer','')}")
print(f"Model: {data.get('model','')}")
print(f"Category: {data.get('category','')}")
print(f"Subcategory: {data.get('subcategory','')}")
print(f"Location: {data.get('location','')}")
print(f"Status: {data.get('status','')}")
print()
print(f"Description: {data.get('description','')}")
print()
print("Folders:")
print(f"  Manuals:  {data.get('manual_folder','')}")
print(f"  Photos:   {data.get('photo_folder','')}")
print(f"  Receipts: {data.get('receipt_folder','')}")
print()
print(f"Source: {f.relative_to(DATA)}")
