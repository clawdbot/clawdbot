"""Meter schedule recalculation and reading engine for PropertyManager Phase 1."""

from __future__ import annotations

import hashlib
import secrets
import time
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import uuid4

import db as pm_db
from decimal_utils import decimal_to_db, format_decimal, parse_decimal

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
READING_STATUSES = {"accepted", "rejected", "corrected"}

# In-memory preview tokens (dev VM); TTL 15 minutes
_PREVIEW_TOKENS: dict[str, dict[str, Any]] = {}
_PREVIEW_TTL_SECONDS = 900


def default_meter_type_for_category(category: str) -> str:
    normalized = (category or "").strip().lower()
    if normalized == "equipment":
        return "runtime_hours"
    if normalized in {"vehicles", "vehicle"}:
        return "mileage"
    return "none"


def meter_unit_for_type(meter_type: str) -> str:
    return METER_UNITS.get(meter_type, "")


def remaining_meter(current: Decimal | None, next_due: Decimal | None) -> Decimal | None:
    if current is None or next_due is None:
        return None
    return decimal_to_db(next_due - current)


def is_meter_overdue(current: Decimal | None, next_due: Decimal | None) -> bool:
    if current is None or next_due is None:
        return False
    return current >= next_due


def enrich_task_meter_fields(task: dict[str, Any], current_meter: Decimal | None) -> dict[str, Any]:
    item = dict(task)
    next_due_meter = _as_decimal(item.get("next_due_meter_value"))
    rem = remaining_meter(current_meter, next_due_meter)
    item["remaining_meter"] = format_decimal(rem) if rem is not None else None
    item["overdue_meter"] = is_meter_overdue(current_meter, next_due_meter)
    return item


