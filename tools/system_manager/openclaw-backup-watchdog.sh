#!/usr/bin/env bash
set -u

BASE="/home/gravesab/ai/projects/openclaw"
BACKUP_DIR="/mnt/ai-storage/openclaw-backups"

SEND="$BASE/tools/telegram/send-telegram.sh"
BACKUP_MANAGER="$BASE/tools/system_manager/openclaw-backup-manager.sh"

STATE_DIR="$BASE/reports/system_manager/state"
STATE_FILE="$STATE_DIR/openclaw-backup-watchdog.state"
ACTION_FILE="$STATE_DIR/backup-watchdog-last-action.txt"
REPORT_FILE="$BASE/reports/system_manager/openclaw_backup_watchdog_report.txt"

MAX_AGE_DAYS="${MAX_AGE_DAYS:-10}"
AUTO_BACKUP="${OPENCLAW_BACKUP_WATCHDOG_AUTO:-0}"
MIN_FREE_GB="${MIN_FREE_GB:-20}"

mkdir -p "$STATE_DIR" "$(dirname "$REPORT_FILE")"

now_human="$(date '+%A, %B %d, %Y %I:%M %p')"

auto_status="disabled"
auto_details="Automatic backup is disabled."

run_auto_backup() {
    local free_gb manager_output manager_exit

    if [ "$AUTO_BACKUP" != "1" ]; then
        return 0
    fi

    auto_status="not-required"
    auto_details="Production backup is current."

    if ! mountpoint -q /mnt/ai-storage; then
        auto_status="failed"
        auto_details="AI Storage is not mounted at /mnt/ai-storage."
        return 1
    fi

    if [ ! -x "$BACKUP_MANAGER" ]; then
        auto_status="failed"
        auto_details="Backup manager is missing or not executable: $BACKUP_MANAGER"
        return 1
    fi

    free_gb="$(
        df --output=avail -BG /mnt/ai-storage |
        tail -1 |
        tr -dc '0-9'
    )"

    if [ -z "$free_gb" ]; then
        auto_status="failed"
        auto_details="Could not determine free space on AI Storage."
        return 1
    fi

    if [ "$free_gb" -lt "$MIN_FREE_GB" ]; then
        auto_status="skipped"
        auto_details="Only ${free_gb} GB is free; at least ${MIN_FREE_GB} GB is required."
        return 1
    fi

    manager_output="$(
        MAX_AGE_DAYS="$MAX_AGE_DAYS" \
        "$BACKUP_MANAGER" smart 2>&1
    )"
    manager_exit=$?

    {
        echo "OpenClaw Backup Watchdog Automatic Action"
        echo "Time: $(date '+%Y-%m-%d %H:%M:%S %Z')"
        echo "Exit Code: $manager_exit"
        echo
        echo "$manager_output"
    } > "$ACTION_FILE"

    if [ "$manager_exit" -ne 0 ]; then
        auto_status="failed"
        auto_details="Backup manager failed with exit code $manager_exit."
        return 1
    fi

    if printf '%s\n' "$manager_output" |
       grep -q 'OpenClaw checkpoint backup completed'; then
        auto_status="completed"
        auto_details="An overdue Production backup was created successfully."
    else
        auto_status="not-required"
        auto_details="Production backup was already current."
    fi

    return 0
}

# Run smart backup first. Failure is recorded but does not prevent reporting.
run_auto_backup || true

now_epoch="$(date +%s)"

# Production backups only:
# - Search only the top level of the Production backup directory.
# - Do not count files inside dev/, dashboard/, propertymanager/, etc.
latest_record="$(
    find "$BACKUP_DIR" \
        -maxdepth 1 \
        -type f \
        -name 'openclaw-*.tar.gz' \
        -printf '%T@ %s %p\n' 2>/dev/null |
    sort -nr |
    head -1
)"

latest_backup=""
latest_epoch=0
latest_size="unknown"
latest_human="none"
age_days="unknown"
status="ok"
alert_reason=""

if [ -z "$latest_record" ]; then
    status="critical"
    alert_reason="No Production OpenClaw backup was found."
else
    latest_epoch="${latest_record%%.*}"
    latest_size_bytes="$(printf '%s\n' "$latest_record" | awk '{print $2}')"
    latest_backup="$(printf '%s\n' "$latest_record" | cut -d' ' -f3-)"

    latest_size="$(
        numfmt --to=iec --suffix=B "$latest_size_bytes" 2>/dev/null ||
        du -h "$latest_backup" | awk '{print $1}'
    )"

    age_days="$(( (now_epoch - latest_epoch) / 86400 ))"

    latest_human="$(
        date -d "@$latest_epoch" \
            '+%A, %B %d, %Y %I:%M %p'
    )"

    if [ "$age_days" -gt "$MAX_AGE_DAYS" ]; then
        status="critical"
        alert_reason="Production OpenClaw backup is ${age_days} days old."
    fi
fi

if [ "$auto_status" = "failed" ] ||
   [ "$auto_status" = "skipped" ]; then
    status="critical"

    if [ -n "$alert_reason" ]; then
        alert_reason="$alert_reason Automatic backup: $auto_details"
    else
        alert_reason="Automatic backup: $auto_details"
    fi
fi

cat > "$REPORT_FILE" <<REPORT
OpenClaw Backup Watchdog
Time: $now_human
Status: $status
Max Age Days: $MAX_AGE_DAYS
Automatic Backup Enabled: $AUTO_BACKUP
Automatic Backup Status: $auto_status
Automatic Backup Details: $auto_details
Minimum Free Space GB: $MIN_FREE_GB
Latest Production Backup: ${latest_backup:-none}
Latest Backup Time: $latest_human
Latest Backup Age Days: $age_days
Latest Backup Size: $latest_size
Alert Reason: ${alert_reason:-none}
REPORT

alert_hash="$(
    printf '%s|%s|%s|%s' \
        "$status" \
        "$latest_backup" \
        "$age_days" \
        "$auto_status" |
    sha256sum |
    awk '{print $1}'
)"

last_hash=""

if [ -f "$STATE_FILE" ]; then
    last_hash="$(
        grep '^LAST_ALERT_HASH=' "$STATE_FILE" 2>/dev/null |
        cut -d= -f2- |
        tr -d '"' ||
        true
    )"
fi

cat > "$STATE_FILE" <<STATE
LAST_RUN="$now_human"
LAST_STATUS="$status"
LAST_BACKUP="${latest_backup:-none}"
LAST_AGE_DAYS="$age_days"
LAST_AUTO_STATUS="$auto_status"
LAST_ALERT_HASH="$alert_hash"
STATE

if [ "$status" = "ok" ]; then
    echo "OpenClaw backup watchdog OK."
    echo "Automatic backup status: $auto_status"
    exit 0
fi

if [ "$alert_hash" = "$last_hash" ]; then
    echo "Same OpenClaw backup alert already sent. No duplicate Telegram message."
    exit 0
fi

message="🚨 OpenClaw Backup Watchdog Alert

$alert_reason

Latest Production Backup:
${latest_backup:-none}

Backup Age:
$age_days days

Backup Size:
$latest_size

Automatic Backup:
$auto_status

Details:
$auto_details

Time:
$now_human"

if [ -x "$SEND" ]; then
    "$SEND" "$message" >/dev/null || true
else
    echo "Telegram sender not found or not executable: $SEND"
fi

echo "OpenClaw backup watchdog alert sent."
