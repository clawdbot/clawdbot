#!/usr/bin/env bash
set -euo pipefail

BASE="/home/gravesab/ai/projects/openclaw"

SEND="${SEND:-$BASE/tools/telegram/send-telegram.sh}"
BACKUP_MANAGER="${BACKUP_MANAGER:-$BASE/tools/dashboard/dashboard-property-backup-manager.sh}"
BACKUP_MOUNT="${BACKUP_MOUNT:-/mnt/ai-storage}"
BACKUP_PARENT="${BACKUP_PARENT:-/mnt/ai-storage/openclaw-backups}"
BACKUP_DIR="${BACKUP_DIR:-$BACKUP_PARENT/dashboard-property-backups}"
BACKUP_GLOB="${BACKUP_GLOB:-dashboard-property-backup-*.tar.gz}"
STATE_DIR="${STATE_DIR:-$BASE/reports/system_manager/state}"
STATE_FILE="${STATE_FILE:-$STATE_DIR/dashboard-property-backup-watchdog.state}"
ACTION_STATE="${ACTION_STATE:-$STATE_DIR/dashboard-property-backup-last-action.txt}"
REPORT_FILE="${REPORT_FILE:-$BASE/reports/system_manager/dashboard_property_backup_watchdog_report.txt}"
AUTO_ENABLED="${DASHBOARD_PROPERTY_BACKUP_AUTO:-0}"
MAX_AGE_DAYS="${MAX_AGE_DAYS:-10}"

mkdir -p "$STATE_DIR" "$(dirname "$REPORT_FILE")"

now_epoch="$(date +%s)"
now_human="$(date '+%A, %B %d, %Y %I:%M %p')"

latest_backup=""
latest_epoch=0
latest_size="unknown"
status="ok"
alert_reason=""
age_days="unknown"
latest_human="none"
latest_rc=0
auto_skipped_reason="none"
manager_smart_exit_code="none"
manager_status_exit_code="none"
manager_status_summary="none"

send_telegram() {
  local message="$1"

  if [ -x "$SEND" ]; then
    "$SEND" "$message" >/dev/null || true
  else
    echo "Telegram sender not found or not executable: $SEND"
  fi
}

validate_storage_discovery() {
  if ! mountpoint -q "$BACKUP_MOUNT" 2>/dev/null; then
    return 2
  fi

  if [ ! -d "$BACKUP_PARENT" ]; then
    return 2
  fi

  if [ ! -r "$BACKUP_PARENT" ] || [ ! -x "$BACKUP_PARENT" ]; then
    return 2
  fi

  return 0
}

run_discovery() {
  local latest_line

  latest_backup=""
  latest_epoch=0
  latest_size="unknown"
  status="ok"
  alert_reason=""
  age_days="unknown"
  latest_human="none"

  if ! [[ "$MAX_AGE_DAYS" =~ ^[0-9]+$ ]]; then
    latest_rc=2
    status="critical"
    alert_reason="Invalid MAX_AGE_DAYS value: $MAX_AGE_DAYS."
    return 0
  fi

  if ! validate_storage_discovery; then
    latest_rc=2
    status="critical"
    alert_reason="Dashboard/property backup storage is unavailable (mount: $BACKUP_MOUNT, parent: $BACKUP_PARENT)."
    return 0
  fi

  if [ ! -d "$BACKUP_DIR" ]; then
    latest_rc=0
    status="critical"
    alert_reason="No dashboard/property backup was found."
    return 0
  fi

  latest_line="$(
    find "$BACKUP_DIR" -maxdepth 1 -type f -name "$BACKUP_GLOB" \
      -printf '%T@ %s %p\n' 2>/dev/null \
      | sort -nr \
      | head -1
  )"
  latest_rc=0

  if [ -z "$latest_line" ]; then
    status="critical"
    alert_reason="No dashboard/property backup was found."
    return 0
  fi

  latest_epoch="$(echo "$latest_line" | awk '{print $1}')"
  latest_epoch="${latest_epoch%.*}"
  latest_backup="$(echo "$latest_line" | cut -d' ' -f3-)"
  latest_size="$(du -h "$latest_backup" 2>/dev/null | awk '{print $1}')"
  age_days="$(( (now_epoch - latest_epoch) / 86400 ))"
  latest_human="$(date -d "@$latest_epoch" '+%A, %B %d, %Y %I:%M %p' 2>/dev/null || date -r "$latest_epoch" '+%A, %B %d, %Y %I:%M %p')"

  if [ "$age_days" -ge "$MAX_AGE_DAYS" ]; then
    status="critical"
    alert_reason="Dashboard/property backup is ${age_days} days old."
  fi
}

alert_hash_for_current_state() {
  printf '%s|%s|%s' "$status" "$latest_backup" "$age_days" | sha256sum | awk '{print $1}'
}

write_report() {
  cat > "$REPORT_FILE" <<REPORT
Dashboard/PropertyManager Backup Watchdog
Time: $now_human
Status: $status
Max Age Days: $MAX_AGE_DAYS
Latest Backup: ${latest_backup:-none}
Latest Backup Time: $latest_human
Latest Backup Age Days: $age_days
Latest Backup Size: $latest_size
Alert Reason: ${alert_reason:-none}
Auto Enabled: $AUTO_ENABLED
AUTO_SKIPPED_REASON=$auto_skipped_reason
Manager Smart Exit Code: $manager_smart_exit_code
Manager Status Exit Code: $manager_status_exit_code
Manager Status Summary: $manager_status_summary
REPORT
}

