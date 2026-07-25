#!/usr/bin/env bash
set -u

export TZ="America/Chicago"

BASE="/home/gravesab/ai/projects/openclaw"
REPORT_DIR="$BASE/reports/daily-briefings"
mkdir -p "$REPORT_DIR"

DATE_HUMAN="$(date '+%A, %B %d, %Y')"
DATE_TIME_HUMAN="$(date '+%A, %B %d, %Y %I:%M %p %Z')"
DATE_FILE="$(date '+%Y%m%d-%H%M%S')"
BRIEFING_FILE="$REPORT_DIR/daily-executive-briefing-$DATE_FILE.txt"
SEND="$BASE/tools/telegram/send-telegram.sh"

critical=0
warnings=0
healthy=0
CRITICAL_ITEMS=""
WARNING_ITEMS=""
HEALTHY_ITEMS=""
ACTIONS=""

add_healthy() {
  healthy=$((healthy + 1))
  HEALTHY_ITEMS="${HEALTHY_ITEMS}✅ $1
"
}

add_warning() {
  warnings=$((warnings + 1))
  WARNING_ITEMS="${WARNING_ITEMS}⚠️ $1
"
}

add_critical() {
  critical=$((critical + 1))
  CRITICAL_ITEMS="${CRITICAL_ITEMS}🚨 $1
"
}

add_action() {
  ACTIONS="${ACTIONS}• $1
"
}

svc_status() {
  systemctl --user is-active "$1" 2>/dev/null | head -1 || echo "unknown"
}

docker_status() {
  docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null || echo "unknown"
}

disk_line() {
  df -h "$1" 2>/dev/null | awk 'NR==2 {print $3 " used / " $2 " total (" $5 "), " $4 " free"}' || echo "unknown"
}

OPENCLAW_BACKUP_REPORT="$BASE/reports/system_manager/openclaw_backup_watchdog_report.txt"
DASHBOARD_BACKUP_REPORT="$BASE/reports/system_manager/dashboard_property_backup_watchdog_report.txt"

report_colon_field() {
  local file="$1"
  local key="$2"

  if [ ! -f "$file" ]; then
    echo ""
    return 0
  fi

  awk -v key="$key" -F': ' '$1 == key { sub(/^[^:]*: /, ""); print; exit }' "$file"
}

report_equals_field() {
  local file="$1"
  local key="$2"

  if [ ! -f "$file" ]; then
    echo ""
    return 0
  fi

  awk -v key="$key" -F'=' '$1 == key { print substr($0, index($0, "=") + 1); exit }' "$file"
}

manager_smart_exit_needs_attention() {
  local code="$1"

  case "$code" in
    ""|none|NONE|0) return 1 ;;
    *) return 0 ;;
  esac
}

backup_discovery_failed() {
  local alert_reason="$1"
  local auto_skipped="$2"

  echo "$alert_reason" | grep -qi 'discovery' && return 0
  echo "$auto_skipped" | grep -qi 'discovery' && return 0
  return 1
}

format_backup_display_line() {
  local icon="$1"
  local filename="$2"
  local age="$3"
  local size="$4"
  local latest_time="$5"

  printf '%s %s\n• Age: %s day(s)\n• Size: %s\n• Time: %s' \
    "$icon" "$filename" "$age" "$size" "$latest_time"
}

