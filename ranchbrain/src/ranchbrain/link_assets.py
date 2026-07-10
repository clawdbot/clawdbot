#!/usr/bin/env python3

import json
import sys
from pathlib import Path

DATA = Path("/mnt/ai-storage/ranchbrain/assets")

if len(sys.argv) != 3:
    print("Usage:")
    print("  link_assets.py <parent asset id> <child asset id>")
    sys.exit(1)

parent_id = sys.argv[1]
child_id = sys.argv[2]

parent = None
child = None

for f in DATA.rglob("*.json"):
    if f.name == "asset.schema.json":
        continue

    data = json.loads(f.read_text())

    if data.get("asset_id") == parent_id:
        parent = (f, data)

    if data.get("asset_id") == child_id:
        child = (f, data)

if not parent:
    print("Parent asset not found.")
    sys.exit(1)

if not child:
    print("Child asset not found.")
    sys.exit(1)

pf, pdata = parent
cf, cdata = child

if child_id not in pdata["related_assets"]:
    pdata["related_assets"].append(child_id)

if parent_id not in cdata["related_assets"]:
    cdata["related_assets"].append(parent_id)

pf.write_text(json.dumps(pdata, indent=2) + "\n")
cf.write_text(json.dumps(cdata, indent=2) + "\n")

print("Linked:")
print(f"{pdata['name']}  <-->  {cdata['name']}")