write_dedup_state() {
  local alert_hash="$1"
  cat > "$STATE_FILE" <<STATE
LAST_RUN="$now_human"
LAST_STATUS="$status"
LAST_BACKUP="${latest_backup:-none}"
LAST_AGE_DAYS="$age_days"
LAST_ALERT_HASH="$alert_hash"
STATE
}

acted_today() {
  local today
  today="$(date +%F)"
  [ -f "$ACTION_STATE" ] && grep -q "^DATE=$today$" "$ACTION_STATE"
}

write_action_state() {
  local manager_exit="$1"
  local final_exit="$2"
  local smart_output="$3"
  local status_output="$4"
  local outcome="failed"

  if [ "$final_exit" -eq 0 ]; then
    outcome="success"
  fi

  cat > "$ACTION_STATE" <<STATE
DATE=$(date +%F)
ATTEMPTED=1
EXIT_CODE=$manager_exit
FINAL_EXIT_CODE=$final_exit
OUTCOME=$outcome
SMART_OUTPUT<<EOF
$smart_output
EOF
MANAGER_STATUS_OUTPUT<<EOF
$status_output
EOF
STATE
}

legacy_alert_message() {
  cat <<MSG
🚨 Dashboard/Property Backup Watchdog Alert

$alert_reason

Latest Backup:
${latest_backup:-none}

Backup Age:
$age_days days

Backup Size:
$latest_size

Recommended Action:
dashboard property backup now

Time:
$now_human
MSG
}

auto_ack_message() {
  local filename="none"
  [ -n "$latest_backup" ] && filename="$(basename "$latest_backup")"

  cat <<MSG
📊 Dashboard/Property Backup Watchdog

⚠️ $alert_reason

Starting smart backup now.
Latest: $filename
Time: $now_human
MSG
}

auto_result_reason() {
  local exit_code="$1"

  case "$exit_code" in
    0) echo "Smart backup completed." ;;
    3) echo "Another backup holds the lock." ;;
    4) echo "Backup directory unavailable." ;;
    5) echo "Backup directory not writable." ;;
    6) echo "Disk-space or configuration preflight failed." ;;
    7) echo "Backup still overdue after smart backup." ;;
    8) echo "Backup tar failed." ;;
    *) echo "Backup failed." ;;
  esac
}

auto_result_message() {
  local exit_code="$1"
  local reason filename

  reason="$(auto_result_reason "$exit_code")"
  filename="none"
  [ -n "$latest_backup" ] && filename="$(basename "$latest_backup")"

  cat <<MSG
📊 Dashboard/Property Backup Result

Status: $reason
Exit code: $exit_code
Latest: $filename
Time: $now_human
MSG
}

send_deduped_legacy_alert() {
  local exit_code="$1"
  local alert_hash last_hash

  alert_hash="$(alert_hash_for_current_state)"
  last_hash=""
  if [ -f "$STATE_FILE" ]; then
    last_hash="$(grep '^LAST_ALERT_HASH=' "$STATE_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)"
  fi

  write_report
  write_dedup_state "$alert_hash"

  if [ "$alert_hash" = "$last_hash" ]; then
    echo "Same dashboard/property backup alert already sent. No duplicate Telegram message."
    exit "$exit_code"
  fi

  send_telegram "$(legacy_alert_message)"
  echo "Dashboard/property backup watchdog alert sent."
  exit "$exit_code"
}

run_discovery

if [ "$status" = "ok" ]; then
  write_report
  write_dedup_state "$(alert_hash_for_current_state)"
  echo "Dashboard/property backup watchdog OK."
  exit 0
fi

if [ "$latest_rc" -eq 2 ]; then
  auto_skipped_reason="discovery_failed"
  send_deduped_legacy_alert 2
fi

if [ "$AUTO_ENABLED" != "1" ]; then
  auto_skipped_reason="auto_disabled"
  send_deduped_legacy_alert 0
fi

if acted_today; then
  auto_skipped_reason="already_attempted_today"
  send_deduped_legacy_alert 0
fi

send_telegram "$(auto_ack_message)"

set +e
manager_smart_output="$(
  BACKUP_MOUNT="$BACKUP_MOUNT" BACKUP_PARENT="$BACKUP_PARENT" BACKUP_DIR="$BACKUP_DIR" \
    "$BACKUP_MANAGER" smart 2>&1
)"
manager_smart_exit_code="$?"
manager_status_output="$(
  BACKUP_MOUNT="$BACKUP_MOUNT" BACKUP_PARENT="$BACKUP_PARENT" BACKUP_DIR="$BACKUP_DIR" \
    "$BACKUP_MANAGER" status 2>&1
)"
manager_status_exit_code="$?"
set -e

manager_status_summary="$(printf '%s\n' "$manager_status_output" | awk 'NF {line=$0} END {print line}')"

run_discovery
auto_skipped_reason="none"

final_exit=0
if [ "$manager_smart_exit_code" -ne 0 ]; then
  final_exit="$manager_smart_exit_code"
elif [ "$status" != "ok" ]; then
  final_exit=7
fi

write_action_state "$manager_smart_exit_code" "$final_exit" "$manager_smart_output" "$manager_status_output"
write_report
write_dedup_state "$(alert_hash_for_current_state)"
send_telegram "$(auto_result_message "$final_exit")"

if [ "$final_exit" -eq 0 ]; then
  echo "Dashboard/property backup watchdog smart backup completed successfully."
else
  echo "Dashboard/property backup watchdog smart backup attempted (exit $final_exit)."
fi
exit "$final_exit"