evaluate_backup_watchdog_report() {
  local report_file="$1"
  local system_label="$2"
  local healthy_summary="$3"
  local manager_cmd="$4"
  local -n out_line="$5"

  local status latest latest_time age size alert_reason auto_enabled auto_skipped manager_exit
  local filename icon needs_attention attention_bits

  if [ ! -f "$report_file" ]; then
    add_critical "$system_label backup watchdog report missing"
    add_action "Check $system_label backup watchdog report: $report_file"
    out_line="$(format_backup_display_line "🚨" "report missing" "unknown" "unknown" "unknown")"
    return 0
  fi

  status="$(report_colon_field "$report_file" "Status")"
  latest="$(report_colon_field "$report_file" "Latest Backup")"
  if [ -z "$latest" ] || [ "$latest" = "none" ]; then
    latest="$(report_colon_field "$report_file" "Latest Production Backup")"
  fi

  latest_time="$(report_colon_field "$report_file" "Latest Backup Time")"
  age="$(report_colon_field "$report_file" "Latest Backup Age Days")"
  size="$(report_colon_field "$report_file" "Latest Backup Size")"
  alert_reason="$(report_colon_field "$report_file" "Alert Reason")"
  auto_enabled="$(report_colon_field "$report_file" "Auto Enabled")"
  auto_skipped="$(report_equals_field "$report_file" "AUTO_SKIPPED_REASON")"
  manager_exit="$(report_colon_field "$report_file" "Manager Smart Exit Code")"

  filename="none"
  if [ -n "$latest" ] && [ "$latest" != "none" ]; then
    filename="$(basename "$latest")"
  fi

  [ -n "$age" ] && [ "$age" != "unknown" ] || age="unknown"
  [ -n "$size" ] && [ "$size" != "unknown" ] || size="unknown"
  [ -n "$latest_time" ] && [ "$latest_time" != "none" ] || latest_time="unknown"

  needs_attention=0
  attention_bits=""

  if [ "$status" != "ok" ]; then
    needs_attention=1
    attention_bits="Status is ${status:-unknown}"
  fi

  if backup_discovery_failed "$alert_reason" "$auto_skipped"; then
    needs_attention=1
    attention_bits="${attention_bits:+${attention_bits}; }backup discovery failed"
  fi

  if manager_smart_exit_needs_attention "$manager_exit"; then
    needs_attention=1
    attention_bits="${attention_bits:+${attention_bits}; }manager smart exit code $manager_exit"
  fi

  if [ -n "$auto_skipped" ] && [ "$auto_skipped" != "none" ]; then
    needs_attention=1
    attention_bits="${attention_bits:+${attention_bits}; }auto skipped: $auto_skipped"
  fi

  if [ "$needs_attention" -eq 0 ]; then
    icon="✅"
    add_healthy "$healthy_summary"
    out_line="$(format_backup_display_line "$icon" "$filename" "$age" "$size" "$latest_time")"
    return 0
  fi

  icon="🚨"
  add_critical "$system_label backup needs attention (${attention_bits:-see watchdog report})"

  if [ "$auto_enabled" = "1" ]; then
    if manager_smart_exit_needs_attention "$manager_exit"; then
      add_action "Automatic $system_label backup remediation failed (exit $manager_exit); run: $manager_cmd"
    elif [ -n "$auto_skipped" ] && [ "$auto_skipped" != "none" ]; then
      add_action "Automatic $system_label backup skipped ($auto_skipped); check watchdog report"
    elif backup_discovery_failed "$alert_reason" "$auto_skipped"; then
      add_action "Automatic $system_label backup discovery failed; check storage mount and watchdog report"
    elif [ "$status" = "critical" ]; then
      add_action "Automatic $system_label backup remediation failed or was skipped; check watchdog report"
    fi
  else
    add_action "Enable automatic $system_label backup or run: $manager_cmd"
  fi

  out_line="$(format_backup_display_line "$icon" "$filename" "$age" "$size" "$latest_time")"
}

dashboard_http_status() {
  if curl -fsS --max-time 10 -I http://127.0.0.1:5051/ >/dev/null 2>&1; then
    echo "active"
  else
    svc_status openclaw-dashboard.service
  fi
}

