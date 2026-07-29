#!/usr/bin/env python3

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

DATA = Path("/mnt/ai-storage/ranchbrain")
ASSETS = DATA / "assets"
API_BASE = os.environ.get("PROPERTYMANAGER_API_BASE", "http://127.0.0.1:5062")


def fetch_pm_asset(external_id: str) -> dict | None:
    url = f"{API_BASE.rstrip('/')}/assets/by-external-id/{external_id}"
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
        return None


def format_meter_section(pm: dict) -> str:
    meter = pm.get("meter") or {}
    if meter.get("meter_type") == "none":
        return ""
    unit = meter.get("unit") or ""
    current = meter.get("current_value")
    lines = ["", "PropertyManager meter:", f"  Current: {current} {unit}".strip()]
    for task in (pm.get("tasks") or [])[:8]:
        item = task.get("item") or "Service"
        remaining = task.get("remaining_meter")
        if remaining is None:
            continue
        if task.get("overdue_meter"):
            lines.append(f"  • {item}: OVERDUE")
        else:
            lines.append(f"  • {item}: {remaining:.1f} {unit} remaining")
    return "\n".join(lines)


query = " ".join(sys.argv[1:]).lower().strip()

if not query:
    print('Usage: show_asset.py "asset name or asset id"')
    sys.exit(1)

# Meter update subcommand: show_asset.py meter EQ-XXX 127.4
if query.startswith("meter "):
    parts = query.split()
    if len(parts) < 3:
        print('Usage: show_asset.py meter "asset id" 127.4')
        sys.exit(1)
    asset_hint = parts[1]
    try:
        value = float(parts[2])
    except ValueError:
        print("Value must be a number")
        sys.exit(1)
    script = Path(__file__).resolve().parents[3] / "tools/property_manager/propertymanager-meter.py"
    import subprocess

    raise SystemExit(subprocess.call([sys.executable, str(script), f"{asset_hint} {value} hours"]))

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

external_id = data.get("asset_id") or data.get("propertymanager_asset_id") or ""
if external_id:
    pm = fetch_pm_asset(external_id)
    if pm:
        print(format_meter_section(pm))
    else:
        print("\nPropertyManager: (no Postgres asset record yet)")
