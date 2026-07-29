"""Asset and meter REST endpoints for PropertyManager API."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from difflib import SequenceMatcher
from uuid import uuid4

from flask import jsonify, request

import db as pm_db
import meter_schedule as ms

ASSET_COLUMNS = """
    a.id, a.external_id, a.ranchbrain_guid, a.name, a.manufacturer, a.model,
    a.category, a.location, a.aliases, a.qr_token, a.is_active,
    a.created_at, a.updated_at
"""

METER_COLUMNS = """
    m.asset_id, m.meter_type, m.current_value, m.unit, m.latest_reading_at, m.updated_at
"""


def register_asset_routes(app) -> None:
    app.add_url_rule("/assets", "list_assets", list_assets, methods=["GET"])
    app.add_url_rule("/assets/<asset_id>", "asset_detail", asset_detail, methods=["GET"])
    app.add_url_rule(
        "/assets/by-external-id/<external_id>",
        "asset_by_external_id",
        asset_by_external_id,
        methods=["GET"],
    )
    app.add_url_rule(
        "/assets/by-qr/<qr_token>",
        "asset_by_qr",
        asset_by_qr,
        methods=["GET"],
    )
    app.add_url_rule("/assets", "create_asset", create_asset, methods=["POST"])
    app.add_url_rule("/assets/<asset_id>", "patch_asset", patch_asset, methods=["PATCH"])
    app.add_url_rule(
        "/assets/<asset_id>/meter-readings",
        "list_meter_readings",
        list_meter_readings,
        methods=["GET"],
    )
    app.add_url_rule(
        "/assets/<asset_id>/meter-readings",
        "create_meter_reading",
        create_meter_reading,
        methods=["POST"],
    )
    app.add_url_rule(
        "/meter-readings/parse",
        "parse_meter_reading",
        parse_meter_reading,
        methods=["POST"],
    )


def fetch_asset_or_404(asset_id: str) -> dict | None:
    row = pm_db.execute_one_json(
        f"""
        SELECT {ASSET_COLUMNS}, {METER_COLUMNS}
        FROM propertymanager.assets a
        LEFT JOIN propertymanager.asset_meter m ON m.asset_id = a.id
        WHERE a.id = %s AND a.is_active = true
        """,
        (asset_id,),
    )
    if row is None:
        return None
    return enrich_asset(row)


def enrich_asset(row: dict) -> dict:
    item = dict(row)
    asset_id = str(item["id"])
    current = ms._as_float(item.get("current_value"))
    tasks = pm_db.execute_json(
        """
        SELECT id, item, schedule_kind, meter_interval_value, meter_interval_unit,
               last_done_meter_value, next_due_meter_value, next_due, warning_days
        FROM propertymanager.maintenance_tasks
        WHERE is_active = true AND asset_id = %s
        ORDER BY item
        """,
        (asset_id,),
    )
    enriched_tasks = [ms.enrich_task_meter_fields(t, current) for t in tasks]
    overdue_count = sum(1 for t in enriched_tasks if t.get("overdue_meter"))
    due_soon = [
        t for t in enriched_tasks
        if t.get("remaining_meter") is not None and 0 < t["remaining_meter"] <= (t.get("meter_interval_value") or 999999) * 0.1
    ]
    item["meter"] = {
        "meter_type": item.pop("meter_type", "none"),
        "current_value": current,
        "unit": item.pop("unit", ""),
        "latest_reading_at": item.pop("latest_reading_at"),
        "updated_at": item.pop("updated_at", None),
    }
    item.pop("asset_id", None)
    item["tasks"] = enriched_tasks
    item["pm_summary"] = {
        "overdue_meter_count": overdue_count,
        "due_soon_count": len(due_soon),
    }
    return item


def list_assets():
    rows = pm_db.execute_json(
        f"""
        SELECT {ASSET_COLUMNS}, {METER_COLUMNS}
        FROM propertymanager.assets a
        LEFT JOIN propertymanager.asset_meter m ON m.asset_id = a.id
        WHERE a.is_active = true
        ORDER BY a.category, a.name
        """
    )
    return jsonify([enrich_asset(r) for r in rows])


def asset_detail(asset_id: str):
    row = fetch_asset_or_404(asset_id)
    if row is None:
        return jsonify({"error": "Asset not found"}), 404
    return jsonify(row)


def asset_by_external_id(external_id: str):
    row = pm_db.execute_one_json(
        f"""
        SELECT {ASSET_COLUMNS}, {METER_COLUMNS}
        FROM propertymanager.assets a
        LEFT JOIN propertymanager.asset_meter m ON m.asset_id = a.id
        WHERE a.external_id = %s AND a.is_active = true
        """,
        (external_id,),
    )
    if row is None:
        return jsonify({"error": "Asset not found"}), 404
    return jsonify(enrich_asset(row))


def asset_by_qr(qr_token: str):
    row = pm_db.execute_one_json(
        f"""
        SELECT {ASSET_COLUMNS}, {METER_COLUMNS}
        FROM propertymanager.assets a
        LEFT JOIN propertymanager.asset_meter m ON m.asset_id = a.id
        WHERE a.qr_token = %s AND a.is_active = true
        """,
        (qr_token,),
    )
    if row is None:
        return jsonify({"error": "Asset not found"}), 404
    return jsonify(enrich_asset(row))


def create_asset():
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "JSON object body required"}), 400

    external_id = str(payload.get("external_id") or "").strip()
    name = str(payload.get("name") or "").strip()
    if not external_id or not name:
        return jsonify({"error": "external_id and name are required"}), 400

    asset_id = str(payload.get("id") or uuid4())
    qr_token = str(payload.get("qr_token") or uuid4().hex)
    meter_type = str(payload.get("meter_type") or ms.default_meter_type_for_category(str(payload.get("category") or "")))
    if meter_type not in ms.METER_TYPES:
        return jsonify({"error": f"meter_type must be one of {sorted(ms.METER_TYPES)}"}), 400

    aliases = payload.get("aliases") or []
    if not isinstance(aliases, list):
        aliases = []

    pm_db.execute(
        """
        INSERT INTO propertymanager.assets
            (id, external_id, ranchbrain_guid, name, manufacturer, model, category, location, aliases, qr_token, is_active, created_at, updated_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, true, now(), now())
        """,
        (
            asset_id,
            external_id,
            payload.get("ranchbrain_guid"),
            name,
            str(payload.get("manufacturer") or ""),
            str(payload.get("model") or ""),
            str(payload.get("category") or ""),
            str(payload.get("location") or ""),
            __import__("json").dumps(aliases),
            qr_token,
        ),
    )
    pm_db.execute(
        """
        INSERT INTO propertymanager.asset_meter
            (asset_id, meter_type, current_value, unit, updated_at)
        VALUES (%s, %s, 0, %s, now())
        ON CONFLICT (asset_id) DO NOTHING
        """,
        (asset_id, meter_type, ms.meter_unit_for_type(meter_type)),
    )
    row = fetch_asset_or_404(asset_id)
    return jsonify(row), 201


def patch_asset(asset_id: str):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict) or not payload:
        return jsonify({"error": "JSON object body required"}), 400

    allowed = {"name", "manufacturer", "model", "category", "location", "aliases", "is_active"}
    unknown = sorted(set(payload) - allowed - {"meter_type"})
    if unknown:
        return jsonify({"error": f"Unsupported fields: {', '.join(unknown)}"}), 400

    if fetch_asset_or_404(asset_id) is None:
        # allow patch before enrich if inactive check - use raw fetch
        exists = pm_db.execute_one_json(
            "SELECT id FROM propertymanager.assets WHERE id = %s",
            (asset_id,),
        )
        if exists is None:
            return jsonify({"error": "Asset not found"}), 404

    updates = []
    values = []
    for field in allowed:
        if field not in payload:
            continue
        val = payload[field]
        if field == "aliases":
            val = __import__("json").dumps(val if isinstance(val, list) else [])
            updates.append(f"{field} = %s::jsonb")
        else:
            updates.append(f"{field} = %s")
        values.append(val)
    if updates:
        values.append(asset_id)
        pm_db.execute(
            f"""
            UPDATE propertymanager.assets
            SET {", ".join(updates)}, updated_at = now()
            WHERE id = %s
            """,
            values,
        )

    if "meter_type" in payload:
        meter_type = str(payload["meter_type"])
        if meter_type not in ms.METER_TYPES:
            return jsonify({"error": f"meter_type must be one of {sorted(ms.METER_TYPES)}"}), 400
        pm_db.execute(
            """
            UPDATE propertymanager.asset_meter
            SET meter_type = %s, unit = %s, updated_at = now()
            WHERE asset_id = %s
            """,
            (meter_type, ms.meter_unit_for_type(meter_type), asset_id),
        )

    row = fetch_asset_or_404(asset_id)
    return jsonify(row)


def list_meter_readings(asset_id: str):
    if fetch_asset_or_404(asset_id) is None:
        return jsonify({"error": "Asset not found"}), 404
    limit = min(int(request.args.get("limit", 50)), 200)
    rows = pm_db.execute_json(
        """
        SELECT id, asset_id, value, reading_at, entry_method, note, correction_reason,
               usage_since_previous, created_at
        FROM propertymanager.asset_meter_reading
        WHERE asset_id = %s
        ORDER BY reading_at DESC, created_at DESC
        LIMIT %s
        """,
        (asset_id, limit),
    )
    return jsonify(rows)


def create_meter_reading(asset_id: str):
    asset = fetch_asset_or_404(asset_id)
    if asset is None:
        return jsonify({"error": "Asset not found"}), 404

    payload = request.get_json(silent=True) or {}
    try:
        value = float(payload.get("value"))
    except (TypeError, ValueError):
        return jsonify({"error": "value is required and must be a number"}), 400

    meter = asset.get("meter") or {}
    meter_type = meter.get("meter_type") or "none"
    if meter_type == "none":
        return jsonify({"error": "Asset has no operating meter configured"}), 422

    current = ms._as_float(meter.get("current_value")) or 0.0
    correction = str(payload.get("correction_reason") or "").strip().lower() or None
    if correction and correction not in ms.CORRECTION_REASONS:
        return jsonify({"error": f"correction_reason must be one of {sorted(ms.CORRECTION_REASONS)}"}), 400

    if value < current and not correction:
        return (
            jsonify(
                {
                    "error": "lower_reading",
                    "current_value": current,
                    "submitted_value": value,
                    "options": sorted(ms.CORRECTION_REASONS),
                }
            ),
            409,
        )

    entry_method = str(payload.get("entry_method") or "manual").strip().lower()
    if entry_method not in ms.ENTRY_METHODS:
        entry_method = "manual"

    reading_at_raw = payload.get("reading_at")
    if reading_at_raw:
        reading_at = datetime.fromisoformat(str(reading_at_raw).replace("Z", "+00:00"))
        if reading_at.tzinfo is None:
            reading_at = reading_at.replace(tzinfo=timezone.utc)
    else:
        reading_at = datetime.now(timezone.utc)

    note = str(payload.get("note") or "").strip() or None

    try:
        ms.apply_meter_reading(
            asset_id,
            value,
            reading_at=reading_at,
            entry_method=entry_method,
            note=note,
            correction_reason=correction,
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 422

    updated = fetch_asset_or_404(asset_id)
    return jsonify(updated)


_VALUE_PATTERN = re.compile(
    r"(?P<value>\d+(?:\.\d+)?)\s*(?P<unit>hours?|hrs?|miles?|mi|cycles?)?",
    re.IGNORECASE,
)


def _similarity(a: str, b: str) -> float:
    return SequenceMatcher(None, a.lower(), b.lower()).ratio()


def parse_meter_reading():
    payload = request.get_json(silent=True) or {}
    text = str(payload.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400

    match = _VALUE_PATTERN.search(text)
    if not match:
        return jsonify({"error": "Could not find a meter value in text"}), 422

    value = float(match.group("value"))
    unit_hint = (match.group("unit") or "").lower()

    assets = pm_db.execute_json(
        f"""
        SELECT {ASSET_COLUMNS}, {METER_COLUMNS}
        FROM propertymanager.assets a
        LEFT JOIN propertymanager.asset_meter m ON m.asset_id = a.id
        WHERE a.is_active = true
        """
    )

    text_lower = text.lower()
    best = None
    best_score = 0.0
    for row in assets:
        names = [str(row.get("name") or "")]
        aliases = row.get("aliases") or []
        if isinstance(aliases, list):
            names.extend(str(a) for a in aliases)
        names.append(str(row.get("external_id") or ""))
        for name in names:
            if not name:
                continue
            if name.lower() in text_lower:
                score = 1.0
            else:
                score = _similarity(name, text)
            if score > best_score:
                best_score = score
                best = row

    if best is None or best_score < 0.35:
        return jsonify({"error": "Could not match asset from text", "confidence": best_score}), 422

    meter_type = best.get("meter_type") or "none"
    unit = best.get("unit") or ms.meter_unit_for_type(meter_type)
    return jsonify(
        {
            "asset_id": str(best["id"]),
            "asset_name": best.get("name"),
            "value": value,
            "unit": unit,
            "meter_type": meter_type,
            "confidence": round(best_score, 3),
        }
    )
