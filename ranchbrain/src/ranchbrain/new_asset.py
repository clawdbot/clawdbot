#!/usr/bin/env python3

import json
import re
import sys
import uuid
from datetime import datetime
from pathlib import Path

DATA = Path("/mnt/ai-storage/ranchbrain")

def slug(text):
    text = text.strip().replace("&", "and")
    text = re.sub(r"[^A-Za-z0-9]+", "-", text)
    return text.strip("-")

def prompt(label, default=""):
    value = input(f"{label}{' [' + default + ']' if default else ''}: ").strip()
    return value or default

def next_asset_id(category, manufacturer, name):
    prefix = {
        "Equipment": "EQ",
        "Vehicles": "VEH",
        "Home": "HOME",
        "Smart-Home": "SMART",
        "Computers": "COMP",
        "Property": "PROP",
        "Shop": "SHOP",
        "Garden": "GARDEN",
        "Livestock": "LIVE",
        "People": "PERSON",
    }.get(category, "ASSET")

    m = slug(manufacturer).upper()[:6] or "GEN"
    n = slug(name).upper()[:12] or "ITEM"
    return f"{prefix}-{m}-{n}-001"

def main():
    print("RanchBrain Asset Creator")
    print("------------------------")

    name = prompt("Asset name")
    if not name:
        print("Asset name is required.")
        sys.exit(1)

    category = prompt("Category", "Equipment")
    manufacturer = prompt("Manufacturer")
    model = prompt("Model")
    subcategory = prompt("Subcategory")
    location = prompt("Location", "RedBud Ranch")
    description = prompt("Short description")

    asset_id = next_asset_id(category, manufacturer, name)
    guid = str(uuid.uuid4())

    category_slug = slug(category)
    manufacturer_slug = slug(manufacturer or "General")
    asset_slug = slug(name)

    asset_dir = DATA / "assets" / category_slug / manufacturer_slug
    manual_folder = DATA / "manuals" / manufacturer_slug / asset_slug
    photo_folder = DATA / "photos" / category_slug / manufacturer_slug / asset_slug
    receipt_folder = DATA / "receipts" / category_slug / manufacturer_slug / asset_slug

    asset_dir.mkdir(parents=True, exist_ok=True)
    manual_folder.mkdir(parents=True, exist_ok=True)
    photo_folder.mkdir(parents=True, exist_ok=True)
    receipt_folder.mkdir(parents=True, exist_ok=True)

    asset_file = asset_dir / f"{asset_slug}.json"

    if asset_file.exists():
        print(f"Asset already exists: {asset_file}")
        sys.exit(1)

    now = datetime.now().strftime("%Y-%m-%d")

    asset = {
        "asset_id": asset_id,
        "guid": guid,
        "name": name,
        "category": category,
        "subcategory": subcategory,
        "manufacturer": manufacturer,
        "model": model,
        "serial_number": "",
        "description": description,
        "status": "Active",
        "location": location,
        "purchase_date": "",
        "purchase_price": "",
        "warranty_until": "",
        "manual_folder": str(manual_folder.relative_to(DATA)),
        "photo_folder": str(photo_folder.relative_to(DATA)),
        "receipt_folder": str(receipt_folder.relative_to(DATA)),
        "propertymanager_asset_id": asset_id,
        "home_assistant_entity_id": "",
        "preferred_vendor": "",
        "preferred_vendor_url": "",
        "support_url": "",
        "source_url": "",
        "purchase_url": "",
        "manuals": [],
        "photos": [],
        "receipts": [],
        "videos": [],
        "parts": [],
        "maintenance_tasks": [],
        "related_assets": [],
        "family_notes": "",
        "maintenance_notes": "",
        "emergency_notes": "",
        "tags": [
            manufacturer.lower() if manufacturer else "",
            name.lower(),
            category.lower()
        ],
        "created_at": now,
        "updated_at": now
    }

    asset["tags"] = [t for t in asset["tags"] if t]

    asset_file.write_text(json.dumps(asset, indent=2) + "\n")

    print()
    print("✅ Asset created")
    print(f"Asset file: {asset_file}")
    print(f"Asset ID:   {asset_id}")
    print(f"GUID:       {guid}")
    print(f"Manuals:    {manual_folder}")
    print(f"Photos:     {photo_folder}")
    print(f"Receipts:   {receipt_folder}")

if __name__ == "__main__":
    main()
