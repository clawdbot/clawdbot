"""RanchBrain task→asset mapping proposal endpoints."""

from __future__ import annotations

from uuid import uuid4

from flask import jsonify, request

import db as pm_db
from auth import auth_required
from errors import error_response, validation_error
import meter_schedule as ms


def register_mapping_routes(app) -> None:
    app.add_url_rule(
        "/v1/mapping-proposals",
        "list_mapping_proposals",
        list_mapping_proposals,
        methods=["GET"],
    )
    app.add_url_rule(
        "/v1/mapping-proposals/<proposal_id>/approve",
        "approve_mapping_proposal",
        approve_mapping_proposal,
        methods=["POST"],
    )
    app.add_url_rule(
        "/v1/mapping-proposals/<proposal_id>/reject",
        "reject_mapping_proposal",
        reject_mapping_proposal,
        methods=["POST"],
    )


def _proposal_row(proposal_id: str) -> dict | None:
    return pm_db.execute_one_json(
        """
        SELECT p.id, p.ranchbrain_task_ref, p.task_id, p.proposed_asset_id,
               p.match_rationale, p.confidence, p.status, p.reviewed_by,
               p.reviewed_at, p.created_at,
               a.name AS asset_name, a.external_id AS asset_external_id,
               t.item AS task_item, t.area AS task_area
        FROM propertymanager.asset_task_mapping_proposals p
        JOIN propertymanager.assets a ON a.id = p.proposed_asset_id
        LEFT JOIN propertymanager.maintenance_tasks t ON t.id = p.task_id
        WHERE p.id = %s
        """,
        (proposal_id,),
    )


def list_mapping_proposals():
    status = str(request.args.get("status") or "pending").strip().lower()
    if status not in {"pending", "approved", "rejected", "all"}:
        return validation_error("status must be pending, approved, rejected, or all", field="status")

    if status == "all":
        rows = pm_db.execute_json(
            """
            SELECT p.id, p.ranchbrain_task_ref, p.task_id, p.proposed_asset_id,
                   p.match_rationale, p.confidence, p.status, p.reviewed_by,
                   p.reviewed_at, p.created_at,
                   a.name AS asset_name, a.external_id AS asset_external_id,
                   t.item AS task_item, t.area AS task_area
            FROM propertymanager.asset_task_mapping_proposals p
            JOIN propertymanager.assets a ON a.id = p.proposed_asset_id
            LEFT JOIN propertymanager.maintenance_tasks t ON t.id = p.task_id
            ORDER BY p.status, p.confidence DESC, p.created_at
            """
        )
    else:
        rows = pm_db.execute_json(
            """
            SELECT p.id, p.ranchbrain_task_ref, p.task_id, p.proposed_asset_id,
                   p.match_rationale, p.confidence, p.status, p.reviewed_by,
                   p.reviewed_at, p.created_at,
                   a.name AS asset_name, a.external_id AS asset_external_id,
                   t.item AS task_item, t.area AS task_area
            FROM propertymanager.asset_task_mapping_proposals p
            JOIN propertymanager.assets a ON a.id = p.proposed_asset_id
            LEFT JOIN propertymanager.maintenance_tasks t ON t.id = p.task_id
            WHERE p.status = %s
            ORDER BY p.confidence DESC, p.created_at
            """,
            (status,),
        )
    return jsonify(rows)


@auth_required()
def approve_mapping_proposal(proposal_id: str):
    from flask import g

    row = _proposal_row(proposal_id)
    if row is None:
        return error_response("NOT_FOUND", "Mapping proposal not found", status=404)
    if row.get("status") != "pending":
        return validation_error(f"proposal already {row.get('status')}", field="status")

    task_id = row.get("task_id")
    asset_id = str(row.get("proposed_asset_id"))
    operator = g.operator_identity or "unknown"

    if task_id:
        pm_db.execute(
            """
            UPDATE propertymanager.maintenance_tasks
            SET asset_id = %s, updated_at = now()
            WHERE id = %s
            """,
            (asset_id, str(task_id)),
        )
        meter_row = ms.fetch_meter_row(asset_id)
        current = ms._as_decimal((meter_row or {}).get("current_value"))
        ms.recalc_tasks_for_asset(asset_id, current)

    pm_db.execute(
        """
        UPDATE propertymanager.asset_task_mapping_proposals
        SET status = 'approved',
            reviewed_by = %s,
            reviewed_at = now()
        WHERE id = %s
        """,
        (operator, proposal_id),
    )
    updated = _proposal_row(proposal_id)
    return jsonify(updated)


@auth_required()
def reject_mapping_proposal(proposal_id: str):
    from flask import g

    row = _proposal_row(proposal_id)
    if row is None:
        return error_response("NOT_FOUND", "Mapping proposal not found", status=404)
    if row.get("status") != "pending":
        return validation_error(f"proposal already {row.get('status')}", field="status")

    operator = g.operator_identity or "unknown"
    pm_db.execute(
        """
        UPDATE propertymanager.asset_task_mapping_proposals
        SET status = 'rejected',
            reviewed_by = %s,
            reviewed_at = now()
        WHERE id = %s
        """,
        (operator, proposal_id),
    )
    updated = _proposal_row(proposal_id)
    return jsonify(updated)


def insert_mapping_proposal(
    *,
    ranchbrain_task_ref: str,
    task_id: str | None,
    proposed_asset_id: str,
    match_rationale: str,
    confidence: float,
) -> str:
    proposal_id = str(uuid4())
    pm_db.execute(
        """
        INSERT INTO propertymanager.asset_task_mapping_proposals
            (id, ranchbrain_task_ref, task_id, proposed_asset_id, match_rationale, confidence, status)
        VALUES (%s, %s, %s, %s, %s, %s, 'pending')
        ON CONFLICT DO NOTHING
        """,
        (proposal_id, ranchbrain_task_ref, task_id, proposed_asset_id, match_rationale, confidence),
    )
    return proposal_id
