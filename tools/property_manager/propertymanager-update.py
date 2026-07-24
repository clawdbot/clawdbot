#!/usr/bin/env python3

from pathlib import Path
from datetime import datetime
import csv
import sys

BASE = Path.home() / "ai/projects/openclaw"
DB = BASE / "tools/property_manager/maintenance_log.csv"

COMMANDS = {
    "pool water test done": ("Pool", "Water test"),
    "pool filter done": ("Pool", "Filter/backwash check"),
    "pool backwash done": ("Pool", "Filter/backwash check"),
    "pool skimmer cleaned": ("Pool", "Skimmer basket clean"),
    "pool shock done": ("Pool", "Shock treatment"),

    "hot tub water test done": ("Hot Tub", "Water test"),
    "hot tub filter cleaned": ("Hot Tub", "Filter cleaning"),
    "hot tub shock done": ("Hot Tub", "Shock treatment"),
    "hot tub shocked": ("Hot Tub", "Shock treatment"),
    "hot tub drained": ("Hot Tub", "Drain and refill"),

    "tractor inspection done": ("Tractor", "Inspection"),
    "tractor oil changed": ("Tractor", "Oil change"),
    "tractor tire pressure done": ("Tractor", "Tire pressure check"),
    "tractor hydraulic fluid checked": ("Tractor", "Hydraulic fluid check"),
    "tractor hydraulic fluid changed": ("Tractor", "Hydraulic fluid change"),
    "tractor belt checked": ("Tractor", "Belt check"),
    "bucket grease done": ("Tractor", "Grease fittings on bucket"),
    "wheel grease done": ("Tractor", "Grease fittings on wheels"),
    "under tractor grease done": ("Tractor", "Grease fittings underneath"),
}

cmd = " ".join(sys.argv[1:]).strip().lower()

if not cmd:
    print("Usage: propertymanager-update.py '<command>'")
    sys.exit(1)

if cmd not in COMMANDS:
    print("Unknown PropertyManager command.")
    print("")
    print("Available commands:")
    for c in sorted(COMMANDS):
        print(f"• {c}")
    sys.exit(1)

area, item = COMMANDS[cmd]
today = datetime.now().strftime("%Y-%m-%d")

rows = []
updated = False

with DB.open(newline="") as f:
    reader = csv.DictReader(f)
    fieldnames = reader.fieldnames
    for row in reader:
        if row.get("area") == area and row.get("item") == item:
            row["last_done"] = today
            updated = True
        rows.append(row)

if not updated:
    print(f"Could not find maintenance item: {area} / {item}")
    sys.exit(1)

backup = DB.with_name(f"maintenance_log.csv.before-update-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
backup.write_text(DB.read_text())

with DB.open("w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows)

print("✅ PropertyManager updated")
print(f"Area: {area}")
print(f"Item: {item}")
print(f"Last done: {today}")
