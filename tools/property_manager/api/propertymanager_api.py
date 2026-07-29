#!/usr/bin/env python3
from __future__ import annotations

import os
import json
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from flask import Flask, jsonify, request

import db as pm_db
import meter_schedule as ms
from assets_api import register_asset_routes
from auth import auth_required, auth_status
from decimal_utils import parse_decimal
from errors import error_response, validation_error
from mapping_proposals import register_mapping_routes

app = Flask(__name__)

ATTACHMENTS_ROOT = os.environ.get(
    "PROPERTYMANAGER_ATTACHMENTS_ROOT",
    "/mnt/ai-storage/openclaw-documents/Property/attachments",
)

TASK_COLUMNS = """
    id, area, item, category_name, priority, frequency,
    task_description, response_instructions, supplies_needed,
    notes, result_notes, estimated_minutes,
    warning_days, critical_days,
    last_done, next_due,
    send_telegram_update, include_in_daily_briefing,
    alert_if_overdue, is_active,
    part_url, vendor, part_number, part_cost, annual_cost,
    kind, manufacturer, source_manual_name, origin,
    asset_id, schedule_kind, meter_interval_value, meter_interval_unit,
    last_done_meter_value, next_due_meter_value,
    completion_history, tools_required,
    created_at, updated_at
"""

PATCHABLE_FIELDS = {
    "vendor",
    "part_number",
    "part_url",
    "part_cost",
    "annual_cost",
    "notes",
    "supplies_needed",
    "task_description",
    "response_instructions",
    "manufacturer",
    "source_manual_name",
    "origin",
    "asset_id",
    "schedule_kind",
    "meter_interval_value",
    "meter_interval_unit",
    "last_done_meter_value",
    "next_due_meter_value",
}

NUMERIC_PATCH_FIELDS = {"part_cost", "annual_cost", "meter_interval_value", "last_done_meter_value", "next_due_meter_value"}

PART_COLUMNS = """
    id, task_id, name, oem_part_number, part_number, buy_url, cost, quantity,
    vendor, notes, sort_order, created_at, updated_at
"""

PART_UPSERT_FIELDS = {
    "name",
    "oem_part_number",
    "part_number",
    "buy_url",
    "cost",
    "quantity",
    "vendor",
    "notes",
    "sort_order",
}


