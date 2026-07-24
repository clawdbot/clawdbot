#!/usr/bin/env bash
set -euo pipefail

REPORT_DIR="$HOME/ai/projects/openclaw/reports"
TREND_FILE="$REPORT_DIR/trends.csv"

mkdir -p "$REPORT_DIR"

HEADER="timestamp,ollama_latency_ms,mem_used_gib,mem_total_gib,disk_used_pct,m4_mem_used_gib,m4_mem_total_gib,m4_cpu_used_pct,m4_disk_used_pct,m4_ollama_response_ms,homeassistant_uptime,redis_uptime,portainer_uptime,postgres_uptime,scrypted_uptime"

if [ ! -f "$TREND_FILE" ]; then
  echo "$HEADER" > "$TREND_FILE"
fi

CURRENT_HEADER="$(head -1 "$TREND_FILE" 2>/dev/null || true)"

if [ "$CURRENT_HEADER" != "$HEADER" ]; then
  cp "$TREND_FILE" "$TREND_FILE.before-m4-health-script-wire-$(date +%Y%m%d-%H%M%S)"

  python3 - <<'PY'
from pathlib import Path
import csv

trend = Path.home() / "ai/projects/openclaw/reports/trends.csv"

header = [
    "timestamp",
    "ollama_latency_ms",
    "mem_used_gib",
    "mem_total_gib",
    "disk_used_pct",
    "m4_mem_used_gib",
    "m4_mem_total_gib",
    "m4_cpu_used_pct",
    "m4_disk_used_pct",
    "m4_ollama_response_ms",
    "homeassistant_uptime",
    "redis_uptime",
    "portainer_uptime",
    "postgres_uptime",
    "scrypted_uptime",
]

rows = []
if trend.exists():
    with trend.open(newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            for key in header:
                row.setdefault(key, "")
            rows.append(row)

with trend.open("w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=header)
    writer.writeheader()
    for row in rows:
        writer.writerow({k: row.get(k, "") for k in header})
PY
fi

TS="$(date '+%Y-%m-%d %H:%M:%S')"

LATENCY="$(
  curl -s -w '%{time_total}' -o /dev/null http://127.0.0.1:11434/api/tags 2>/dev/null \
  | awk '{printf "%.0f", $1 * 1000}' || echo 0
)"

MEM_USED="$(free -g | awk '/Mem:/ {print $3}')"
MEM_TOTAL="$(free -g | awk '/Mem:/ {print $2}')"
DISK_USED="$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')"

M4_JSON="$(
ssh -i "$HOME/.ssh/id_ed25519_openclaw_m4" \
  -o BatchMode=yes \
  -o ConnectTimeout=5 \
  andrewgraves@100.104.100.96 \
  "~/openclaw-m4-monitor/m4-health.sh" 2>/dev/null || true
)"

M4_VALUES="$(
python3 - <<PY
import json

data = '''$M4_JSON'''

try:
    obj = json.loads(data)
except Exception:
    obj = {}

print(",".join([
    str(obj.get("memory_used_gib", "")),
    str(obj.get("memory_total_gib", "")),
    str(obj.get("cpu_used_percent", "")),
    str(obj.get("disk_used_percent", "")),
    str(obj.get("ollama_response_ms", "")),
]))
PY
)"

M4_MEM_USED="$(echo "$M4_VALUES" | awk -F',' '{print $1}')"
M4_MEM_TOTAL="$(echo "$M4_VALUES" | awk -F',' '{print $2}')"
M4_CPU_USED="$(echo "$M4_VALUES" | awk -F',' '{print $3}')"
M4_DISK_USED="$(echo "$M4_VALUES" | awk -F',' '{print $4}')"
M4_OLLAMA_MS="$(echo "$M4_VALUES" | awk -F',' '{print $5}')"

container_uptime() {
  docker ps --format '{{.Names}}|{{.Status}}' | awk -F'|' -v name="$1" '$1 == name {print $2}' | sed 's/^Up //'
}

HA_UP="$(container_uptime homeassistant)"
REDIS_UP="$(container_uptime redis)"
PORTAINER_UP="$(container_uptime portainer)"
POSTGRES_UP="$(container_uptime postgres)"
SCRYPTED_UP="$(container_uptime scrypted)"

echo "\"$TS\",$LATENCY,$MEM_USED,$MEM_TOTAL,$DISK_USED,$M4_MEM_USED,$M4_MEM_TOTAL,$M4_CPU_USED,$M4_DISK_USED,$M4_OLLAMA_MS,\"$HA_UP\",\"$REDIS_UP\",\"$PORTAINER_UP\",\"$POSTGRES_UP\",\"$SCRYPTED_UP\"" >> "$TREND_FILE"
