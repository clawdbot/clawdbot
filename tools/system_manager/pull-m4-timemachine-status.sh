#!/usr/bin/env bash
set -euo pipefail

OUT="/home/gravesab/ai/projects/openclaw/reports/system_manager/m4_timemachine_status.json"
TMP="$OUT.tmp"

M4_HOST="100.104.100.96"
M4_USER="andrewgraves"
SSH_KEY="/home/gravesab/.ssh/id_ed25519_openclaw_m4"
M4_SCRIPT="/Users/andrewgraves/.openclaw/bin/update-timemachine-status.sh"
M4_FILE="/Users/andrewgraves/.openclaw/status/m4_timemachine_status.json"

mkdir -p "$(dirname "$OUT")"
rm -f "$TMP"

# Refresh the status JSON on the M4.
ssh \
  -i "$SSH_KEY" \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes \
  "${M4_USER}@${M4_HOST}" \
  "$M4_SCRIPT"

# Copy the fresh JSON.
scp \
  -i "$SSH_KEY" \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes \
  -q \
  "${M4_USER}@${M4_HOST}:${M4_FILE}" \
  "$TMP"

# Validate it before replacing the existing file.
python3 - "$TMP" <<'PY'
import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
j = json.loads(p.read_text())

required = {
    "checked_at",
    "host",
    "destination_name",
    "status",
    "last_backup_path",
}

missing = sorted(required - set(j.keys()))
if missing:
    raise SystemExit(
        "Missing required JSON keys: " + ", ".join(missing)
    )
PY

mv "$TMP" "$OUT"
cat "$OUT"
