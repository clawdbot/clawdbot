"""Dashboard QR asset page for PropertyManager meter entry (Phase 1 auth policy)."""

from __future__ import annotations

import html as html_module
import json
import os
import urllib.error
import urllib.request

from flask import request, session

PROPERTYMANAGER_API = os.environ.get(
    "PROPERTYMANAGER_API_BASE",
    "http://127.0.0.1:5062",
)
OPERATOR_PIN = os.environ.get("PROPERTYMANAGER_OPERATOR_PIN", "dev-pin")
API_KEY = os.environ.get("PROPERTYMANAGER_API_KEY", "")


def _auth_headers(*, pin: str | None = None) -> dict[str, str]:
    headers = {"Content-Type": "application/json", "X-Operator-Identity": "dashboard-qr"}
    if API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"
    elif pin:
        headers["X-Operator-PIN"] = pin
    elif session.get("pm_operator_authenticated"):
        headers["X-Operator-PIN"] = OPERATOR_PIN
    return headers


def _api_get(path: str) -> dict | list | None:
    url = PROPERTYMANAGER_API.rstrip("/") + path
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
        return None


def _api_post(path: str, body: dict, *, pin: str | None = None, idempotency_key: str | None = None) -> tuple[int, dict | str]:
    url = PROPERTYMANAGER_API.rstrip("/") + path
    headers = _auth_headers(pin=pin)
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode(errors="replace")
        try:
            return exc.code, json.loads(payload)
        except json.JSONDecodeError:
            return exc.code, payload


def meter_button_label(meter_type: str) -> str:
    return {
        "runtime_hours": "Update Hours",
        "mileage": "Update Miles",
        "cycles": "Update Cycles",
    }.get(meter_type, "Update Meter")


