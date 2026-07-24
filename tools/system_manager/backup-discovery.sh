#!/usr/bin/env bash
# Shared full-backup discovery for OpenClaw deployment scripts.
# Source this file; do not execute it directly.

: "${BACKUP_DIR:=/mnt/ai-storage/openclaw-backups}"
: "${BACKUP_GLOB:=openclaw-*.tar.gz}"
: "${BACKUP_EXCLUDE_PATTERN:=dashboard-backup}"
: "${MAX_AGE_DAYS:=10}"

backup_discovery_validate_max_age_days() {
  [[ "$MAX_AGE_DAYS" =~ ^[0-9]+$ ]]
}

backup_discovery_validate_dir() {
  if [ ! -d "$BACKUP_DIR" ]; then
    echo "missing"
    return 2
  fi

  if [ ! -r "$BACKUP_DIR" ] || [ ! -x "$BACKUP_DIR" ]; then
    echo "unreadable"
    return 2
  fi

  echo "ok"
  return 0
}

backup_discovery_status() {
  local validation latest

  validation="$(backup_discovery_validate_dir)"
  case "$validation" in
    ok) ;;
    missing)
      echo "missing"
      return 2
      ;;
    unreadable)
      echo "unreadable"
      return 2
      ;;
    *)
      echo "error"
      return 2
      ;;
  esac

  latest="$(backup_discovery_latest || true)"
  if [ -z "$latest" ]; then
    echo "none"
    return 1
  fi

  echo "found"
  return 0
}

backup_discovery_latest() {
  backup_discovery_validate_dir >/dev/null || return 2

  find "$BACKUP_DIR" -maxdepth 1 -type f -name "$BACKUP_GLOB" \
    ! -name "*${BACKUP_EXCLUDE_PATTERN}*" \
    -printf '%T@ %s %p\n' 2>/dev/null \
    | sort -nr \
    | head -1
}

backup_discovery_latest_path() {
  local latest

  latest="$(backup_discovery_latest)" || return 2
  [ -n "$latest" ] || return 0

  echo "$latest" | cut -d' ' -f3-
}

backup_discovery_age_days() {
  local latest epoch now

  latest="$(backup_discovery_latest)" || return 2
  if [ -z "$latest" ]; then
    echo "unknown"
    return 0
  fi

  epoch="$(echo "$latest" | awk '{print $1}')"
  now="$(date +%s)"
  echo $(( (now - ${epoch%.*}) / 86400 ))
}

backup_discovery_overdue() {
  local age_days

  backup_discovery_validate_max_age_days || return 2
  backup_discovery_validate_dir >/dev/null || return 2

  age_days="$(backup_discovery_age_days)"
  if [ "$age_days" = "unknown" ]; then
    return 0
  fi

  if [ "$age_days" -ge "$MAX_AGE_DAYS" ]; then
    return 0
  fi

  return 1
}
