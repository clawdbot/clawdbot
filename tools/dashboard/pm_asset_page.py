"""Dashboard QR asset page for PropertyManager meter entry."""

from __future__ import annotations

import html as html_module
import json
import os
import urllib.error
import urllib.request

from flask import request

PROPERTYMANAGER_API = os.environ.get(
    "PROPERTYMANAGER_API_BASE",
    "http://127.0.0.1:5062",
)


def _api_get(path: str) -> dict | list | None:
    url = PROPERTYMANAGER_API.rstrip("/") + path
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except (urllib.error.URLError, json.JSONDecodeError, TimeoutError):
        return None


def _api_post(path: str, body: dict) -> tuple[int, dict | str]:
    url = PROPERTYMANAGER_API.rstrip("/") + path
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
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
    @app.route("/pm/asset/<qr_token>", methods=["GET", "POST"])
    def pm_asset_page(qr_token: str):
        asset = _api_get(f"/assets/by-qr/{qr_token}")
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

        if request.method == "POST":
            action = request.form.get("action", "submit")
            note = (request.form.get("note") or "").strip()
            try:
                value = float(request.form.get("value", ""))
            except ValueError:
                message = "Enter a valid number."
            else:
                correction = (request.form.get("correction_reason") or "").strip() or None
                if action == "confirm_lower":
                    correction = correction or "correction"
                body = {
                    "value": value,
                    "note": note or None,
                    "entry_method": "qr",
                }
                if correction:
                    body["correction_reason"] = correction
                status, result = _api_post(
                    f"/assets/{asset['id']}/meter-readings",
                    body,
                )
                if status == 409 and isinstance(result, dict) and result.get("error") == "lower_reading":
                    confirm_lower = True
                    pending_value = value
                    pending_note = note
                    message = (
                        f"Reading {value} is lower than current {result.get('current_value')}. "
                        "Confirm replacement, rollover, or correction below."
                    )
                elif status >= 400:
                    message = result.get("error", str(result)) if isinstance(result, dict) else str(result)
                else:
                    asset = result if isinstance(result, dict) else asset
                    message = "Meter updated."

        meter = asset.get("meter") or {}
        meter_type = meter.get("meter_type") or "none"
        unit = meter.get("unit") or "hrs"
        current = meter.get("current_value")
        name = html_module.escape(str(asset.get("name") or ""))
        tasks = asset.get("tasks") or []
        due_tasks = sorted(
            [t for t in tasks if t.get("remaining_meter") is not None],
            key=lambda t: t.get("remaining_meter", 999999),
        )[:3]

        task_rows = ""
        for task in due_tasks:
            item = html_module.escape(str(task.get("item") or "Service"))
            remaining = task.get("remaining_meter")
            overdue = task.get("overdue_meter")
            if overdue:
                status_text = "<span style='color:#f87171'>Overdue</span>"
            else:
                status_text = f"{remaining:.1f} {html_module.escape(unit)} remaining"
            task_rows += f"<li><strong>{item}</strong> — {status_text}</li>"

        btn_label = meter_button_label(meter_type)
        form_block = ""
        if meter_type != "none":
            if confirm_lower and pending_value is not None:
                form_block = f"""
<form method="post" style="margin-top:16px">
  <input type="hidden" name="value" value="{pending_value}" />
  <input type="hidden" name="note" value="{html_module.escape(pending_note)}" />
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
  <div class="meter">{current if current is not None else '—'} <span style="font-size:24px">{html_module.escape(unit)}</span></div>
  {"<div class='msg'>" + html_module.escape(message) + "</div>" if message else ""}
  {form_block}
  <h2>Upcoming service</h2>
  <ul>{task_rows or "<li>No meter-based tasks linked yet.</li>"}</ul>
</div>
</body></html>"""
        return page
