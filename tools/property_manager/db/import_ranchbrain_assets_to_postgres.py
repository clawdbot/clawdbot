#!/usr/bin/env python3
"""Import RanchBrain JSON assets into PropertyManager Postgres."""

from __future__ import annotations

import argparse
import json
import secrets
import subprocess
import uuid
from pathlib import Path
from typing import Any

RANCHBRAIN_ROOT = Path("/mnt/ai-storage/ranchbrain")
ASSETS_GLOB = "assets/**/*.json"

PSQL = [
    "docker",
    "exec",
    "-i",
    "postgres",
    "psql",
    "-U",
    "openclaw",
    "-d",
    "openclaw",
    "-v",
    "ON_ERROR_STOP=1",
]


def q(value: Any) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, (int, float)):
        return str(value)
    text = str(value).replace("'", "''")
    return f"'{text}'"


def q_json(value: Any) -> str:
    return q(json.dumps(value)) + "::jsonb"


def default_meter_type(category: str) -> str:
    normalized = (category or "").strip().lower()
    if normalized == "equipment":
        return "runtime_hours"
    if normalized in {"vehicles", "vehicle"}:
        return "mileage"
    return "none"


def meter_unit(meter_type: str) -> str:
    return {"runtime_hours": "hrs", "mileage": "mi", "cycles": "cycles"}.get(meter_type, "")


def load_assets(root: Path) -> list[dict[str, Any]]:
    assets: list[dict[str, Any]] = []
    for path in sorted(root.glob(ASSETS_GLOB)):
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        if not data.get("asset_id"):
            continue
        data["_path"] = str(path)
        assets.append(data)
    return assets


def asset_sql(data: dict[str, Any]) -> str:
    asset_id = str(uuid.uuid4())
    external_id = str(data["asset_id"])
    guid = data.get("guid")
    try:
        ranchbrain_guid = str(uuid.UUID(str(guid))) if guid else None
    except ValueError:
        ranchbrain_guid = None
    name = str(data.get("name") or external_id)
    manufacturer = str(data.get("manufacturer") or "")
    model = str(data.get("model") or "")
    category = str(data.get("category") or "")
    location = str(data.get("location") or "")
    tags = [t for t in (data.get("tags") or []) if t]
    aliases = list({name.lower(), *tags})
    qr_token = secrets.token_urlsafe(16)
    meter_type = default_meter_type(category)
    unit = meter_unit(meter_type)

    return f"""
INSERT INTO propertymanager.assets
    (id, external_id, ranchbrain_guid, name, manufacturer, model, category, location, aliases, qr_token, is_active, created_at, updated_at)
VALUES (
    {q(asset_id)},
    {q(external_id)},
    {q(ranchbrain_guid)},
    {q(name)},
    {q(manufacturer)},
    {q(model)},
    {q(category)},
    {q(location)},
    {q_json(aliases)},
    {q(qr_token)},
    true,
    now(),
    now()
)
ON CONFLICT (external_id) DO UPDATE SET
    ranchbrain_guid = COALESCE(EXCLUDED.ranchbrain_guid, propertymanager.assets.ranchbrain_guid),
    name = EXCLUDED.name,
    manufacturer = EXCLUDED.manufacturer,
    model = EXCLUDED.model,
    category = EXCLUDED.category,
    location = EXCLUDED.location,
    aliases = EXCLUDED.aliases,
    updated_at = now();

INSERT INTO propertymanager.asset_meter
    (asset_id, meter_type, current_value, unit, updated_at)
SELECT id, {q(meter_type)}, 0, {q(unit)}, now()
FROM propertymanager.assets
WHERE external_id = {q(external_id)}
ON CONFLICT (asset_id) DO NOTHING;
"""


def backfill_tasks_sql() -> str:
    return """
UPDATE propertymanager.maintenance_tasks t
SET asset_id = a.id,
    updated_at = now()
FROM propertymanager.assets a
WHERE t.asset_id IS NULL
  AND t.is_active = true
  AND (
    lower(trim(t.item)) = lower(trim(a.name))
    OR lower(trim(t.area)) = lower(trim(a.name))
    OR lower(trim(t.item)) = lower(trim(a.external_id))
  );
"""


def run_sql(statements: str, *, apply: bool) -> None:
    if not apply:
        print(statements[:4000])
        if len(statements) > 4000:
            print(f"... ({len(statements)} chars total, dry-run only)")
        return
    result = subprocess.run(
        PSQL,
        input=statements,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "psql failed")


def report_unmatched(*, apply: bool) -> None:
    if not apply:
        print("\n[dry-run] Skipping unmatched task report (requires DB).")
        return
    result = subprocess.run(
        PSQL + ["-At", "-c", """
SELECT COUNT(*)::text FROM propertymanager.maintenance_tasks
WHERE is_active = true AND asset_id IS NULL;
"""],
        capture_output=True,
        text=True,
        check=False,
    )
    print(f"Active tasks without asset_id: {(result.stdout or '').strip()}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=RANCHBRAIN_ROOT)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if not args.dry_run and not args.apply:
        parser.error("Specify --dry-run or --apply")

    root = args.root.expanduser()
    if not root.is_dir():
        raise SystemExit(f"RanchBrain root not found: {root}")

    assets = load_assets(root)
    print(f"Found {len(assets)} RanchBrain asset JSON files under {root}")

    statements = "\n".join(asset_sql(a) for a in assets)
    statements += "\n" + backfill_tasks_sql()

    run_sql(statements, apply=args.apply)
    report_unmatched(apply=args.apply)
    print("Done.")


if __name__ == "__main__":
    main()