def normalize_patch_value(field: str, value):
    if field in NUMERIC_PATCH_FIELDS:
        if value is None or value == "":
            return None
        try:
            return float(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{field} must be a number") from exc

    if field == "origin":
        text = str(value or "").strip().lower()
        if text in {"manufacturer", "owner"}:
            return text
        raise ValueError("origin must be 'manufacturer' or 'owner'")

    if value is None:
        return None
    text = str(value).strip()
    return text or None


def normalize_origin(value) -> str:
    text = str(value or "").strip().lower()
    if text in {"manufacturer", "owner"}:
        return text
    return "owner"


def normalize_part_payload(raw: dict, *, sort_order: int) -> dict:
    if not isinstance(raw, dict):
        raise ValueError("Each part must be an object")

    unknown = sorted(set(raw) - PART_UPSERT_FIELDS - {"id"})
    if unknown:
        raise ValueError(f"Unsupported part fields: {', '.join(unknown)}")

    def text_field(key: str, default: str = "") -> str:
        value = raw.get(key, default)
        if value is None:
            return default
        return str(value).strip()

    cost_raw = raw.get("cost", 0)
    if cost_raw is None or cost_raw == "":
        cost = 0.0
    else:
        try:
            cost = float(cost_raw)
        except (TypeError, ValueError) as exc:
            raise ValueError("cost must be a number") from exc

    quantity_raw = raw.get("quantity", 1)
    if quantity_raw is None or quantity_raw == "":
        quantity = 1.0
    else:
        try:
            quantity = float(quantity_raw)
        except (TypeError, ValueError) as exc:
            raise ValueError("quantity must be a number") from exc
    if quantity <= 0:
        raise ValueError("quantity must be greater than zero")

    sort_raw = raw.get("sort_order", sort_order)
    try:
        sort_value = int(sort_raw if sort_raw is not None else sort_order)
    except (TypeError, ValueError) as exc:
        raise ValueError("sort_order must be an integer") from exc

    part_id = raw.get("id")
    if part_id is not None and str(part_id).strip():
        part_id = str(part_id).strip()
    else:
        part_id = str(uuid4())

    return {
        "id": part_id,
        "name": text_field("name"),
        "oem_part_number": text_field("oem_part_number"),
        "part_number": text_field("part_number"),
        "buy_url": text_field("buy_url"),
        "cost": cost,
        "quantity": quantity,
        "vendor": text_field("vendor"),
        "notes": text_field("notes"),
        "sort_order": sort_value,
    }


def fetch_task_or_404(task_id: str) -> dict | None:
    return pm_db.execute_one_json(
        f"""
        SELECT
            {TASK_COLUMNS}
        FROM propertymanager.maintenance_tasks
        WHERE id = %s AND is_active = true
        """,
        (task_id,),
    )


def enrich_tasks(rows: list[dict]) -> list[dict]:
    if not rows:
        return []
    ids = [str(row["id"]) for row in rows]
    placeholders = ", ".join(["%s"] * len(ids))

    parts_rows = pm_db.execute_json(
        f"""
        SELECT
            {PART_COLUMNS}
        FROM propertymanager.maintenance_task_parts
        WHERE task_id IN ({placeholders})
        ORDER BY sort_order, name
        """,
        ids,
    )
    photos_rows = pm_db.execute_json(
        f"""
        SELECT id, task_id, file_name, storage_path, created_at
        FROM propertymanager.maintenance_task_photos
        WHERE task_id IN ({placeholders})
        ORDER BY created_at
        """,
        ids,
    )

    parts_by_task: dict[str, list] = {}
    for part in parts_rows:
        parts_by_task.setdefault(str(part["task_id"]), []).append(part)

    photos_by_task: dict[str, list] = {}
    for photo in photos_rows:
        photos_by_task.setdefault(str(photo["task_id"]), []).append(photo)

    enriched = []
    for row in rows:
        item = dict(row)
        task_id = str(item["id"])
        item["parts"] = parts_by_task.get(task_id, [])
        item["photos"] = photos_by_task.get(task_id, [])
        if item.get("completion_history") is None:
            item["completion_history"] = []
        if item.get("tools_required") is None:
            item["tools_required"] = []
        current_meter = None
        asset_id = item.get("asset_id")
        if asset_id:
            meter_row = ms.fetch_meter_row(str(asset_id))
            if meter_row:
                current_meter = ms._as_decimal(meter_row.get("current_value"))
            item = ms.enrich_task_meter_fields(item, current_meter)
        enriched.append(item)
    return enriched


@app.get("/health")
def health():
    return jsonify(
        {
            "status": "ok",
            "service": "propertymanager-api",
            "api_version": "v1",
            "db_mode": "docker_exec" if pm_db.use_docker() else "tcp",
            "schema_version": "006",
            "attachments_root": ATTACHMENTS_ROOT,
            **auth_status(),
        }
    )


@app.get("/categories")
def categories():
    rows = pm_db.execute_json(
        """
        SELECT id, name, icon, color_name, is_built_in, sort_order, created_at, updated_at
        FROM propertymanager.maintenance_categories
        ORDER BY sort_order, name
        """
    )
    return jsonify(rows)


@app.post("/categories")
def create_category():
    """Create a category (used by Mac/iPhone when adding a category)."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "JSON object body required"}), 400

    name = str(payload.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400

    existing = pm_db.execute_one_json(
        """
        SELECT id, name, icon, color_name, is_built_in, sort_order, created_at, updated_at
        FROM propertymanager.maintenance_categories
        WHERE lower(name) = lower(%s)
        LIMIT 1
        """,
        (name,),
    )
    if existing is not None:
        return jsonify(existing), 200

    category_id = str(payload.get("id") or uuid4())
    icon = str(payload.get("icon") or "folder.fill").strip() or "folder.fill"
    color_name = str(payload.get("color_name") or "gray").strip() or "gray"
    is_built_in = bool(payload.get("is_built_in", False))

    max_sort_row = pm_db.execute_one_json(
        """
        SELECT COALESCE(MAX(sort_order), 0)::int AS max_sort
        FROM propertymanager.maintenance_categories
        """
    )
    sort_order = int(payload.get("sort_order") or ((max_sort_row or {}).get("max_sort") or 0) + 10)

    pm_db.execute(
        """
        INSERT INTO propertymanager.maintenance_categories
            (id, name, icon, color_name, is_built_in, sort_order, created_at, updated_at)
        VALUES (%s, %s, %s, %s, %s, %s, now(), now())
        """,
        (category_id, name, icon, color_name, is_built_in, sort_order),
    )

    created = pm_db.execute_one_json(
        """
        SELECT id, name, icon, color_name, is_built_in, sort_order, created_at, updated_at
        FROM propertymanager.maintenance_categories
        WHERE id = %s
        """,
        (category_id,),
    )
    if created is None:
        return jsonify({"error": "Category create failed"}), 500
    return jsonify(created), 201


FALLBACK_CATEGORY_NAME = "House"


@app.delete("/categories/<category_id>")
def delete_category(category_id: str):
    """Delete a category. If active tasks remain, require explicit reassign_to."""
    category = pm_db.execute_one_json(
        """
        SELECT id, name, is_built_in
        FROM propertymanager.maintenance_categories
        WHERE id = %s
        """,
        (category_id,),
    )
    if category is None:
        return jsonify({"error": "Category not found"}), 404

    name = str(category.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Category has no name"}), 400
    if name.lower() == FALLBACK_CATEGORY_NAME.lower():
        return jsonify({"error": f"Cannot delete the fallback category '{FALLBACK_CATEGORY_NAME}'"}), 400

    payload = request.get_json(silent=True) or {}
    reassign_to = str(payload.get("reassign_to") or request.args.get("reassign_to") or "").strip()

    task_count_row = pm_db.execute_one_json(
        """
        SELECT COUNT(*)::int AS task_count
        FROM propertymanager.maintenance_tasks
        WHERE is_active = true
          AND lower(category_name) = lower(%s)
        """,
        (name,),
    )
    task_count = int((task_count_row or {}).get("task_count") or 0)

    if task_count > 0 and not reassign_to:
        return (
            jsonify(
                {
                    "error": (
                        f"Category '{name}' has {task_count} active task"
                        f"{'' if task_count == 1 else 's'}. "
                        "Choose a destination category (reassign_to) before deleting."
                    ),
                    "task_count": task_count,
                    "requires_reassign": True,
                    "category_id": category_id,
                    "category_name": name,
                }
            ),
            409,
        )

    reassigned = 0
    destination_name = None
    if task_count > 0:
        if reassign_to.lower() == name.lower():
            return jsonify({"error": "reassign_to must be a different category"}), 400

        destination = pm_db.execute_one_json(
            """
            SELECT id, name
            FROM propertymanager.maintenance_categories
            WHERE lower(name) = lower(%s)
            LIMIT 1
            """,
            (reassign_to,),
        )
        if destination is None:
            return jsonify({"error": f"Destination category '{reassign_to}' not found"}), 400

        destination_name = str(destination["name"])
        reassigned = pm_db.execute(
            """
            UPDATE propertymanager.maintenance_tasks
            SET category_name = %s,
                area = %s,
                updated_at = now()
            WHERE is_active = true
              AND lower(category_name) = lower(%s)
            """,
            (destination_name, destination_name, name),
        )

    deleted = pm_db.execute(
        """
        DELETE FROM propertymanager.maintenance_categories
        WHERE id = %s
        """,
        (category_id,),
    )
    if deleted == 0:
        return jsonify({"error": "Category not found"}), 404

    return jsonify(
        {
            "deleted": True,
            "category_id": category_id,
            "category_name": name,
            "reassigned_to": destination_name,
            "tasks_reassigned": int(reassigned or 0),
        }
    )


@app.get("/tasks")
def tasks():
    rows = pm_db.execute_json(
        f"""
        SELECT
            {TASK_COLUMNS}
        FROM propertymanager.maintenance_tasks
        WHERE is_active = true
        ORDER BY area, item
        """
    )
    return jsonify(enrich_tasks(rows))


@app.get("/tasks/<task_id>")
def task_detail(task_id: str):
    row = pm_db.execute_one_json(
        f"""
        SELECT
            {TASK_COLUMNS}
        FROM propertymanager.maintenance_tasks
        WHERE id = %s AND is_active = true
        """,
        (task_id,),
    )
    if row is None:
        return jsonify({"error": "Task not found"}), 404
    return jsonify(enrich_tasks([row])[0])


@app.post("/tasks")
def upsert_task():
    """Create or replace a task (used by Mac Publish)."""
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "JSON object body required"}), 400

    task_id = str(payload.get("id") or uuid4())
    origin = normalize_origin(payload.get("origin"))
    source_manual = str(payload.get("source_manual_name") or "").strip()
    if not payload.get("origin") and source_manual:
        origin = "manufacturer"

    tools = payload.get("tools_required") or []
    history = payload.get("completion_history") or []
    if not isinstance(tools, list):
        tools = []
    if not isinstance(history, list):
        history = []

    schedule_kind = str(payload.get("schedule_kind") or "calendar").strip().lower()
    if schedule_kind not in ms.SCHEDULE_KINDS:
        schedule_kind = "calendar"

    meter_interval_value = payload.get("meter_interval_value")
    if meter_interval_value is not None and meter_interval_value != "":
        meter_interval_value = float(meter_interval_value)
    else:
        meter_interval_value = None

    last_done_meter = payload.get("last_done_meter_value")
    next_due_meter = payload.get("next_due_meter_value")
    if last_done_meter is not None and last_done_meter != "":
        last_done_meter = float(last_done_meter)
    else:
        last_done_meter = None
    if next_due_meter is not None and next_due_meter != "":
        next_due_meter = float(next_due_meter)
    else:
        next_due_meter = None

    asset_id = payload.get("asset_id")
    if asset_id is not None and str(asset_id).strip() == "":
        asset_id = None

    pm_db.execute(
        """
        INSERT INTO propertymanager.maintenance_tasks (
            id, area, item, category_name, priority, frequency,
            task_description, response_instructions, supplies_needed,
            notes, result_notes, estimated_minutes,
            warning_days, critical_days,
            last_done, next_due,
            send_telegram_update, include_in_daily_briefing,
            alert_if_overdue, is_active,
            kind, manufacturer, source_manual_name, origin,
            asset_id, schedule_kind, meter_interval_value, meter_interval_unit,
            last_done_meter_value, next_due_meter_value,
            completion_history, tools_required,
            created_at, updated_at
        ) VALUES (
            %s, %s, %s, %s, %s, %s,
            %s, %s, %s,
            %s, %s, %s,
            %s, %s,
            %s, %s,
            %s, %s,
            %s, %s,
            %s, %s, %s, %s,
            %s, %s, %s, %s,
            %s, %s,
            %s::jsonb, %s::jsonb,
            now(), now()
        )
        ON CONFLICT (id) DO UPDATE SET
            area = EXCLUDED.area,
            item = EXCLUDED.item,
            category_name = EXCLUDED.category_name,
            priority = EXCLUDED.priority,
            frequency = EXCLUDED.frequency,
            task_description = EXCLUDED.task_description,
            response_instructions = EXCLUDED.response_instructions,
            supplies_needed = EXCLUDED.supplies_needed,
            notes = EXCLUDED.notes,
            result_notes = EXCLUDED.result_notes,
            estimated_minutes = EXCLUDED.estimated_minutes,
            warning_days = EXCLUDED.warning_days,
            critical_days = EXCLUDED.critical_days,
            last_done = EXCLUDED.last_done,
            next_due = EXCLUDED.next_due,
            send_telegram_update = EXCLUDED.send_telegram_update,
            include_in_daily_briefing = EXCLUDED.include_in_daily_briefing,
            alert_if_overdue = EXCLUDED.alert_if_overdue,
            is_active = EXCLUDED.is_active,
            kind = EXCLUDED.kind,
            manufacturer = EXCLUDED.manufacturer,
            source_manual_name = EXCLUDED.source_manual_name,
            origin = EXCLUDED.origin,
            asset_id = EXCLUDED.asset_id,
            schedule_kind = EXCLUDED.schedule_kind,
            meter_interval_value = EXCLUDED.meter_interval_value,
            meter_interval_unit = EXCLUDED.meter_interval_unit,
            last_done_meter_value = EXCLUDED.last_done_meter_value,
            next_due_meter_value = EXCLUDED.next_due_meter_value,
            completion_history = EXCLUDED.completion_history,
            tools_required = EXCLUDED.tools_required,
            updated_at = now()
        """,
        (
            task_id,
            str(payload.get("area") or "House"),
            str(payload.get("item") or ""),
            str(payload.get("category_name") or payload.get("area") or "House"),
            str(payload.get("priority") or "Medium"),
            str(payload.get("frequency") or "Monthly"),
            str(payload.get("task_description") or ""),
            str(payload.get("response_instructions") or ""),
            str(payload.get("supplies_needed") or ""),
            str(payload.get("notes") or ""),
            str(payload.get("result_notes") or ""),
            int(payload.get("estimated_minutes") or 30),
            int(payload.get("warning_days") or 30),
            int(payload.get("critical_days") or 45),
            payload.get("last_done"),
            payload.get("next_due"),
            bool(payload.get("send_telegram_update", True)),
            bool(payload.get("include_in_daily_briefing", True)),
            bool(payload.get("alert_if_overdue", True)),
            bool(payload.get("is_active", True)),
            str(payload.get("kind") or "Scheduled"),
            str(payload.get("manufacturer") or ""),
            source_manual,
            origin,
            asset_id,
            schedule_kind,
            meter_interval_value,
            str(payload.get("meter_interval_unit") or "") or None,
            last_done_meter,
            next_due_meter,
            json.dumps(history),
            json.dumps(tools),
        ),
    )

    if asset_id and schedule_kind in {"meter", "both"}:
        meter_row = ms.fetch_meter_row(str(asset_id))
        current = ms._as_decimal((meter_row or {}).get("current_value"))
        ms.recalc_tasks_for_asset(str(asset_id), current)

    parts = payload.get("parts")
    if isinstance(parts, list):
        pm_db.execute(
            "DELETE FROM propertymanager.maintenance_task_parts WHERE task_id = %s",
            (task_id,),
        )
        for index, raw in enumerate(parts):
            if not isinstance(raw, dict):
                continue
            try:
                part = normalize_part_payload(raw, sort_order=index)
            except ValueError:
                continue
            pm_db.execute(
                """
                INSERT INTO propertymanager.maintenance_task_parts
                    (id, task_id, name, oem_part_number, part_number, buy_url, cost,
                     quantity, vendor, notes, sort_order, created_at, updated_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())
                """,
                (
                    part["id"],
                    task_id,
                    part["name"],
                    part["oem_part_number"],
                    part["part_number"],
                    part["buy_url"],
                    part["cost"],
                    part["quantity"],
                    part["vendor"],
                    part["notes"],
                    part["sort_order"],
                ),
            )

    updated = fetch_task_or_404(task_id)
    if updated is None:
        return jsonify({"error": "Task upsert failed"}), 500
    return jsonify(enrich_tasks([updated])[0])


@app.patch("/tasks/<task_id>")
def patch_task(task_id: str):
    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "JSON object body required"}), 400
    if not payload:
        return jsonify({"error": "No fields to update"}), 400

    unknown = sorted(set(payload) - PATCHABLE_FIELDS)
    if unknown:
        return jsonify({"error": f"Unsupported fields: {', '.join(unknown)}"}), 400

    updates = {}
    try:
        for field, value in payload.items():
            updates[field] = normalize_patch_value(field, value)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    set_clause = ", ".join(f"{column} = %s" for column in updates)
    values = list(updates.values()) + [task_id]

    affected = pm_db.execute(
        f"""
        UPDATE propertymanager.maintenance_tasks
        SET {set_clause},
            updated_at = now()
        WHERE id = %s AND is_active = true
        """,
        values,
    )
    updated = fetch_task_or_404(task_id)
    if updated is None or affected == 0:
        return jsonify({"error": "Task not found"}), 404
    return jsonify(enrich_tasks([updated])[0])


@app.delete("/tasks/<task_id>")
def delete_task(task_id: str):
    """Soft-delete a task by setting is_active=false (keeps history/parts)."""
    affected = pm_db.execute(
        """
        UPDATE propertymanager.maintenance_tasks
        SET is_active = false,
            updated_at = now()
        WHERE id = %s AND is_active = true
        """,
        (task_id,),
    )
    if affected == 0:
        return jsonify({"error": "Task not found"}), 404
    return jsonify({"deleted": True, "task_id": task_id})


@app.put("/tasks/<task_id>/parts")
def replace_task_parts(task_id: str):
    """Replace the full parts list for a task (used by iPhone edit form)."""
    if fetch_task_or_404(task_id) is None:
        return jsonify({"error": "Task not found"}), 404

    payload = request.get_json(silent=True)
    if not isinstance(payload, list):
        return jsonify({"error": "JSON array body required"}), 400

    try:
        parts = [
            normalize_part_payload(item, sort_order=index)
            for index, item in enumerate(payload)
        ]
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    pm_db.execute(
        """
        DELETE FROM propertymanager.maintenance_task_parts
        WHERE task_id = %s
        """,
        (task_id,),
    )

    for part in parts:
        pm_db.execute(
            """
            INSERT INTO propertymanager.maintenance_task_parts
                (id, task_id, name, oem_part_number, part_number, buy_url, cost,
                 quantity, vendor, notes, sort_order, created_at, updated_at)
            VALUES
                (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())
            """,
            (
                part["id"],
                task_id,
                part["name"],
                part["oem_part_number"],
                part["part_number"],
                part["buy_url"],
                part["cost"],
                part["quantity"],
                part["vendor"],
                part["notes"],
                part["sort_order"],
            ),
        )

    pm_db.execute(
        """
        UPDATE propertymanager.maintenance_tasks
        SET updated_at = now()
        WHERE id = %s
        """,
        (task_id,),
    )

    updated = fetch_task_or_404(task_id)
    if updated is None:
        return jsonify({"error": "Task not found"}), 404
    return jsonify(enrich_tasks([updated])[0])


@app.post("/tasks/<task_id>/parts")
def create_task_part(task_id: str):
    if fetch_task_or_404(task_id) is None:
        return jsonify({"error": "Task not found"}), 404

    payload = request.get_json(silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "JSON object body required"}), 400

    existing = pm_db.execute_json(
        """
        SELECT COALESCE(MAX(sort_order), -1) AS max_sort
        FROM propertymanager.maintenance_task_parts
        WHERE task_id = %s
        """,
        (task_id,),
    )
    next_sort = int((existing[0] or {}).get("max_sort") or -1) + 1

    try:
        part = normalize_part_payload(payload, sort_order=next_sort)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    pm_db.execute(
        """
        INSERT INTO propertymanager.maintenance_task_parts
            (id, task_id, name, oem_part_number, part_number, buy_url, cost,
             quantity, vendor, notes, sort_order, created_at, updated_at)
        VALUES
            (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now(), now())
        """,
        (
            part["id"],
            task_id,
            part["name"],
            part["oem_part_number"],
            part["part_number"],
            part["buy_url"],
            part["cost"],
            part["quantity"],
            part["vendor"],
            part["notes"],
            part["sort_order"],
        ),
    )
    pm_db.execute(
        """
        UPDATE propertymanager.maintenance_tasks
        SET updated_at = now()
        WHERE id = %s
        """,
        (task_id,),
    )
    updated = fetch_task_or_404(task_id)
    return jsonify(enrich_tasks([updated])[0])


@app.post("/tasks/<task_id>/complete")
@auth_required()
def complete_task(task_id: str):
    from flask import g

    payload = request.get_json(silent=True) or {}
    note = str(payload.get("note") or "").strip() or None
    completed_at = datetime.now(timezone.utc)

    task = pm_db.execute_one_json(
        """
        SELECT id, warning_days, asset_id, schedule_kind
        FROM propertymanager.maintenance_tasks
        WHERE id = %s AND is_active = true
        """,
        (task_id,),
    )
    if task is None:
        return error_response("NOT_FOUND", "Task not found", status=404)

    warning_days = int(task.get("warning_days") or 0)
    next_due = completed_at + timedelta(days=max(warning_days, 1))

    meter_value = None
    meter_value_raw = payload.get("meter_value_at_completion")
    if meter_value_raw is not None and meter_value_raw != "":
        try:
            meter_value = parse_decimal(meter_value_raw, field="meter_value_at_completion")
        except ValueError as exc:
            return validation_error(str(exc), field="meter_value_at_completion")

    confirm_current = bool(payload.get("confirm_current_meter"))

    try:
        meter_result = ms.complete_task_meter(
            task_id,
            completed_at=completed_at,
            note=note,
            meter_value_at_completion=meter_value,
            confirm_current_meter=confirm_current,
            operator_identity=getattr(g, "operator_identity", None),
            integration_identity=getattr(g, "integration_identity", None),
        )
    except ValueError as exc:
        return validation_error(str(exc))

    completion_id = str(uuid4())
    pm_db.execute(
        """
        INSERT INTO propertymanager.maintenance_completions
            (id, task_id, completed_at, note, meter_value_at_completion, meter_reading_id)
        VALUES (%s, %s, %s, %s, %s, %s)
        """,
        (
            completion_id,
            task_id,
            completed_at,
            note,
            meter_result.get("meter_value") if meter_result else meter_value,
            (meter_result or {}).get("meter_reading_id"),
        ),
    )
    pm_db.execute(
        """
        UPDATE propertymanager.maintenance_tasks
        SET last_done = %s,
            next_due = %s,
            result_notes = COALESCE(%s, result_notes),
            updated_at = now()
        WHERE id = %s
        """,
        (completed_at, next_due, note, task_id),
    )
    updated = pm_db.execute_one_json(
        f"""
        SELECT
            {TASK_COLUMNS}
        FROM propertymanager.maintenance_tasks
        WHERE id = %s AND is_active = true
        """,
        (task_id,),
    )
    if updated is None:
        return jsonify({"error": "Task not found"}), 404
    return jsonify(enrich_tasks([updated])[0])


register_asset_routes(app)
register_mapping_routes(app)


if __name__ == "__main__":
    port = int(os.environ.get("PROPERTYMANAGER_API_PORT", "5062"))
    app.run(host="0.0.0.0", port=port, debug=True)
