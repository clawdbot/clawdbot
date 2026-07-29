#!/usr/bin/env python3
"""Submit a meter reading via PropertyManager API (Telegram/RanchBrain helper)."""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from difflib import SequenceMatcher

API_BASE = os.environ.get("PROPERTYMANAGER_API_BASE", "http://127.0.0.1:5062")

METER_PATTERN = re.compile(
    r"(?P<value>\d+(?:\.\d+)?)\s*(?P<unit>hours?|hrs?|miles?|mi|cycles?)?",
    re.IGNORECASE,
)


def api_get(path: str) -> dict | list:
    with urllib.request.urlopen(API_BASE.rstrip("/") + path, timeout=20) as resp:
        return json.loads(resp.read().decode())


def api_post(path: str, body: dict) -> tuple[int, dict]:
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        API_BASE.rstrip("/") + path,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        payload = json.loads(exc.read().decode())
        return exc.code, payload


def parse_meter_command(text: str) -> tuple[str, float] | None:
    """Return (asset_hint, value) from natural language."""
    match = METER_PATTERN.search(text)
    if not match:
        return None
    value = float(match.group("value"))
    hint = METER_PATTERN.sub("", text).strip()
    hint = re.sub(r"\b(now has|hours|hrs|miles|mi|cycles|meter|reading)\b", "", hint, flags=re.I).strip()
    if not hint:
        return None
    return hint, value


def find_asset(hint: str) -> dict | None:
    assets = api_get("/assets")
    if not isinstance(assets, list):
        return None
    hint_lower = hint.lower()
    best = None
    best_score = 0.0
    for asset in assets:
        names = [str(asset.get("name") or "")]
        aliases = asset.get("aliases") or []
        if isinstance(aliases, list):
            names.extend(str(a) for a in aliases)
        names.append(str(asset.get("external_id") or ""))
        for name in names:
            if not name:
                continue
            score = 1.0 if name.lower() in hint_lower or hint_lower in name.lower() else SequenceMatcher(None, name.lower(), hint_lower).ratio()
            if score > best_score:
                best_score = score
                best = asset
    return best if best_score >= 0.35 else None


def submit_reading(asset_id: str, value: float, *, note: str | None = None) -> tuple[int, dict]:
    return api_post(
        f"/assets/{asset_id}/meter-readings",
        {"value": value, "entry_method": "telegram", "note": note},
    )


def format_asset_meter(asset: dict) -> str:
    meter = asset.get("meter") or {}
    unit = meter.get("unit") or ""
    current = meter.get("current_value")
    lines = [
        f"Asset: {asset.get('name')}",
        f"ID: {asset.get('external_id')}",
        f"Meter: {current} {unit}".strip(),
    ]
    for task in (asset.get("tasks") or [])[:5]:
        item = task.get("item") or "Service"
        remaining = task.get("remaining_meter")
        if remaining is not None:
            overdue = task.get("overdue_meter")
            if overdue:
                lines.append(f"  • {item}: OVERDUE")
            else:
                lines.append(f"  • {item}: {remaining:.1f} {unit} remaining")
    return "\n".join(lines)


def main() -> int:
    if len(sys.argv) < 2:
        print('Usage: propertymanager-meter.py "dr mower 127.4 hours"')
        return 1
    text = " ".join(sys.argv[1:])
    parsed = parse_meter_command(text)
    if not parsed:
        print("Could not parse meter command. Example: dr mower 127.4 hours")
        return 1
    hint, value = parsed
    asset = find_asset(hint)
    if asset is None:
        print(f"No asset matched: {hint}")
        return 1
    status, result = submit_reading(str(asset["id"]), value)
    if status == 409:
        print(
            f"Reading {value} is lower than current {result.get('current_value')}. "
            "Use the app or QR page to confirm correction."
        )
        return 1
    if status >= 400:
        print(result.get("error", result))
        return 1
    print(f"Updated {asset.get('name')} to {value} {(asset.get('meter') or {}).get('unit', '')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