def _as_decimal(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return parse_decimal(value)
    except ValueError:
        return None


def fetch_meter_row(asset_id: str, *, for_update: bool = False) -> dict[str, Any] | None:
    suffix = " FOR UPDATE" if for_update else ""
    return pm_db.execute_one_json(
        f"""
        SELECT asset_id, meter_type, current_value, unit, latest_reading_at,
               meter_epoch, row_version, updated_at
        FROM propertymanager.asset_meter
        WHERE asset_id = %s
        {suffix}
        """,
        (asset_id,),
    )


def fetch_asset_proposed_meter(asset_id: str) -> dict[str, Any] | None:
    return pm_db.execute_one_json(
        """
        SELECT id, meter_proposed_type, meter_proposed_unit, meter_activated_at
        FROM propertymanager.assets
        WHERE id = %s
        """,
        (asset_id,),
    )


def meter_is_active(asset_id: str) -> bool:
    row = fetch_asset_proposed_meter(asset_id)
    if row is None:
        return False
    return row.get("meter_activated_at") is not None


def activate_meter(
    asset_id: str,
    *,
    meter_type: str | None = None,
    unit: str | None = None,
    row_version: int | None = None,
) -> dict[str, Any]:
    asset = fetch_asset_proposed_meter(asset_id)
    if asset is None:
        raise ValueError("asset not found")
    if asset.get("meter_activated_at") is not None:
        raise ValueError("meter already activated")

    proposed_type = meter_type or asset.get("meter_proposed_type") or "none"
    proposed_unit = unit or asset.get("meter_proposed_unit") or meter_unit_for_type(proposed_type)
    if proposed_type not in METER_TYPES:
        raise ValueError(f"meter_type must be one of {sorted(METER_TYPES)}")
    if proposed_type == "none":
        raise ValueError("cannot activate meter with type none")

    meter = fetch_meter_row(asset_id)
    if meter is None:
        raise ValueError("asset_meter not found")

    if row_version is not None and int(meter.get("row_version") or 0) != int(row_version):
        raise ValueError("CONFLICT: row_version mismatch")

    pm_db.execute(
        """
        UPDATE propertymanager.assets
        SET meter_activated_at = now(), updated_at = now()
        WHERE id = %s
        """,
        (asset_id,),
    )
    pm_db.execute(
        """
        UPDATE propertymanager.asset_meter
        SET meter_type = %s,
            unit = %s,
            row_version = row_version + 1,
            updated_at = now()
        WHERE asset_id = %s
        """,
        (proposed_type, proposed_unit, asset_id),
    )
    updated = fetch_meter_row(asset_id)
    return updated or {}


def recalc_tasks_for_asset(asset_id: str, current_meter: Decimal | None) -> list[dict[str, Any]]:
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
        interval = _as_decimal(task.get("meter_interval_value"))
        if interval is None or interval <= 0:
            continue
        last_done = _as_decimal(task.get("last_done_meter_value"))
        if last_done is None:
            last_done = current_meter if current_meter is not None else Decimal("0")
        next_due = decimal_to_db(last_done + interval)
        pm_db.execute(
            """
            UPDATE propertymanager.maintenance_tasks
            SET next_due_meter_value = %s,
                updated_at = now()
            WHERE id = %s
            """,
            (next_due, str(task["id"])),
        )
        updated.append({"id": str(task["id"]), "next_due_meter_value": format_decimal(next_due)})
    return updated


def _latest_accepted_in_epoch(asset_id: str, epoch: int) -> dict[str, Any] | None:
    return pm_db.execute_one_json(
        """
        SELECT id, value, reading_at, created_at
        FROM propertymanager.asset_meter_reading
        WHERE asset_id = %s
          AND meter_epoch = %s
          AND status = 'accepted'
        ORDER BY reading_at DESC, created_at DESC
        LIMIT 1
        """,
        (asset_id, epoch),
    )


def _accepted_readings_in_epoch(asset_id: str, epoch: int) -> list[dict[str, Any]]:
    return pm_db.execute_json(
        """
        SELECT id, value, reading_at, created_at, previous_reading_id
        FROM propertymanager.asset_meter_reading
        WHERE asset_id = %s
          AND meter_epoch = %s
          AND status = 'accepted'
        ORDER BY reading_at ASC, created_at ASC
        """,
        (asset_id, epoch),
    )


def recalc_usage_for_epoch(asset_id: str, epoch: int) -> None:
    readings = _accepted_readings_in_epoch(asset_id, epoch)
    prev_id = None
    prev_value: Decimal | None = None
    for row in readings:
        rid = str(row["id"])
        value = _as_decimal(row.get("value")) or Decimal("0")
        usage = None
        if prev_value is not None:
            usage = decimal_to_db(value - prev_value)
        pm_db.execute(
            """
            UPDATE propertymanager.asset_meter_reading
            SET usage_since_previous = %s,
                previous_reading_id = %s
            WHERE id = %s
            """,
            (usage, prev_id, rid),
        )
        prev_id = rid
        prev_value = value


def update_current_meter_from_latest(asset_id: str, epoch: int) -> None:
    latest = _latest_accepted_in_epoch(asset_id, epoch)
    if latest is None:
        pm_db.execute(
            """
            UPDATE propertymanager.asset_meter
            SET current_value = 0,
                latest_reading_at = NULL,
                row_version = row_version + 1,
                updated_at = now()
            WHERE asset_id = %s
            """,
            (asset_id,),
        )
        return
    pm_db.execute(
        """
        UPDATE propertymanager.asset_meter
        SET current_value = %s,
            latest_reading_at = %s,
            row_version = row_version + 1,
            updated_at = now()
        WHERE asset_id = %s
        """,
        (latest["value"], latest["reading_at"], asset_id),
    )


def _cleanup_preview_tokens() -> None:
    now = time.time()
    expired = [k for k, v in _PREVIEW_TOKENS.items() if v.get("expires_at", 0) < now]
    for key in expired:
        _PREVIEW_TOKENS.pop(key, None)


def create_lower_reading_preview(
    asset_id: str,
    *,
    value: Decimal,
    reading_at: datetime,
    entry_method: str,
    note: str | None,
    idempotency_key: str | None,
    previous_value: Decimal,
) -> str:
    _cleanup_preview_tokens()
    token = secrets.token_urlsafe(24)
    _PREVIEW_TOKENS[token] = {
        "asset_id": asset_id,
        "value": str(value),
        "reading_at": reading_at.isoformat(),
        "entry_method": entry_method,
        "note": note,
        "idempotency_key": idempotency_key,
        "previous_value": str(previous_value),
        "expires_at": time.time() + _PREVIEW_TTL_SECONDS,
    }
    return token


def consume_preview_token(token: str) -> dict[str, Any] | None:
    _cleanup_preview_tokens()
    payload = _PREVIEW_TOKENS.pop(token, None)
    if payload is None:
        return None
    if payload.get("expires_at", 0) < time.time():
        return None
    return payload


def find_idempotent_reading(asset_id: str, idempotency_key: str) -> dict[str, Any] | None:
    if not idempotency_key:
        return None
    return pm_db.execute_one_json(
        """
        SELECT id, asset_id, value, reading_at, entry_method, note, correction_reason,
               usage_since_previous, created_at, status, meter_epoch, idempotency_key
        FROM propertymanager.asset_meter_reading
        WHERE asset_id = %s
          AND idempotency_key = %s
          AND status = 'accepted'
        LIMIT 1
        """,
        (asset_id, idempotency_key),
    )


def insert_accepted_reading(
    asset_id: str,
    *,
    value: Decimal,
    reading_at: datetime,
    entry_method: str,
    note: str | None,
    correction_reason: str | None,
    meter_type: str,
    unit: str,
    meter_epoch: int,
    operator_identity: str | None,
    integration_identity: str | None,
    idempotency_key: str | None,
    corrects_reading_id: str | None = None,
    status: str = "accepted",
) -> dict[str, Any]:
    prev = _latest_accepted_in_epoch(asset_id, meter_epoch)
    prev_id = str(prev["id"]) if prev else None
    usage = None
    if prev is not None and correction_reason not in {"replacement", "rollover"}:
        prev_val = _as_decimal(prev.get("value")) or Decimal("0")
        usage = decimal_to_db(value - prev_val)

    rid = str(uuid4())
    pm_db.execute(
        """
        INSERT INTO propertymanager.asset_meter_reading
            (id, asset_id, value, reading_at, entry_method, note, correction_reason,
             usage_since_previous, previous_reading_id, meter_type_at_entry, unit_at_entry,
             status, operator_identity, integration_identity, idempotency_key, meter_epoch,
             corrects_reading_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (
            rid,
            asset_id,
            decimal_to_db(value),
            reading_at,
            entry_method,
            note,
            correction_reason,
            usage,
            prev_id,
            meter_type,
            unit,
            status,
            operator_identity,
            integration_identity,
            idempotency_key,
            meter_epoch,
            corrects_reading_id,
        ),
    )
    recalc_usage_for_epoch(asset_id, meter_epoch)
    update_current_meter_from_latest(asset_id, meter_epoch)
    meter = fetch_meter_row(asset_id)
    current = _as_decimal((meter or {}).get("current_value"))
    recalc_tasks_for_asset(asset_id, current)
    return {"reading_id": rid, "current_value": format_decimal(current)}


def apply_meter_reading(
    asset_id: str,
    value: Decimal,
    *,
    reading_at: datetime,
    entry_method: str,
    note: str | None,
    operator_identity: str | None = None,
    integration_identity: str | None = None,
    idempotency_key: str | None = None,
    row_version: int | None = None,
) -> dict[str, Any]:
    """Normal reading path. Returns preview info if lower than previous in epoch."""
    if not meter_is_active(asset_id):
        raise ValueError("meter not activated; operator must activate proposed meter first")

    existing = find_idempotent_reading(asset_id, idempotency_key or "")
    if existing:
        meter = fetch_meter_row(asset_id)
        return {
            "reading_id": str(existing["id"]),
            "current_value": format_decimal(_as_decimal((meter or {}).get("current_value"))),
            "idempotent_replay": True,
            "reading": existing,
        }

    meter = fetch_meter_row(asset_id)
    if meter is None:
        raise ValueError("asset_meter not found")
    if meter.get("meter_type") == "none":
        raise ValueError("asset has no operating meter")

    if row_version is not None and int(meter.get("row_version") or 0) != int(row_version):
        raise ValueError("CONFLICT: row_version mismatch")

    epoch = int(meter.get("meter_epoch") or 1)
    prev = _latest_accepted_in_epoch(asset_id, epoch)
    prev_value = _as_decimal(prev.get("value")) if prev else _as_decimal(meter.get("current_value")) or Decimal("0")

    if value < prev_value:
        token = create_lower_reading_preview(
            asset_id,
            value=value,
            reading_at=reading_at,
            entry_method=entry_method,
            note=note,
            idempotency_key=idempotency_key,
            previous_value=prev_value,
        )
        return {
            "lower_reading_preview": True,
            "preview_token": token,
            "previous_value": format_decimal(prev_value),
            "proposed_value": format_decimal(value),
            "options": sorted(CORRECTION_REASONS),
        }

    return insert_accepted_reading(
        asset_id,
        value=value,
        reading_at=reading_at,
        entry_method=entry_method,
        note=note,
        correction_reason=None,
        meter_type=str(meter.get("meter_type") or "none"),
        unit=str(meter.get("unit") or ""),
        meter_epoch=epoch,
        operator_identity=operator_identity,
        integration_identity=integration_identity,
        idempotency_key=idempotency_key,
    )


def confirm_lower_reading(
    asset_id: str,
    *,
    preview_token: str,
    correction_reason: str,
    operator_identity: str,
    note: str | None = None,
    row_version: int | None = None,
) -> dict[str, Any]:
    if correction_reason not in CORRECTION_REASONS:
        raise ValueError(f"correction_reason must be one of {sorted(CORRECTION_REASONS)}")
    if not operator_identity:
        raise ValueError("operator_identity is required for lower-reading confirmation")

    preview = consume_preview_token(preview_token)
    if preview is None or preview.get("asset_id") != asset_id:
        raise ValueError("invalid or expired preview_token")

    idempotency_key = preview.get("idempotency_key")
    existing = find_idempotent_reading(asset_id, idempotency_key or "")
    if existing:
        meter = fetch_meter_row(asset_id)
        return {
            "reading_id": str(existing["id"]),
            "current_value": format_decimal(_as_decimal((meter or {}).get("current_value"))),
            "idempotent_replay": True,
        }

    meter = fetch_meter_row(asset_id)
    if meter is None:
        raise ValueError("asset_meter not found")
    if row_version is not None and int(meter.get("row_version") or 0) != int(row_version):
        raise ValueError("CONFLICT: row_version mismatch")

    epoch = int(meter.get("meter_epoch") or 1)
    value = parse_decimal(preview.get("value"))
    reading_at = datetime.fromisoformat(str(preview.get("reading_at")).replace("Z", "+00:00"))
    entry_method = str(preview.get("entry_method") or "manual")
    merged_note = note or preview.get("note")

    new_epoch = epoch
    if correction_reason in {"replacement", "rollover"}:
        new_epoch = epoch + 1
        pm_db.execute(
            """
            UPDATE propertymanager.asset_meter
            SET meter_epoch = %s,
                row_version = row_version + 1,
                updated_at = now()
            WHERE asset_id = %s
            """,
            (new_epoch, asset_id),
        )
        meter = fetch_meter_row(asset_id)

    corrects_id = None
    if correction_reason == "correction":
        prev = _latest_accepted_in_epoch(asset_id, epoch if correction_reason != "replacement" else epoch)
        if prev:
            corrects_id = str(prev["id"])

    return insert_accepted_reading(
        asset_id,
        value=value,
        reading_at=reading_at,
        entry_method=entry_method,
        note=merged_note,
        correction_reason=correction_reason,
        meter_type=str((meter or {}).get("meter_type") or "none"),
        unit=str((meter or {}).get("unit") or ""),
        meter_epoch=new_epoch,
        operator_identity=operator_identity,
        integration_identity=None,
        idempotency_key=idempotency_key,
        corrects_reading_id=corrects_id,
    )


def complete_task_meter(
    task_id: str,
    *,
    completed_at: datetime,
    note: str | None,
    meter_value_at_completion: Decimal | None,
    confirm_current_meter: bool = False,
    operator_identity: str | None = None,
    integration_identity: str | None = None,
) -> dict[str, Any] | None:
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
    meter_val: Decimal | None = None

    if asset_id and schedule_kind in {"meter", "both"}:
        meter_row = fetch_meter_row(str(asset_id))
        if meter_val is None and confirm_current_meter:
            if meter_row is None:
                raise ValueError("confirm_current_meter requested but asset has no meter")
            meter_val = _as_decimal(meter_row.get("current_value"))
        elif meter_value_at_completion is not None:
            meter_val = meter_value_at_completion
        else:
            raise ValueError(
                "meter_value_at_completion or confirm_current_meter=true required for meter-scheduled tasks"
            )

        if meter_val is not None:
            result = apply_meter_reading(
                str(asset_id),
                meter_val,
                reading_at=completed_at,
                entry_method="completion",
                note=note,
                operator_identity=operator_identity,
                integration_identity=integration_identity,
            )
            if result.get("lower_reading_preview"):
                raise ValueError("lower reading at completion requires preview/confirm flow first")
            reading_id = result.get("reading_id")
            interval = _as_decimal(task.get("meter_interval_value"))
            next_due_meter = decimal_to_db(meter_val + interval) if interval else None
            pm_db.execute(
                """
                UPDATE propertymanager.maintenance_tasks
                SET last_done_meter_value = %s,
                    next_due_meter_value = %s,
                    updated_at = now()
                WHERE id = %s
                """,
                (decimal_to_db(meter_val), next_due_meter, task_id),
            )
    return {
        "asset_id": str(asset_id) if asset_id else None,
        "meter_reading_id": reading_id,
        "meter_value": format_decimal(meter_val) if meter_val is not None else None,
    }