DASHBOARD_STATUS="$(dashboard_http_status)"
GATEWAY_STATUS="$(svc_status openclaw-gateway.service)"
LISTENER_STATUS="$(svc_status openclaw-listener.service)"
DOCKER_STATUS="$(systemctl is-active docker 2>/dev/null | head -1 || echo unknown)"
HA_STATUS="$(docker_status homeassistant)"
REDIS_STATUS="$(docker_status redis)"
POSTGRES_STATUS="$(docker_status postgres)"
SCRYPTED_STATUS="$(docker_status scrypted)"
DOCKER_COUNT="$(docker ps -q 2>/dev/null | wc -l | tr -d ' ')"
DOCKER_UNHEALTHY="$(docker ps --filter health=unhealthy --format '{{.Names}}' 2>/dev/null | paste -sd ', ' -)"
PROPERTY_API_HEALTH="$(curl -fsS --max-time 5 http://127.0.0.1:5062/health 2>/dev/null || true)"
PACKAGE_UPDATE_COUNT="$(apt list --upgradable 2>/dev/null | tail -n +2 | grep -c . || true)"
TAILSCALE_PEERS="$(tailscale status 2>/dev/null | grep -E 'andrew-m4-max|ipad|iphone|intelmini' | wc -l | tr -d ' ')"

[ "$DASHBOARD_STATUS" = "active" ] && add_healthy "Dashboard online" || { add_critical "Dashboard is $DASHBOARD_STATUS"; add_action "systemctl --user restart openclaw-dashboard"; }
[ "$GATEWAY_STATUS" = "active" ] && add_healthy "OpenClaw Gateway active" || { add_critical "OpenClaw Gateway is $GATEWAY_STATUS"; add_action "systemctl --user restart openclaw-gateway"; }
[ "$LISTENER_STATUS" = "active" ] && add_healthy "OpenClaw Listener active" || add_warning "OpenClaw Listener is $LISTENER_STATUS"
[ "$DOCKER_STATUS" = "active" ] && add_healthy "Docker active" || add_critical "Docker is $DOCKER_STATUS"

[ "$HA_STATUS" = "running" ] && add_healthy "Home Assistant running" || add_critical "Home Assistant is $HA_STATUS"
[ "$REDIS_STATUS" = "running" ] && add_healthy "Redis running" || add_warning "Redis is $REDIS_STATUS"
[ "$POSTGRES_STATUS" = "running" ] && add_healthy "PostgreSQL running" || add_warning "PostgreSQL is $POSTGRES_STATUS"
[ "$SCRYPTED_STATUS" = "running" ] && add_healthy "Scrypted running" || add_warning "Scrypted is $SCRYPTED_STATUS"

AI_TELEMETRY_STATUS="unavailable"
AI_TELEMETRY_SUMMARY="AI routing telemetry unavailable"
AI_PYTHON="$BASE/tools/ai_intelligence/.venv/bin/python"
if [ ! -x "$AI_PYTHON" ]; then
  AI_PYTHON="$BASE/.venv/bin/python"
fi
if [ -x "$AI_PYTHON" ] && [ -f "$BASE/tools/ai_intelligence/report_routing_telemetry.py" ]; then
  if AI_TELEMETRY_OUTPUT="$("$AI_PYTHON" "$BASE/tools/ai_intelligence/report_routing_telemetry.py" 2>/dev/null)"; then
    AI_TELEMETRY_SUMMARY="$(printf '%s\n' "$AI_TELEMETRY_OUTPUT" | head -n 8)"
    AI_TELEMETRY_STATUS="$(printf '%s\n' "$AI_TELEMETRY_OUTPUT" | awk -F': ' '/^Status:/{print $2; exit}')"
    case "$AI_TELEMETRY_STATUS" in
      healthy)
        add_healthy "AI routing telemetry healthy"
        ;;
      failover-active)
        add_warning "AI routing telemetry reports recent failover"
        add_action "Review AI routing telemetry: $BASE/reports/ai_intelligence/routing-telemetry-latest.txt"
        ;;
      attention)
        add_warning "AI routing telemetry needs attention"
        add_action "Review AI routing drift/failover: $BASE/reports/ai_intelligence/routing-telemetry-latest.txt"
        ;;
      *)
        add_warning "AI routing telemetry status is ${AI_TELEMETRY_STATUS:-unknown}"
        ;;
    esac
  else
    add_warning "AI routing telemetry report failed"
  fi
fi

if [ -n "$DOCKER_UNHEALTHY" ]; then
  add_warning "Docker has unhealthy containers: $DOCKER_UNHEALTHY"
  add_action "Run: docker ps --filter health=unhealthy"
