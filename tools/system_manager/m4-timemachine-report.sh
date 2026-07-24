#!/usr/bin/env bash
set -euo pipefail

BASE="/home/gravesab/ai/projects/openclaw"
PULL="$BASE/tools/system_manager/pull-m4-timemachine-status.sh"
JSON="$BASE/reports/system_manager/m4_timemachine_status.json"

"$PULL" >/dev/null

python3 - "$JSON" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text())

status = data.get("status", "Unknown")
running = str(data.get("time_machine_running", "false")).lower() == "true"

if running:
    icon = "🔄"
    display_status = "Currently Running"
elif status == "Current":
    icon = "✅"
    display_status = "Current"
else:
    icon = "🚨"
    display_status = status

print("💾 M4 Time Machine Status")
print()
print(f"{icon} Status: {display_status}")
print(f"Checked: {data.get('checked_at', 'unknown')}")
print(f"Host: {data.get('host', 'unknown')}")
print(f"Destination: {data.get('destination_name', 'unknown')}")
print(f"Destination Configured: {data.get('destination_configured', 'unknown')}")
print(
    "QNAP: "
    f"{data.get('qnap_ip', 'unknown')} "
    f"ping={data.get('qnap_ping', 'unknown')} "
    f"smb445={data.get('smb_445', 'unknown')}"
)

if running:
    phase = data.get("backup_phase") or "In progress"
    percent = data.get("percent_complete")
    remaining = data.get("time_remaining_seconds")

    print("Time Machine Running: true")
    print(f"Backup Phase: {phase}")

    if percent is not None:
        print(f"Progress: {percent}%")

    if remaining is not None:
        minutes, seconds = divmod(int(remaining), 60)
        if minutes:
            print(f"Time Remaining: approximately {minutes} minute(s)")
        else:
            print(f"Time Remaining: approximately {seconds} second(s)")
else:
    print("Time Machine Running: false")

last_backup = data.get("last_backup_path") or ""
if last_backup:
    print(f"Last Completed Backup: {last_backup}")
else:
    print("Last Completed Backup: unavailable")

error = data.get("error") or ""
if error:
    print()
    print("Error:")
    print(error[:700])
PY
