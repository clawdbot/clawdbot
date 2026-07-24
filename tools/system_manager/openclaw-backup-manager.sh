#!/usr/bin/env bash
set -euo pipefail

BASE="/home/gravesab/ai/projects/openclaw"
BACKUP_DIR="/mnt/ai-storage/openclaw-backups"
MAX_AGE_DAYS="${MAX_AGE_DAYS:-10}"

mkdir -p "$BACKUP_DIR"

latest_backup() {
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'openclaw-*.tar.gz' \
    -printf '%T@ %s %p\n' 2>/dev/null | sort -nr | head -1
}

status_backup() {
  local latest epoch size file now age_days size_mb status
  local checksum_file checksum_status
  latest="$(latest_backup || true)"

  if [ -z "$latest" ]; then
    echo "🧰 OpenClaw Backup Status"
    echo
    echo "No OpenClaw checkpoint backup found."
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
    status="OVERDUE"
  else
    status="Current"
  fi

  echo "🧰 OpenClaw Backup Status"
  echo
  echo "Latest backup:"
  echo "$(basename "$file")"
  echo
  echo "Created: $(date -d "@${epoch%.*}" '+%Y-%m-%d %H:%M:%S %Z')"
  echo "Age: ${age_days} day(s)"
  echo "Size: ${size_mb} MB"
  echo "Status: $status"
  echo "Location: $file"

  checksum_file="${file}.sha256"

  if [ -f "$checksum_file" ]; then
    checksum_status="$(
      cd "$(dirname "$file")"
      sha256sum -c "$(basename "$checksum_file")" 2>&1
    )" || true

    if echo "$checksum_status" | grep -q ': OK$'; then
      echo "Checksum: verified"
      echo "Checksum File: $checksum_file"
    else
      echo "Checksum: FAILED"
      echo "Checksum Details: $checksum_status"
    fi
  else
    echo "Checksum: not available"
  fi
}

create_backup() {
  local stamp file start end duration size_mb status_file
  local checksum_file checksum_temp

  stamp="$(date +%Y%m%d-%H%M%S)"
  file="$BACKUP_DIR/openclaw-checkpoint-$stamp.tar.gz"
  status_file="$BACKUP_DIR/openclaw-checkpoint-$stamp-status.txt"

  start="$(date +%s)"

  echo "🧰 Starting OpenClaw checkpoint backup..."
  echo "Destination: $file"
  echo

  tar -czf "$file" \
    --exclude="$BASE/node_modules" \
    --exclude="$BASE/.git" \
    --exclude="$BASE/.venv" \
    --exclude="$BASE/**/.venv" \
    --exclude="$BASE/.artifacts" \
    --exclude="$BASE/dist" \
    --exclude="$BASE/.cache" \
    --exclude="$BASE/**/__pycache__" \
    "$BASE" \
    "/home/gravesab/.openclaw" \
    2>"$status_file"

  checksum_file="${file}.sha256"
  checksum_temp="${checksum_file}.tmp"

  (
    cd "$(dirname "$file")"
    sha256sum "$(basename "$file")" > "$(basename "$checksum_temp")"
    mv "$(basename "$checksum_temp")" "$(basename "$checksum_file")"
  )

  end="$(date +%s)"
  duration="$(( end - start ))"
  size_mb="$(( $(stat -c%s "$file") / 1024 / 1024 ))"

  {
    echo "OpenClaw checkpoint backup completed"
    echo "Created: $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "File: $file"
    echo "Size MB: $size_mb"
    echo "Duration seconds: $duration"
  } >> "$status_file"

  echo "✅ OpenClaw checkpoint backup completed"
  echo "File: $(basename "$file")"
  echo "Size: ${size_mb} MB"
  echo "Duration: ${duration} seconds"
  echo "Location: $file"
}

smart_backup() {
  local latest epoch now age_days

  latest="$(latest_backup || true)"

  if [ -z "$latest" ]; then
    echo "No checkpoint backup found. Starting backup now..."
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
