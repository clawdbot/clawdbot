#!/usr/bin/env python3
"""Phase 2 client contract smoke tests (curl-style via urllib).

Validates /v1/ endpoints used by iOS/Mac clients: activate-meter, lower-reading
preview/confirm, completion meter fields, mapping proposals, QR read policy.

Run after Phase 1 tests:
  PROPERTYMANAGER_AUTH_DISABLED=1 python3 tools/property_manager/tests/test_phase2_meters.py
"""

from __future__ import annotations

import json
import os
import sys
import uuid

# Reuse Phase 1 helpers
sys.path.insert(0, os.path.dirname(__file__))
from test_phase1_meters import (  # noqa: E402
    AUTH_HEADERS,
    API,
    _req,
    wait_health,
    test_health,
    test_normal_reading_flow,
    test_lower_reading_preview_confirm,
    test_mapping_proposal_flow,
)


def test_v1_assets_list() -> None:
    status, data = _req("GET", "/v1/assets")
    assert status == 200, data
    assert isinstance(data, list), type(data)


def test_activate_meter_proposed() -> str:
    ext = f"TEST-PHASE2-{uuid.uuid4().hex[:8]}"
    status, asset = _req(
        "POST",
        "/v1/assets",
        {"external_id": ext, "name": "Phase2 Proposed Mower", "category": "Equipment"},
    )
    assert status == 201, asset
    asset_id = asset["id"]
    assert asset.get("proposed_meter", {}).get("meter_type") == "runtime_hours", asset

    status, activated = _req("POST", f"/v1/assets/{asset_id}/activate-meter", {})
    assert status == 200, activated
    assert activated.get("asset", {}).get("meter", {}).get("meter_type") == "runtime_hours", activated
    return asset_id


def test_meter_readings_paginated(asset_id: str) -> None:
    status, page = _req("GET", f"/v1/assets/{asset_id}/meter-readings?limit=5")
    assert status == 200, page
    assert "items" in page, page
    assert isinstance(page["items"], list), page


def test_parse_meter_text() -> None:
    status, result = _req("POST", "/v1/meter-readings/parse", {"text": "mower 42.5 hours"})
    assert status == 200, result
    assert "value" in result, result


def test_completion_requires_meter(asset_id: str) -> None:
    task_id = str(uuid.uuid4())
    from test_phase1_meters import _psql

    _psql(
        f"""
        INSERT INTO propertymanager.maintenance_tasks
            (id, area, item, category_name, priority, frequency, warning_days, critical_days,
             estimated_minutes, last_done, next_due, is_active, schedule_kind, kind,
             completion_history, tools_required, origin, asset_id,
             meter_interval_value, meter_interval_unit, next_due_meter_value,
             send_telegram_update, include_in_daily_briefing, alert_if_overdue)
        VALUES ('{task_id}', 'Equipment', 'Phase2 Meter Task', 'Equipment', 'Medium', 'Monthly',
                30, 45, 30, now(), now() + interval '30 days', true, 'meter', 'Scheduled',
                '[]'::jsonb, '[]'::jsonb, 'owner', '{asset_id}',
                50, 'hrs', 150,
                true, true, true);
        """
    )

    status, err = _req("POST", f"/tasks/{task_id}/complete", {"note": "no meter"})
    assert status == 400, err

    status, ok = _req(
        "POST",
        f"/tasks/{task_id}/complete",
        {"note": "confirmed", "confirm_current_meter": True},
    )
    assert status == 200, ok


def test_qr_read_anonymous() -> None:
    ext = f"QR-TEST-{uuid.uuid4().hex[:8]}"
    status, asset = _req(
        "POST",
        "/v1/assets",
        {"external_id": ext, "name": "QR Test Asset", "category": "Equipment"},
    )
    assert status == 201, asset
    token = asset.get("qr_token")
    assert token, asset

    import urllib.request

    url = API + f"/v1/assets/by-qr/{token}"
    with urllib.request.urlopen(url, timeout=10) as resp:
        data = json.loads(resp.read().decode())
    assert data.get("name") == "QR Test Asset", data


def main() -> int:
    os.environ.setdefault("PROPERTYMANAGER_AUTH_DISABLED", "1")
    wait_health()
    print("Phase 2 client contract tests against", API)
    test_health()
    print("  OK health")
    test_v1_assets_list()
    print("  OK GET /v1/assets")
    asset_id = test_activate_meter_proposed()
    print("  OK activate-meter (proposed → active)")
    test_meter_readings_paginated(asset_id)
    print("  OK paginated meter-readings (items[])")
    test_parse_meter_text()
    print("  OK POST /v1/meter-readings/parse")
    # Seed a high reading before lower-reading test on activate-meter asset
    status, _ = _req("POST", f"/v1/assets/{asset_id}/meter-readings", {"value": "200", "entry_method": "api"})
    assert status == 200, _
    test_lower_reading_preview_confirm(asset_id)
    print("  OK lower-reading preview/confirm")
    test_normal_reading_flow()
    print("  OK normal reading flow (standalone asset)")
    test_completion_requires_meter(asset_id)
    print("  OK completion confirm_current_meter required")
    test_mapping_proposal_flow()
    print("  OK mapping proposal approve")
    test_qr_read_anonymous()
    print("  OK QR read (anonymous GET by-qr)")
    print("All Phase 2 client contract tests passed.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AssertionError as exc:
        print("FAIL:", exc, file=sys.stderr)
        raise SystemExit(1)
    except Exception as exc:
        print("ERROR:", exc, file=sys.stderr)
        raise SystemExit(1)