else
  add_healthy "No unhealthy Docker containers"
fi

if echo "$PROPERTY_API_HEALTH" | grep -q '"status"[[:space:]]*:[[:space:]]*"ok"'; then
  add_healthy "PropertyManager API healthy"
  PROPERTY_API_STATUS="✅ Healthy"
else
  add_warning "PropertyManager API not responding"
  add_action "Run: systemctl --user restart propertymanager-api.service"
  PROPERTY_API_STATUS="⚠️ Not responding"
fi

if [ "$PACKAGE_UPDATE_COUNT" -gt 0 ]; then
  add_warning "$PACKAGE_UPDATE_COUNT package updates available"
  add_action "Review updates during maintenance window: apt list --upgradable"
else
  add_healthy "No pending package updates"
fi

if [ "$TAILSCALE_PEERS" -ge 2 ]; then
  add_healthy "Tailscale peers visible"
  TAILSCALE_STATUS="✅ $TAILSCALE_PEERS peers visible"
else
  add_warning "Tailscale peer visibility low"
  add_action "Run: tailscale status"
  TAILSCALE_STATUS="⚠️ $TAILSCALE_PEERS peers visible"
fi

M4_TAGS=""
for attempt in 1 2 3; do
  M4_TAGS="$(curl -fsS --max-time 15 http://127.0.0.1:11435/api/tags 2>/dev/null || true)"

  if python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    raise SystemExit(0 if len(data.get("models", [])) > 0 else 1)
except Exception:
    raise SystemExit(1)
' <<< "$M4_TAGS"; then
    break
  fi

  if [ "$attempt" -lt 3 ]; then
    sleep 5
  fi
done
M4_MODELS="$(python3 - <<PY
import json
raw = '''$M4_TAGS'''
try:
    print(len(json.loads(raw).get("models", [])))
except Exception:
    print("unknown")
PY
)"

if [[ "$M4_MODELS" =~ ^[0-9]+$ ]] && [ "$M4_MODELS" -gt 0 ]; then
  add_healthy "M4 Ollama reachable with $M4_MODELS models"
  M4_STATUS="✅ Online — $M4_MODELS models visible"
else
  add_warning "M4 Ollama model inventory unavailable"
  add_action "Check M4 Ollama launch settings"
  M4_STATUS="⚠️ Model inventory unavailable"
fi

evaluate_backup_watchdog_report \
  "$OPENCLAW_BACKUP_REPORT" \
  "Full OpenClaw checkpoint" \
  "Full OpenClaw checkpoint backup is current" \
  "tools/system_manager/openclaw-backup-manager.sh smart" \
  OPENCLAW_BACKUP_LINE

evaluate_backup_watchdog_report \
  "$DASHBOARD_BACKUP_REPORT" \
  "Dashboard / PropertyManager" \
  "Dashboard / PropertyManager backup is current" \
  "tools/dashboard/dashboard-property-backup-manager.sh smart" \
  DASHBOARD_BACKUP_LINE

TM_REPORT="$($BASE/tools/system_manager/m4-timemachine-report.sh 2>/dev/null | sed -n '1,32p' || true)"
if echo "$TM_REPORT" | grep -qi "failed\|unavailable\|error\|🚨"; then
  add_warning "Time Machine needs attention"
  add_action "tm status"
else
  add_healthy "Time Machine report generated"
fi

PROPERTY_REPORT="$($BASE/tools/property_manager/propertymanager-summary.sh 2>/dev/null | sed -n '1,28p' || true)"
CALENDAR_REPORT="$($BASE/tools/calendar/apple-calendar-summary.sh 2>/dev/null | sed -n '1,22p' || true)"
MAIL_REPORT="$(MAILMANAGER_TELEGRAM=0 $BASE/tools/mailmanager/mailmanager2-summary.sh 2>/dev/null | sed -n '1,22p' || true)"

INTEL_DISK="$(disk_line /)"
AI_DISK="$(disk_line /mnt/ai-storage)"

if [ "$critical" -gt 0 ]; then
  OVERALL="🔴 ATTENTION REQUIRED"
