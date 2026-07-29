#!/usr/bin/env python3
"""Phase 1 PropertyManager meter smoke tests (dev VM).

Requires: postgres container, API running on PROPERTYMANAGER_API_PORT (default 5062).
Run: PROPERTYMANAGER_AUTH_DISABLED=1 python3 tools/property_manager/tests/test_phase1_meters.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

API = os.environ.get("PROPERTYMANAGER_API_BASE", "http://127.0.0.1:5062").rstrip("/")
AUTH_HEADERS = {
    "Content-Type": "application/json",
    "X-Operator-Identity": "phase1-test",
    "Authorization": f"Bearer {os.environ.get('PROPERTYMANAGER_API_KEY', 'test-key')}",
}


def _req(method: str, path: str, body: dict | None = None, headers: dict | None = None) -> tuple[int, dict]:
    hdrs = {}
    if body is not None or method in {"POST", "PATCH", "PUT"}:
        hdrs["Content-Type"] = "application/json"
        hdrs.update(AUTH_HEADERS)
    if headers:
        hdrs.update(headers)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode()
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, {"message": raw}


def _psql(sql: str) -> None:
    result = subprocess.run(
        ["docker", "exec", "-i", "postgres", "psql", "-U", "openclaw", "-d", "openclaw", "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr or result.stdout)


def wait_health() -> None:
    for _ in range(30):
        try:
            with urllib.request.urlopen(API + "/health", timeout=2) as resp:
                data = json.loads(resp.read().decode())
                if data.get("schema_version") == "006":
                    return
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError):
            pass
        time.sleep(0.5)
    raise RuntimeError("API health check failed or schema_version != 006")


def test_health() -> None:
    status, data = _req("GET", "/health")
    assert status == 200, data
    assert data.get("schema_version") == "006", data
    assert data.get("api_version") == "v1", data


def test_normal_reading_flow() -> str:
    ext = f"TEST-PHASE1-{uuid.uuid4().hex[:8]}"
    status, asset = _req(
        "POST",
        "/v1/assets",
        {
            "external_id": ext,
            "name": "Phase1 Test Mower",
            "category": "Equipment",
        },
    )
    assert status == 201, asset
    asset_id = asset["id"]

    status, activated = _req("POST", f"/v1/assets/{asset_id}/activate-meter", {})
    assert status == 200, activated

    status, reading = _req(
        "POST",
        f"/v1/assets/{asset_id}/meter-readings",
        {"value": "100.5", "entry_method": "api"},
    )
    assert status == 200, reading
    assert reading.get("current_value") == "100.5", reading
    return asset_id


def test_idempotency(asset_id: str) -> None:
    key = f"idem-{uuid.uuid4().hex}"
    headers = {"Idempotency-Key": key}
    status1, r1 = _req(
        "POST",
        f"/v1/assets/{asset_id}/meter-readings",
        {"value": "110"},
        headers=headers,
    )
    status2, r2 = _req(
        "POST",
        f"/v1/assets/{asset_id}/meter-readings",
        {"value": "110"},
        headers=headers,
    )
    assert status1 == 200 and status2 == 200, (r1, r2)
    assert r2.get("idempotent_replay") is True, r2


def test_lower_reading_preview_confirm(asset_id: str) -> None:
    status, preview = _req(
        "POST",
        f"/v1/assets/{asset_id}/meter-readings",
        {"value": "50"},
    )
    assert status == 409, preview
    assert preview.get("code") == "LOWER_READING_CONFIRMATION_REQUIRED", preview
    token = preview.get("preview_token")
    assert token, preview

    status, confirmed = _req(
        "POST",
        f"/v1/assets/{asset_id}/meter-readings/confirm",
        {
            "preview_token": token,
            "correction_reason": "correction",
            "operator_identity": "phase1-test-operator",
        },
    )
    assert status == 200, confirmed
    assert confirmed.get("current_value") == "50", confirmed


def test_backdated_reading(asset_id: str) -> None:
    now = datetime.now(timezone.utc)
    past = (now - timedelta(days=30)).isoformat()
    recent = (now - timedelta(days=1)).isoformat()

    status, r1 = _req(
        "POST",
        f"/v1/assets/{asset_id}/meter-readings",
        {"value": "200", "reading_at": recent},
    )
    assert status == 200, r1
    current_after_recent = r1.get("current_value") or r1.get("asset", {}).get("meter", {}).get("current_value")

    status, r2 = _req(
        "POST",
        f"/v1/assets/{asset_id}/meter-readings",
        {"value": "150", "reading_at": past},
    )
    assert status == 200, r2
    current_after_backdate = r2.get("current_value") or r2.get("asset", {}).get("meter", {}).get("current_value")
    assert current_after_backdate == current_after_recent, (current_after_backdate, current_after_recent)


def test_mapping_proposal_flow() -> None:
    task_id = str(uuid.uuid4())
    asset_id = str(uuid.uuid4())
    proposal_id = str(uuid.uuid4())
    suffix = uuid.uuid4().hex[:6]
    _psql(
        f"""
        INSERT INTO propertymanager.assets
            (id, external_id, name, qr_token, meter_proposed_type, meter_proposed_unit, is_active)
        VALUES ('{asset_id}', 'MAP-TEST-{suffix}', 'Map Test Asset {suffix}', '{uuid.uuid4().hex}', 'runtime_hours', 'hrs', true);
        INSERT INTO propertymanager.asset_meter (asset_id, meter_type, current_value, unit, meter_epoch, row_version)
        VALUES ('{asset_id}', 'none', 0, '', 1, 1);
        INSERT INTO propertymanager.maintenance_tasks
            (id, area, item, category_name, priority, frequency, warning_days, critical_days,
             estimated_minutes, last_done, next_due, is_active, schedule_kind, kind,
             completion_history, tools_required, origin,
             send_telegram_update, include_in_daily_briefing, alert_if_overdue)
        VALUES ('{task_id}', 'Equipment', 'Map Test Asset {suffix}', 'Equipment', 'Medium', 'Monthly',
                30, 45, 30, now(), now() + interval '30 days', true, 'calendar', 'Scheduled',
                '[]'::jsonb, '[]'::jsonb, 'owner', true, true, true);
        INSERT INTO propertymanager.asset_task_mapping_proposals
            (id, ranchbrain_task_ref, task_id, proposed_asset_id, match_rationale, confidence, status)
        VALUES ('{proposal_id}', '{task_id}', '{task_id}', '{asset_id}', 'test proposal', 0.99, 'pending');
        """
    )

    status, rows = _req("GET", "/v1/mapping-proposals?status=pending")
    assert status == 200, rows
    assert any(r.get("id") == proposal_id for r in rows), rows

    status, approved = _req("POST", f"/v1/mapping-proposals/{proposal_id}/approve", {})
    assert status == 200, approved
    assert approved.get("status") == "approved", approved

    row = subprocess.run(
        [
            "docker",
            "exec",
            "postgres",
            "psql",
            "-U",
            "openclaw",
            "-d",
            "openclaw",
            "-At",
            "-c",
            f"SELECT asset_id::text FROM propertymanager.maintenance_tasks WHERE id = '{task_id}';",
        ],
        capture_output=True,
        text=True,
    )
    assert row.stdout.strip() == asset_id, row.stdout


def main() -> int:
    os.environ.setdefault("PROPERTYMANAGER_AUTH_DISABLED", "1")
    wait_health()
    tests = [
        ("health", lambda: test_health()),
        ("normal_reading", None),
    ]
    print("Phase 1 smoke tests against", API)
    test_health()
    print("  OK health")
    asset_id = test_normal_reading_flow()
    print("  OK normal reading + activate meter")
    test_idempotency(asset_id)
    print("  OK idempotency")
    test_lower_reading_preview_confirm(asset_id)
    print("  OK lower reading preview/confirm")
    test_backdated_reading(asset_id)
    print("  OK backdated reading (current unchanged)")
    test_mapping_proposal_flow()
    print("  OK mapping proposal approve")
    print("All Phase 1 smoke tests passed.")
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
