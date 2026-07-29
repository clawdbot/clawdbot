"""Meter schedule recalculation for PropertyManager assets."""

from __future__ import annotations

from typing import Any

import db as pm_db

METER_TYPES = {"runtime_hours", "mileage", "cycles", "none"}
METER_UNITS = {
    "runtime_hours": "hrs",
    "mileage": "mi",
    "cycles": "cycles",
    "none": "",
}
SCHEDULE_KINDS = {"calendar", "meter", "both"}
CORRECTION_REASONS = {"replacement", "rollover", "correction"}
ENTRY_METHODS = {"manual", "voice", "qr", "api", "telegram", "completion"}


def default_meter_type_for_category(category: str) -> str:
    normalized = (category or "").strip().lower()
    if normalized == "equipment":
        return "runtime_hours"
    if normalized in {"vehicles", "vehicle"}:
        return "mileage"
    return "none"


def meter_unit_for_type(meter_type: str) -> str:
    return METER_UNITS.get(meter_type, "")


def remaining_meter(current: float | None, next_due: float | None) -> float | None:
    if current is None or next_due is None:
        return None
    return round(next_due - current, 3)


def is_meter_overdue(current: float | None, next_due: float | None) -> bool:
    if current is None or next_due is None:
        return False
    return current >= next_due


def enrich_task_meter_fields(task: dict[str, Any], current_meter: float | None) -> dict[str, Any]:
    item = dict(task)
    next_due_meter = _as_float(item.get("next_due_meter_value"))
    item["remaining_meter"] = remaining_meter(current_meter, next_due_meter)
    item["overdue_meter"] = is_meter_overdue(current_meter, next_due_meter)
    return item


def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def fetch_meter_row(asset_id: str) -> dict[str, Any] | None:
    return pm_db.execute_one_json(
        """
        SELECT asset_id, meter_type, current_value, unit, latest_reading_at, updated_at
        FROM propertymanager.asset_meter
        WHERE asset_id = %s
        """,
        (asset_id,),
    )


def recalc_tasks_for_asset(asset_id: str, current_meter: float | None) -> list[dict[str, Any]]:
    """Recompute next_due_meter_value for meter/both tasks linked to asset."""
    tasks = pm_db.execute_json(
        """
        SELECT id, schedule_kind, meter_interval_value, last_done_meter_value, next_due_meter_value
        FROM propertymanager.maintenance_tasks
        WHERE is_active = true
          AND asset_id = %s
          AND schedule_kind IN ('meter', 'both')
        """,
        (asset_id,),
    )
    updated: list[dict[str, Any]] = []
    for task in tasks:
        interval = _as_float(task.get("meter_interval_value"))
        if interval is None or interval <= 0:
            continue
        last_done = _as_float(task.get("last_done_meter_value"))
        if last_done is None:
            last_done = current_meter if current_meter is not None else 0.0
        next_due = round(last_done + interval, 3)
        pm_db.execute(
            """
            UPDATE propertymanager.maintenance_tasks
            SET next_due_meter_value = %s,
                updated_at = now()
            WHERE id = %s
            """,
            (next_due, str(task["id"])),
        )
        updated.append({"id": str(task["id"]), "next_due_meter_value": next_due})
    return updated


def apply_meter_reading(
    asset_id: str,
    value: float,
    *,
    reading_at,
    entry_method: str,
    note: str | None,
    correction_reason: str | None,
    skip_if_unchanged: bool = False,
) -> dict[str, Any]:
    """Insert reading, update asset_meter, recalc linked tasks. Caller validates lower reading."""
    from uuid import uuid4

    meter = fetch_meter_row(asset_id)
    if meter is None:
        raise ValueError("asset_meter not found")
    if meter.get("meter_type") == "none":
        raise ValueError("asset has no operating meter")

    previous = _as_float(meter.get("current_value")) or 0.0
    if skip_if_unchanged and abs(value - previous) < 0.001:
        recalc_tasks_for_asset(asset_id, value)
        return {"reading_id": None, "current_value": value, "skipped": True}

    prev_row = pm_db.execute_one_json(
        """
        SELECT value
        FROM propertymanager.asset_meter_reading
        WHERE asset_id = %s
        ORDER BY reading_at DESC, created_at DESC
        LIMIT 1
        """,
        (asset_id,),
    )
    usage = None
    if correction_reason not in {"replacement", "rollover"}:
        if prev_row is not None:
            usage = round(value - _as_float(prev_row.get("value")), 3)
        elif previous > 0:
            usage = round(value - previous, 3)

    rid = str(uuid4())
    pm_db.execute(
        """
        INSERT INTO propertymanager.asset_meter_reading
            (id, asset_id, value, reading_at, entry_method, note, correction_reason, usage_since_previous)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (rid, asset_id, value, reading_at, entry_method, note, correction_reason, usage),
    )

    pm_db.execute(
        """
        UPDATE propertymanager.asset_meter
        SET current_value = %s,
            latest_reading_at = %s,
            updated_at = now()
        WHERE asset_id = %s
        """,
        (value, reading_at, asset_id),
    )
    recalc_tasks_for_asset(asset_id, value)
    return {"reading_id": rid, "current_value": value}


def complete_task_meter(
    task_id: str,
    *,
    completed_at,
    note: str | None,
    meter_value_at_completion: float | None,
) -> dict[str, Any] | None:
    """Update task calendar + meter fields on completion. Returns asset_id if meter schedule."""
    task = pm_db.execute_one_json(
        """
        SELECT id, asset_id, warning_days, schedule_kind, meter_interval_value, last_done_meter_value
        FROM propertymanager.maintenance_tasks
        WHERE id = %s AND is_active = true
        """,
        (task_id,),
    )
    if task is None:
        return None

    asset_id = task.get("asset_id")
    schedule_kind = task.get("schedule_kind") or "calendar"
    reading_id = None
    meter_val = None

    if asset_id and schedule_kind in {"meter", "both"}:
        meter_row = fetch_meter_row(str(asset_id))
        meter_val = meter_value_at_completion
        if meter_val is None and meter_row is not None:
            meter_val = _as_float(meter_row.get("current_value"))
        reading_id = None
        if meter_val is not None:
            result = apply_meter_reading(
                str(asset_id),
                meter_val,
                reading_at=completed_at,
                entry_method="completion",
                note=note,
                correction_reason=None,
                skip_if_unchanged=True,
            )
            reading_id = result.get("reading_id")
            interval = _as_float(task.get("meter_interval_value"))
            next_due_meter = round(meter_val + interval, 3) if interval else None
            pm_db.execute(
                """
                UPDATE propertymanager.maintenance_tasks
                SET last_done_meter_value = %s,
                    next_due_meter_value = %s,
                    updated_at = now()
                WHERE id = %s
                """,
                (meter_val, next_due_meter, task_id),
            )
    return {"asset_id": str(asset_id) if asset_id else None, "meter_reading_id": reading_id, "meter_value": meter_val if asset_id else None}