elif [ "$warnings" -gt 0 ]; then
  OVERALL="🟡 WATCH"
else
  OVERALL="🟢 HEALTHY"
fi

[ -n "$CRITICAL_ITEMS" ] || CRITICAL_ITEMS="✅ No critical issues
"
[ -n "$WARNING_ITEMS" ] || WARNING_ITEMS="✅ No warnings
"
[ -n "$ACTIONS" ] || ACTIONS="• No action needed
"

cat > "$BRIEFING_FILE" <<EOF2
🌳 OpenClaw Ranch Daily Briefing
$DATE_HUMAN
Generated: $DATE_TIME_HUMAN

Overall Status: $OVERALL

━━━━━━━━━━━━━━━━━━
🚨 Critical Issues: $critical
━━━━━━━━━━━━━━━━━━
$CRITICAL_ITEMS
━━━━━━━━━━━━━━━━━━
⚠️ Warnings: $warnings
━━━━━━━━━━━━━━━━━━
$WARNING_ITEMS
━━━━━━━━━━━━━━━━━━
✅ Healthy Systems: $healthy
━━━━━━━━━━━━━━━━━━
$HEALTHY_ITEMS
━━━━━━━━━━━━━━━━━━
🤖 AI Infrastructure
━━━━━━━━━━━━━━━━━━
Intel Mini:
• Gateway: $GATEWAY_STATUS
• Dashboard: $DASHBOARD_STATUS
• Listener: $LISTENER_STATUS
• Docker containers running: $DOCKER_COUNT
• Docker unhealthy: ${DOCKER_UNHEALTHY:-none}
• PropertyManager API: $PROPERTY_API_STATUS
• Tailscale: $TAILSCALE_STATUS
• Pending package updates: $PACKAGE_UPDATE_COUNT

M4 AI Workstation:
• Ollama: $M4_STATUS

AI Routing Telemetry:
• Status: ${AI_TELEMETRY_STATUS:-unavailable}
$AI_TELEMETRY_SUMMARY

━━━━━━━━━━━━━━━━━━
💾 Backup Status
━━━━━━━━━━━━━━━━━━
Full OpenClaw Checkpoint Backup:
$OPENCLAW_BACKUP_LINE

Dashboard / PropertyManager Backup:
$DASHBOARD_BACKUP_LINE

━━━━━━━━━━━━━━━━━━
🕒 Time Machine
━━━━━━━━━━━━━━━━━━
$TM_REPORT

━━━━━━━━━━━━━━━━━━
🏡 PropertyManager
━━━━━━━━━━━━━━━━━━
$PROPERTY_REPORT

━━━━━━━━━━━━━━━━━━
📅 CalendarManager
━━━━━━━━━━━━━━━━━━
$CALENDAR_REPORT

━━━━━━━━━━━━━━━━━━
📬 MailManager
━━━━━━━━━━━━━━━━━━
$MAIL_REPORT

━━━━━━━━━━━━━━━━━━
📈 Storage
━━━━━━━━━━━━━━━━━━
Intel Mini:
• Internal Ubuntu Disk: $INTEL_DISK
• External AI Storage: $AI_DISK

━━━━━━━━━━━━━━━━━━
✅ Suggested Actions
━━━━━━━━━━━━━━━━━━
$ACTIONS
End of Report
EOF2

RANCHBRAIN_DIR="$BASE/ranchbrain/documents/openclaw"
RANCHBRAIN_FILE="$RANCHBRAIN_DIR/$(basename "$BRIEFING_FILE")"

mkdir -p "$RANCHBRAIN_DIR"
cp -f "$BRIEFING_FILE" "$RANCHBRAIN_FILE"

if [ "${DAILY_BRIEFING_NO_SEND:-0}" != "1" ] && [ -x "$SEND" ]; then
  "$SEND" "$(cat "$BRIEFING_FILE")" >/dev/null 2>&1 || true
fi

echo "Saved briefing: $BRIEFING_FILE"
echo "Saved RanchBrain copy: $RANCHBRAIN_FILE"
