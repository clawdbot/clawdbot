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
  local cleanup_done=0
  local previous_int_trap
  local previous_term_trap
  local previous_hup_trap
  previous_int_trap="$(trap -p INT || true)"
  previous_term_trap="$(trap -p TERM || true)"
  previous_hup_trap="$(trap -p HUP || true)"
  terminate_heartbeat_command() {
    kill -TERM "$command_pid" 2>/dev/null || true
    local grace_seconds="${OPENCLAW_DOCKER_E2E_HEARTBEAT_TERM_GRACE_SECONDS:-30}"
    if ! [[ "$grace_seconds" =~ ^[0-9]+$ ]] || [ "$grace_seconds" -lt 1 ]; then
      grace_seconds="30"
    else
      grace_seconds="$((10#$grace_seconds))"
    fi
    local wait_attempt
    for wait_attempt in $(seq 1 "$((grace_seconds * 10))"); do
      if ! kill -0 "$command_pid" 2>/dev/null; then
        return 0
      fi
      /bin/sleep 0.1
    done
    kill -KILL "$command_pid" 2>/dev/null || true
  }
  restore_heartbeat_traps() {
    if [ -n "$previous_int_trap" ]; then
      eval "$previous_int_trap"
    else
      trap - INT
    fi
    if [ -n "$previous_term_trap" ]; then
      eval "$previous_term_trap"
    else
      trap - TERM
    fi
    if [ -n "$previous_hup_trap" ]; then
      eval "$previous_hup_trap"
    else
      trap - HUP
    fi
  }
  cleanup_heartbeat_command() {
    local cleanup_status="${1:-$?}"
    if [ "$cleanup_done" = "1" ]; then
      return "$cleanup_status"
    fi
    cleanup_done=1
    trap - INT TERM HUP
    if kill -0 "$command_pid" 2>/dev/null; then
      terminate_heartbeat_command
      wait "$command_pid" 2>/dev/null || true
    fi
    rm -f "$log_file"
    restore_heartbeat_traps
    if [ "$cleanup_status" -ge 128 ]; then
      exit "$cleanup_status"
    fi
    return "$cleanup_status"
  }
  trap 'cleanup_heartbeat_command 130' INT
  trap 'cleanup_heartbeat_command 143' TERM
  trap 'cleanup_heartbeat_command 129' HUP
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
  cleanup_heartbeat_command 0
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
  local max_bytes="${OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES:-65536}"
  if ! [[ "$max_bytes" =~ ^[0-9]+$ ]] || [ "$max_bytes" -lt 1 ]; then
    max_bytes="65536"
  else
    max_bytes="$((10#$max_bytes))"
  fi
  if [ ! -f "$log_file" ]; then
    return 0
  fi
  local log_bytes
  log_bytes="$(wc -c <"$log_file" 2>/dev/null || echo 0)"
  log_bytes="${log_bytes//[[:space:]]/}"
  if ! [[ "$log_bytes" =~ ^[0-9]+$ ]]; then
    log_bytes="0"
  fi
  if [ "$log_bytes" -le "$max_bytes" ]; then
    cat "$log_file"
    return 0
  fi
  echo "--- ${log_file} truncated: showing last ${max_bytes} of ${log_bytes} bytes ---"
  tail -c "$max_bytes" "$log_file"
}
