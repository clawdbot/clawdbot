#!/usr/bin/env python3

import json
from pathlib import Path

DATA = Path("/mnt/ai-storage/ranchbrain")
ASSETS = DATA / "assets"

items = []

for f in ASSETS.rglob("*.json"):
    if f.name == "asset.schema.json":
        continue
    try:
        data = json.loads(f.read_text())
        items.append((
            data.get("category", ""),
            data.get("manufacturer", ""),
            data.get("name", ""),
            data.get("asset_id", ""),
            data.get("location", ""),
            str(f.relative_to(DATA))
        ))
    except Exception as e:
        items.append(("ERROR", "", f.name, "", str(e), str(f.relative_to(DATA))))

for category, manufacturer, name, asset_id, location, path in sorted(items):
    print(f"{category:12} | {manufacturer:12} | {name:24} | {asset_id:28} | {location}")
