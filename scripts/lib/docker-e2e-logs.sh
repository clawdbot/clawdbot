#!/usr/bin/env bash
#
# Shared logging helpers for shell-based Docker E2E lanes.
# They centralize temporary log naming and the small success/failure print
# pattern used by Docker scenario scripts.

run_logged() {
  local label="$1"
  shift
  local log_file
  log_file="$(docker_e2e_run_log "$label")"
  if ! "$@" >"$log_file" 2>&1; then
    docker_e2e_print_log "$log_file"
    rm -f "$log_file"
    return 1
  fi
  rm -f "$log_file"
}

run_logged_print() {
  local label="$1"
  shift
  local log_file
  log_file="$(docker_e2e_run_log "$label")"
  if ! "$@" >"$log_file" 2>&1; then
    docker_e2e_print_log "$log_file"
    rm -f "$log_file"
    return 1
  fi
  docker_e2e_print_log "$log_file"
  rm -f "$log_file"
}

run_logged_print_heartbeat() {
  local label="$1"
  local interval_seconds="$2"
  shift 2
  if ! [[ "$interval_seconds" =~ ^[0-9]+$ ]] || [ "$interval_seconds" -lt 1 ]; then
    interval_seconds="30"
  else
    interval_seconds="$((10#$interval_seconds))"
  fi
  local log_file
  log_file="$(docker_e2e_run_log "$label")"
  "$@" >"$log_file" 2>&1 &
  local command_pid=$!
  local started_at="$SECONDS"
  local next_heartbeat=$interval_seconds
  local status=0
  while kill -0 "$command_pid" 2>/dev/null; do
    /bin/sleep 1
    local elapsed_seconds=$((SECONDS - started_at))
    if [ "$elapsed_seconds" -ge "$next_heartbeat" ] && kill -0 "$command_pid" 2>/dev/null; then
      local log_bytes="0"
      if [ -f "$log_file" ]; then
        log_bytes="$(wc -c <"$log_file" 2>/dev/null || echo 0)"
        log_bytes="${log_bytes//[[:space:]]/}"
      fi
      echo "still running $label (${elapsed_seconds}s elapsed, ${log_bytes} log bytes captured)"
      next_heartbeat=$((elapsed_seconds + interval_seconds))
    fi
  done
  set +e
  wait "$command_pid"
  status=$?
  set -e
  docker_e2e_print_log "$log_file"
  rm -f "$log_file"
  return "$status"
}

docker_e2e_run_log() {
  local label="$1"
  local tmp_dir="${TMPDIR:-/tmp}"
  tmp_dir="${tmp_dir%/}"
  mktemp "$tmp_dir/openclaw-${label}.XXXXXX"
}

docker_e2e_print_log() {
  local log_file="$1"
  cat "$log_file"
}
