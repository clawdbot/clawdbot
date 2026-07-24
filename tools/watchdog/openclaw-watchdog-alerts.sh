#!/usr/bin/env bash
set -euo pipefail

BASE="$HOME/ai/projects/openclaw"
STATE_DIR="$BASE/reports/watchdog"
STATE_FILE="$STATE_DIR/watchdog-state.env"
SEND_TELEGRAM="$BASE/tools/telegram/send-telegram.sh"

mkdir -p "$STATE_DIR"
touch "$STATE_FILE"

service_status() {
  systemctl is-active "$1" 2>/dev/null | head -1 || echo "unknown"
}

dashboard_http_status() {
  if curl -fsS --max-time 15 -I http://127.0.0.1:5051/ >/dev/null 2>&1; then
    echo "active"
  else
    systemctl is-active openclaw-dashboard.service 2>/dev/null | head -1 || echo "unknown"
  fi
}

docker_container_status() {
  docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null || echo "missing"
}

disk_pct() {
  df -P "$1" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}' || echo 0
}

latest_file() {
  local pattern="$1"
  ls -t $pattern 2>/dev/null | head -1 || true
}

backup_age_days() {
  local file="$1"
  if [ -z "$file" ] || [ ! -f "$file" ]; then
    echo 999
    return
  fi

  local now modified
  now="$(date +%s)"
  modified="$(stat -c %Y "$file")"
  echo $(( (now - modified) / 86400 ))
}

add_alert() {
  ALERTS+="$1"$'\n'
}

cd "$BASE"

ALERTS=""

OPENCLAW_STATUS="problem"
if pnpm openclaw status --deep >/tmp/openclaw-watchdog-openclaw-status.txt 2>&1; then
  OPENCLAW_STATUS="healthy"
fi

DASHBOARD_STATUS="$(dashboard_http_status)"
LISTENER_STATUS="$(service_status openclaw-listener.service)"
DOCKER_STATUS="$(service_status docker)"

HA_STATUS="$(docker_container_status homeassistant)"
REDIS_STATUS="$(docker_container_status redis)"
POSTGRES_STATUS="$(docker_container_status postgres)"
SCRYPTED_STATUS="$(docker_container_status scrypted)"

INTERNAL_DISK="$(disk_pct /)"
AI_DISK="$(disk_pct /mnt/ai-storage)"

LATEST_OPENCLAW_BACKUP="$(
  find /mnt/ai-storage/openclaw-backups -type f \
    \( -name '*openclaw*backup*.tar.gz' -o -name '*openclaw*checkpoint*.tar.gz' -o -name '*openclaw*.tgz' \) \
    2>/dev/null | grep -vi 'dashboard' | xargs -r ls -t 2>/dev/null | head -1
)"

LATEST_DASHBOARD_BACKUP="$(
  find /mnt/ai-storage/openclaw-backups/dashboard-property-backups "$HOME/openclaw-dashboard-backups" -type f \
    \( -name '*dashboard*backup*.tar.gz' -o -name '*dashboard-property-backup*.tar.gz' \) \
    2>/dev/null | xargs -r ls -t 2>/dev/null | head -1
)"

OPENCLAW_BACKUP_AGE="$(backup_age_days "$LATEST_OPENCLAW_BACKUP")"
DASHBOARD_BACKUP_AGE="$(backup_age_days "$LATEST_DASHBOARD_BACKUP")"

M4_HEALTH="$(
ssh -i "$HOME/.ssh/id_ed25519_openclaw_m4" \
  -o BatchMode=yes \
  -o ConnectTimeout=5 \
  andrewgraves@100.104.100.96 \
  "~/openclaw-m4-monitor/m4-health.sh" 2>/dev/null || true
)"

M4_REACHABLE="no"
M4_OLLAMA="unknown"
M4_MEMORY_PERCENT="0"
M4_DISK_PERCENT="0"
M4_RESPONSE_MS="0"

if [ -n "$M4_HEALTH" ]; then
  M4_VALUES="$(python3 - <<PY
import json
raw = '''$M4_HEALTH'''
try:
    j = json.loads(raw)
except Exception:
    j = {}

print("|".join([
    "yes" if j.get("status", "ok") != "error" and j else "no",
    str(j.get("ollama_api", "unknown")),
    str(j.get("memory_used_percent", 0)),
    str(j.get("disk_used_percent", 0)),
    str(j.get("ollama_response_ms", 0)),
]))
PY
)"
  IFS='|' read -r M4_REACHABLE M4_OLLAMA M4_MEMORY_PERCENT M4_DISK_PERCENT M4_RESPONSE_MS <<< "$M4_VALUES"
fi

[ "$OPENCLAW_STATUS" = "healthy" ] || add_alert "🚨 OpenClaw status is $OPENCLAW_STATUS"

if [ "$DASHBOARD_STATUS" != "active" ] && [ "$DASHBOARD_STATUS" != "activating" ]; then
  add_alert "🚨 Dashboard service is $DASHBOARD_STATUS"
fi

[ "$LISTENER_STATUS" = "active" ] || add_alert "🚨 Listener service is $LISTENER_STATUS"
[ "$DOCKER_STATUS" = "active" ] || add_alert "🚨 Docker service is $DOCKER_STATUS"

