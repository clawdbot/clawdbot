#!/usr/bin/env bash
set -euo pipefail

BASE="/home/gravesab/ai/projects/openclaw"
REPORT="$BASE/tools/system_manager/m4-timemachine-report.sh"
SEND="$BASE/tools/telegram/send-telegram.sh"
JSON="$BASE/reports/system_manager/m4_timemachine_status.json"
STATE_DIR="$BASE/reports/system_manager/state"
STATE_FILE="$STATE_DIR/m4-timemachine-watchdog-last-alert.txt"

mkdir -p "$STATE_DIR"

"$REPORT" >/tmp/m4-tm-report.txt 2>/dev/null || true

STATUS="$(python3 - <<'PY'
import json
from pathlib import Path
p=Path("/home/gravesab/ai/projects/openclaw/reports/system_manager/m4_timemachine_status.json")
if not p.exists():
    print("missing")
else:
    print(json.loads(p.read_text()).get("status","Unknown"))
PY
)"

TODAY="$(date +%F)"

if [ "$STATUS" != "Current" ]; then
  if [ -f "$STATE_FILE" ] && grep -q "$TODAY" "$STATE_FILE"; then
    exit 0
  fi

  "$SEND" "🚨 M4 Time Machine Alert

$(cat /tmp/m4-tm-report.txt)

Recommended action:
Check QNAP TMBackup availability and Time Machine mount status."

  echo "$TODAY" > "$STATE_FILE"
fi
