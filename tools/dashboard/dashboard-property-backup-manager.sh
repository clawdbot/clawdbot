#!/usr/bin/env bash
set -euo pipefail

BASE="/home/gravesab/ai/projects/openclaw"
BACKUP_MOUNT="${BACKUP_MOUNT:-/mnt/ai-storage}"
BACKUP_PARENT="${BACKUP_PARENT:-/mnt/ai-storage/openclaw-backups}"
BACKUP_DIR="${BACKUP_DIR:-$BACKUP_PARENT/dashboard-property-backups}"
BACKUP_GLOB="dashboard-property-backup-*.tar.gz"
BACKUP_LOCK_FILE="/tmp/dashboard-property-backup.lock"
MAX_AGE_DAYS="${MAX_AGE_DAYS:-10}"
MIN_FREE_GB="${MIN_FREE_GB:-1}"
BACKUP_LOCK_HELD=0

DASHBOARD_APP="$BASE/tools/dashboard/app.py"
PROPERTY_MANAGER_DIR="$BASE/tools/property_manager"
SYSTEMD_UNIT="/home/gravesab/.config/systemd/user/openclaw-dashboard.service"

acquire_backup_lock() {
  if [ "$BACKUP_LOCK_HELD" -eq 1 ]; then
    return 0
  fi

  exec 9>"$BACKUP_LOCK_FILE"
  if ! flock -n 9; then
    echo "⚠️ Another dashboard/property backup is already running (lock: $BACKUP_LOCK_FILE)." >&2
    exit 3
  fi

  BACKUP_LOCK_HELD=1
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

prepare_backup_storage() {
  if ! mountpoint -q "$BACKUP_MOUNT" 2>/dev/null; then
    echo "⚠️ Backup mount is not available: $BACKUP_MOUNT" >&2
    exit 4
  fi

  if [ ! -d "$BACKUP_PARENT" ]; then
    echo "⚠️ Backup parent directory is unavailable: $BACKUP_PARENT" >&2
    exit 4
  fi

  if [ ! -w "$BACKUP_PARENT" ]; then
    echo "⚠️ Backup parent directory is not writable: $BACKUP_PARENT" >&2
    exit 5
  fi

  mkdir -p "$BACKUP_DIR"

  if [ ! -w "$BACKUP_DIR" ]; then
    echo "⚠️ Backup directory is not writable: $BACKUP_DIR" >&2
    exit 5
  fi
}

check_backup_preflight() {
  local avail_kb avail_gb

  if ! [[ "$MIN_FREE_GB" =~ ^[0-9]+$ ]]; then
    echo "⚠️ MIN_FREE_GB must be a nonnegative integer; got: $MIN_FREE_GB" >&2
    exit 6
  fi

  if ! [[ "$MAX_AGE_DAYS" =~ ^[0-9]+$ ]]; then
    echo "⚠️ MAX_AGE_DAYS must be a nonnegative integer; got: $MAX_AGE_DAYS" >&2
    exit 6
  fi

  prepare_backup_storage

  avail_kb="$(df -Pk "$BACKUP_DIR" 2>/dev/null | awk 'NR==2 {print $4}')"
  if [ -z "$avail_kb" ] || ! [[ "$avail_kb" =~ ^[0-9]+$ ]]; then
    echo "⚠️ Could not determine free space for backup directory: $BACKUP_DIR" >&2
    exit 6
  fi

  avail_gb="$(( avail_kb / 1024 / 1024 ))"
  if [ "$avail_gb" -lt "$MIN_FREE_GB" ]; then
    echo "⚠️ Insufficient free space for backup: ${avail_gb} GB available, ${MIN_FREE_GB} GB required." >&2
    exit 6
  fi
}

latest_backup() {
  validate_storage_discovery || return 2

  if [ ! -d "$BACKUP_DIR" ]; then
    return 0
  fi

  find "$BACKUP_DIR" -maxdepth 1 -type f -name "$BACKUP_GLOB" \
    -printf '%T@ %s %p\n' 2>/dev/null \
    | sort -nr \
    | head -1
}

status_backup() {
  local latest latest_rc epoch size file now age_days size_mb backup_status

  set +e
  latest="$(latest_backup)"
  latest_rc="$?"
  set -e

  if [ "$latest_rc" -eq 2 ]; then
    echo "📊 Dashboard/PropertyManager Backup Status"
    echo
    echo "Backup discovery failed."
    echo "Status: ERROR"
    echo "Location: $BACKUP_DIR"
    echo "Mount: $BACKUP_MOUNT"
    echo "Parent: $BACKUP_PARENT"
    return 2
  fi

  if [ -z "$latest" ]; then
    echo "📊 Dashboard/PropertyManager Backup Status"
    echo
    echo "No dashboard/property backup found."
    echo "Status: OVERDUE"
    return 0
  fi

  epoch="$(echo "$latest" | awk '{print $1}')"
  size="$(echo "$latest" | awk '{print $2}')"
  file="$(echo "$latest" | cut -d' ' -f3-)"

  now="$(date +%s)"
  age_days="$(( (now - ${epoch%.*}) / 86400 ))"
  size_mb="$(( size / 1024 / 1024 ))"

  if [ "$age_days" -ge "$MAX_AGE_DAYS" ]; then
    backup_status="OVERDUE"
  else
    backup_status="Current"
  fi

  echo "📊 Dashboard/PropertyManager Backup Status"
  echo
  echo "Latest backup:"
  echo "$(basename "$file")"
  echo
  echo "Created: $(date -d "@${epoch%.*}" '+%Y-%m-%d %H:%M:%S %Z')"
  echo "Age: ${age_days} day(s)"
  echo "Size: ${size_mb} MB"
  echo "Status: $backup_status"
  echo "Location: $file"
}

create_backup() {
  local stamp temp_file final_file start end duration size_mb
  local checksum_file checksum_temp tar_exit
  local tar_paths=()

  acquire_backup_lock
  check_backup_preflight

  if [ ! -f "$DASHBOARD_APP" ]; then
    echo "⚠️ Dashboard app not found: $DASHBOARD_APP" >&2
    exit 8
  fi

  if [ ! -d "$PROPERTY_MANAGER_DIR" ]; then
    echo "⚠️ PropertyManager directory not found: $PROPERTY_MANAGER_DIR" >&2
    exit 8
  fi

  stamp="$(date +%Y%m%d-%H%M%S)"
  temp_file="$BACKUP_DIR/.dashboard-property-backup-$stamp.tar.gz.tmp"
  final_file="$BACKUP_DIR/dashboard-property-backup-$stamp.tar.gz"

  tar_paths=("$DASHBOARD_APP" "$PROPERTY_MANAGER_DIR")
  if [ -f "$SYSTEMD_UNIT" ]; then
    tar_paths+=("$SYSTEMD_UNIT")
  fi

  start="$(date +%s)"

  echo "📊 Starting dashboard/property backup..."
  echo "Destination: $final_file"
  echo

  set +e
  tar -czf "$temp_file" "${tar_paths[@]}" 2>&1
  tar_exit="$?"
  set -e

  if [ "$tar_exit" -ne 0 ] || [ ! -f "$temp_file" ]; then
    rm -f "$temp_file"
    echo "⚠️ Dashboard/property backup tar failed (exit $tar_exit)." >&2
    exit 8
  fi

  mv "$temp_file" "$final_file"

  checksum_file="${final_file}.sha256"
  checksum_temp="${checksum_file}.tmp"

  (
    cd "$(dirname "$final_file")"
    sha256sum "$(basename "$final_file")" > "$(basename "$checksum_temp")"
    mv "$(basename "$checksum_temp")" "$(basename "$checksum_file")"
  )

  end="$(date +%s)"
  duration="$(( end - start ))"
  size_mb="$(( $(stat -c%s "$final_file") / 1024 / 1024 ))"

  echo "✅ Dashboard/property backup completed"
  echo "File: $(basename "$final_file")"
  echo "Size: ${size_mb} MB"
  echo "Duration: ${duration} seconds"
  echo "Location: $final_file"
  echo "Checksum: $checksum_file"
}

smart_backup() {
  local latest latest_rc epoch now age_days

  acquire_backup_lock

  set +e
  latest="$(latest_backup)"
  latest_rc="$?"
  set -e

  if [ "$latest_rc" -eq 2 ]; then
    echo "Backup discovery failed. Not creating a backup."
    echo "Mount: $BACKUP_MOUNT"
    echo "Parent: $BACKUP_PARENT"
    echo "Location: $BACKUP_DIR"
    return 2
  fi

  if [ -z "$latest" ]; then
    echo "No dashboard/property backup found. Starting backup now..."
    create_backup
    return 0
  fi

  epoch="$(echo "$latest" | awk '{print $1}')"
  now="$(date +%s)"
  age_days="$(( (now - ${epoch%.*}) / 86400 ))"

  if [ "$age_days" -ge "$MAX_AGE_DAYS" ]; then
    echo "Backup is overdue (${age_days} days old). Starting backup now..."
    echo
    create_backup
  else
    status_backup
    echo
    echo "No action required."
  fi
}

case "${1:-status}" in
  status) status_backup ;;
  now|create) create_backup ;;
  smart) smart_backup ;;
  *) echo "Usage: $0 {status|now|smart}" ; exit 2 ;;
esac