def register_pm_asset_routes(app) -> None:
    app.secret_key = os.environ.get("PROPERTYMANAGER_DASHBOARD_SECRET", "dev-dashboard-secret-change-me")

    @app.route("/pm/asset/<qr_token>", methods=["GET", "POST"])
    def pm_asset_page(qr_token: str):
        asset = _api_get(f"/v1/assets/by-qr/{qr_token}")
        if not isinstance(asset, dict):
            return (
                "<html><body style='font-family:sans-serif;padding:24px'>"
                "<h1>Asset not found</h1></body></html>",
                404,
            )

        message = ""
        confirm_lower = False
        pending_value = None
        pending_note = ""
        preview_token = None
        authenticated = session.get("pm_operator_authenticated", False)

        if request.method == "POST":
            action = request.form.get("action", "submit")

            if action == "auth":
                pin = (request.form.get("operator_pin") or "").strip()
                if pin == OPERATOR_PIN:
                    session["pm_operator_authenticated"] = True
                    authenticated = True
                    message = "Authenticated. You may submit meter readings."
                else:
                    message = "Invalid operator PIN."

            elif action in {"submit", "confirm_lower"}:
                if not authenticated and not API_KEY:
                    message = "Enter operator PIN before submitting readings."
                else:
                    note = (request.form.get("note") or "").strip()
                    try:
                        value = float(request.form.get("value", ""))
                    except ValueError:
                        message = "Enter a valid number."
                    else:
                        pin = OPERATOR_PIN if authenticated else None
                        if action == "confirm_lower":
                            preview_token = (request.form.get("preview_token") or "").strip()
                            correction = (request.form.get("correction_reason") or "correction").strip()
                            body = {
                                "preview_token": preview_token,
                                "correction_reason": correction,
                                "operator_identity": "dashboard-qr-operator",
                                "note": note or None,
                            }
                            status, result = _api_post(
                                f"/v1/assets/{asset['id']}/meter-readings/confirm",
                                body,
                                pin=pin,
                            )
                        else:
                            body = {
                                "value": value,
                                "note": note or None,
                                "entry_method": "qr",
                            }
                            status, result = _api_post(
                                f"/v1/assets/{asset['id']}/meter-readings",
                                body,
                                pin=pin,
                            )

                        if status == 409 and isinstance(result, dict) and result.get("code") == "LOWER_READING_CONFIRMATION_REQUIRED":
                            confirm_lower = True
                            pending_value = value
                            pending_note = note
                            preview_token = result.get("preview_token")
                            message = (
                                f"Reading {value} is lower than current {result.get('previous_value')}. "
                                "Confirm replacement, rollover, or correction below."
                            )
                        elif status == 401:
                            message = "Authentication required. Enter operator PIN."
                            session.pop("pm_operator_authenticated", None)
                            authenticated = False
                        elif status >= 400:
                            message = result.get("message", result.get("error", str(result))) if isinstance(result, dict) else str(result)
                        else:
                            if isinstance(result, dict) and isinstance(result.get("asset"), dict):
                                asset = result["asset"]
                            message = "Meter updated."

        meter = asset.get("meter") or {}
        proposed = asset.get("proposed_meter") or {}
        meter_type = meter.get("meter_type") or "none"
        unit = meter.get("unit") or proposed.get("unit") or "hrs"
        current = meter.get("current_value")
        name = html_module.escape(str(asset.get("name") or ""))
        tasks = asset.get("tasks") or []
        due_tasks = sorted(
            [t for t in tasks if t.get("remaining_meter") is not None],
            key=lambda t: float(t.get("remaining_meter") or 999999),
        )[:3]

        task_rows = ""
        for task in due_tasks:
            item = html_module.escape(str(task.get("item") or "Service"))
            remaining = task.get("remaining_meter")
            overdue = task.get("overdue_meter")
            if overdue:
                status_text = "<span style='color:#f87171'>Overdue</span>"
            else:
                try:
                    status_text = f"{float(remaining):.1f} {html_module.escape(unit)} remaining"
                except (TypeError, ValueError):
                    status_text = f"{remaining} {html_module.escape(unit)} remaining"
            task_rows += f"<li><strong>{item}</strong> — {status_text}</li>"

        btn_label = meter_button_label(meter_type if meter.get("activated") else (proposed.get("meter_type") or "none"))
        auth_block = ""
        if not authenticated and not API_KEY:
            auth_block = """
<form method="post" style="margin-top:12px">
  <input type="hidden" name="action" value="auth" />
  <label>Operator PIN (required to submit readings)</label>
  <input name="operator_pin" type="password" required
    style="width:100%;padding:10px;margin:8px 0;border-radius:8px;border:1px solid #64748b" />
  <button type="submit" style="width:100%;padding:10px;background:#475569;border:none;border-radius:8px;color:#f8fafc">Unlock meter entry</button>
</form>
"""

        proposed_note = ""
        if not meter.get("activated") and proposed.get("meter_type") and proposed.get("meter_type") != "none":
            proposed_note = (
                f"<div class='sub'>Proposed meter: {html_module.escape(str(proposed.get('meter_type')))} "
                f"({html_module.escape(str(proposed.get('unit') or ''))}) — activate in Mac app before entry.</div>"
            )

        form_block = ""
        if meter.get("activated") and meter_type != "none" and (authenticated or API_KEY):
            if confirm_lower and pending_value is not None:
                form_block = f"""
<form method="post" style="margin-top:16px">
  <input type="hidden" name="value" value="{pending_value}" />
  <input type="hidden" name="note" value="{html_module.escape(pending_note)}" />
  <input type="hidden" name="preview_token" value="{html_module.escape(preview_token or '')}" />
  <input type="hidden" name="action" value="confirm_lower" />
  <label>Reason for lower reading</label><br/>
  <select name="correction_reason" required style="width:100%;padding:10px;margin:8px 0">
    <option value="correction">Correction (mistyped previous reading)</option>
    <option value="replacement">Meter replacement</option>
    <option value="rollover">Rollover / reset</option>
  </select>
  <button type="submit" style="width:100%;padding:14px;font-size:18px;font-weight:bold;background:#60a5fa;border:none;border-radius:8px">Confirm Update</button>
</form>
"""
            else:
                form_block = f"""
<form method="post" style="margin-top:16px">
  <input type="hidden" name="action" value="submit" />
  <label>New reading ({html_module.escape(unit)})</label>
  <input name="value" type="number" step="any" required
    style="width:100%;padding:14px;font-size:22px;margin:8px 0;border-radius:8px;border:1px solid #64748b" />
  <label>Note (optional)</label>
  <input name="note" type="text" style="width:100%;padding:10px;margin:8px 0;border-radius:8px;border:1px solid #64748b" />
  <button type="submit" style="width:100%;padding:16px;font-size:20px;font-weight:bold;background:#60a5fa;color:#0f172a;border:none;border-radius:10px;margin-top:8px">{html_module.escape(btn_label)}</button>
</form>
"""

        page = f"""<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{name} — Property Manager</title>
<style>
body {{ font-family: -apple-system, BlinkMacSystemFont, sans-serif; background:#0f172a; color:#f8fafc; margin:0; padding:20px; }}
.card {{ background:#1e293b; border-radius:16px; padding:20px; max-width:480px; margin:0 auto; }}
.meter {{ font-size:48px; font-weight:700; margin:12px 0; }}
.sub {{ color:#94a3b8; }}
.msg {{ background:#334155; padding:12px; border-radius:8px; margin-bottom:12px; }}
ul {{ padding-left:20px; }}
</style>
</head><body>
<div class="card">
  <h1 style="margin-top:0">{name}</h1>
  <div class="sub">{html_module.escape(str(asset.get('category') or ''))}</div>
  {proposed_note}
  <div class="meter">{current if current is not None else '—'} <span style="font-size:24px">{html_module.escape(unit)}</span></div>
  {"<div class='msg'>" + html_module.escape(message) + "</div>" if message else ""}
  {auth_block}
  {form_block}
  <h2>Upcoming service</h2>
  <ul>{task_rows or "<li>No meter-based tasks linked yet.</li>"}</ul>
</div>
</body></html>"""
        return page