[ "$HA_STATUS" = "running" ] || add_alert "🚨 Home Assistant container is $HA_STATUS"
[ "$REDIS_STATUS" = "running" ] || add_alert "🚨 Redis container is $REDIS_STATUS"
[ "$POSTGRES_STATUS" = "running" ] || add_alert "🚨 PostgreSQL container is $POSTGRES_STATUS"
[ "$SCRYPTED_STATUS" = "running" ] || add_alert "🚨 Scrypted container is $SCRYPTED_STATUS"

if [ "$INTERNAL_DISK" -ge 90 ]; then
  add_alert "🚨 Internal Ubuntu disk is critical: ${INTERNAL_DISK}% used"
elif [ "$INTERNAL_DISK" -ge 80 ]; then
  add_alert "⚠️ Internal Ubuntu disk warning: ${INTERNAL_DISK}% used"
fi

if [ "$AI_DISK" -ge 90 ]; then
  add_alert "🚨 External AI storage is critical: ${AI_DISK}% used"
elif [ "$AI_DISK" -ge 80 ]; then
  add_alert "⚠️ External AI storage warning: ${AI_DISK}% used"
fi

if [ "$OPENCLAW_BACKUP_AGE" -ge 10 ]; then
  add_alert "⚠️ OpenClaw backup is $OPENCLAW_BACKUP_AGE days old"
fi

if [ "$DASHBOARD_BACKUP_AGE" -ge 10 ]; then
  add_alert "⚠️ Dashboard backup is $DASHBOARD_BACKUP_AGE days old"
fi

[ "$M4_REACHABLE" = "yes" ] || add_alert "🚨 M4 is not reachable over Tailscale/SSH"
[ "$M4_OLLAMA" = "online" ] || add_alert "🚨 M4 Ollama API is $M4_OLLAMA"

M4_MEMORY_INT="$(printf "%.0f" "$M4_MEMORY_PERCENT" 2>/dev/null || echo 0)"
M4_DISK_INT="$(printf "%.0f" "$M4_DISK_PERCENT" 2>/dev/null || echo 0)"
M4_RESPONSE_INT="$(printf "%.0f" "$M4_RESPONSE_MS" 2>/dev/null || echo 0)"

# Apple Silicon unified memory often appears highly used when Ollama is healthy.
# Do not alert on memory percentage alone. Use reachability, Ollama status,
# response latency, swap pressure, or macOS memory pressure in a future check.

if [ "$M4_DISK_INT" -ge 90 ]; then
  add_alert "🚨 M4 disk is critical: ${M4_DISK_PERCENT}% used"
elif [ "$M4_DISK_INT" -ge 85 ]; then
  add_alert "⚠️ M4 disk warning: ${M4_DISK_PERCENT}% used"
fi

if [ "$M4_RESPONSE_INT" -ge 5000 ]; then
  add_alert "⚠️ M4 Ollama response is slow: ${M4_RESPONSE_MS} ms"
fi

if [ -z "$ALERTS" ]; then
  OVERALL_STATUS="healthy"
else
  OVERALL_STATUS="warning"
fi

ALERT_HASH="$(printf "%s" "$ALERTS" | sha256sum | awk '{print $1}')"

source "$STATE_FILE" 2>/dev/null || true

if [ "$OVERALL_STATUS" = "healthy" ]; then
  if [ "${LAST_STATUS:-}" != "healthy" ]; then
    "$SEND_TELEGRAM" "✅ OpenClaw Watchdog Recovery

All monitored systems are healthy again.

Time: $(date '+%A, %B %d, %Y %I:%M %p')" >/dev/null
  fi

  cat > "$STATE_FILE" <<STATE
LAST_STATUS="healthy"
LAST_ALERT_HASH=""
LAST_RUN="$(date '+%Y-%m-%d %H:%M:%S')"
STATE

  echo "Watchdog healthy. No alert sent."
  exit 0
fi

if [ "${LAST_ALERT_HASH:-}" = "$ALERT_HASH" ]; then
  cat > "$STATE_FILE" <<STATE
LAST_STATUS="warning"
LAST_ALERT_HASH="$ALERT_HASH"
LAST_RUN="$(date '+%Y-%m-%d %H:%M:%S')"
STATE

  echo "Same watchdog alert already sent. No duplicate Telegram message."
  exit 0
fi

MESSAGE="🚨 OpenClaw Watchdog Alert

$ALERTS
Current Snapshot:
OpenClaw: $OPENCLAW_STATUS
Dashboard: $DASHBOARD_STATUS
Listener: $LISTENER_STATUS
Docker: $DOCKER_STATUS

Home Assistant: $HA_STATUS
Redis: $REDIS_STATUS
PostgreSQL: $POSTGRES_STATUS
Scrypted: $SCRYPTED_STATUS

Internal Disk: ${INTERNAL_DISK}%
AI Storage: ${AI_DISK}%

M4 Reachable: $M4_REACHABLE
M4 Ollama: $M4_OLLAMA
M4 Memory: ${M4_MEMORY_PERCENT}%
M4 Disk: ${M4_DISK_PERCENT}%
M4 Ollama Response: ${M4_RESPONSE_MS} ms

Time: $(date '+%A, %B %d, %Y %I:%M %p')"

"$SEND_TELEGRAM" "$MESSAGE" >/dev/null

cat > "$STATE_FILE" <<STATE
LAST_STATUS="warning"
LAST_ALERT_HASH="$ALERT_HASH"
LAST_RUN="$(date '+%Y-%m-%d %H:%M:%S')"
STATE

echo "Watchdog alert sent."
