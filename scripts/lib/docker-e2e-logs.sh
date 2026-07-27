#!/usr/bin/env bash
#
# Shared logging helpers for shell-based Docker E2E lanes.
# They centralize temporary log naming and the small success/failure print
# pattern used by Docker scenario scripts.

docker_e2e_normalize_positive_int_value() {
  local label="${1:?missing value label}"
  local value="${2-}"
  if [[ ! "$value" =~ ^[0-9]+$ ]] || (( 10#$value < 1 )); then
    echo "invalid $label: $value" >&2
    return 2
  fi
  printf '%s\n' "$((10#$value))"
}

docker_e2e_read_positive_int_env() {
  local name="${1:?missing environment variable name}"
  local fallback="${2:?missing fallback value}"
  local value="${!name-}"
  if [ -z "${!name+x}" ]; then
    value="$fallback"
  fi
  docker_e2e_normalize_positive_int_value "$name" "$value"
}

run_logged() {
  local label="$1"
  shift
  docker_e2e_read_positive_int_env OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES 65536 >/dev/null || return $?
  local log_file
  log_file="$(docker_e2e_run_log "$label")"
  if ! "$@" >"$log_file" 2>&1; then
    local print_status=0
    docker_e2e_print_log "$log_file" || print_status="$?"
    rm -f "$log_file"
    if [ "$print_status" -ne 0 ]; then
      return "$print_status"
    fi
    return 1
  fi
  rm -f "$log_file"
}

run_logged_print() {
  local label="$1"
  shift
  docker_e2e_read_positive_int_env OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES 65536 >/dev/null || return $?
  local log_file
  log_file="$(docker_e2e_run_log "$label")"
  if ! "$@" >"$log_file" 2>&1; then
    local print_status=0
    docker_e2e_print_log "$log_file" || print_status="$?"
    rm -f "$log_file"
    if [ "$print_status" -ne 0 ]; then
      return "$print_status"
    fi
    return 1
  fi
  docker_e2e_print_log "$log_file" || {
    local print_status="$?"
    rm -f "$log_file"
    return "$print_status"
  }
  rm -f "$log_file"
}

docker_e2e_maybe_print_log_heartbeat() {
  local label="$1"
  local elapsed_seconds="$2"
  local next_heartbeat="$3"
  local log_file="$4"
  if [ "$elapsed_seconds" -lt "$next_heartbeat" ]; then
    return 1
  fi
  local log_bytes="0"
  if [ -f "$log_file" ]; then
    log_bytes="$(wc -c <"$log_file" 2>/dev/null || echo 0)"
    log_bytes="${log_bytes//[[:space:]]/}"
  fi
  echo "still running $label (${elapsed_seconds}s elapsed, ${log_bytes} log bytes captured)"
}

run_logged_print_heartbeat() {
  local label="$1"
  local interval_seconds="$2"
  shift 2
  docker_e2e_read_positive_int_env OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES 65536 >/dev/null || return $?
  interval_seconds="$(docker_e2e_normalize_positive_int_value "Docker E2E log heartbeat interval" "$interval_seconds")" || return $?
  local heartbeat_term_grace_seconds
  heartbeat_term_grace_seconds="$(
    docker_e2e_read_positive_int_env OPENCLAW_DOCKER_E2E_HEARTBEAT_TERM_GRACE_SECONDS 30
  )" || return $?
  local log_file
  log_file="$(docker_e2e_run_log "$label")"
  local command_pid=""
  local cleanup_done=0
  local previous_int_trap
  local previous_term_trap
  local previous_hup_trap
  previous_int_trap="$(trap -p INT || true)"
  previous_term_trap="$(trap -p TERM || true)"
  previous_hup_trap="$(trap -p HUP || true)"
  terminate_heartbeat_command() {
    if [ -z "$command_pid" ]; then
      return 0
    fi
    kill -TERM "$command_pid" 2>/dev/null || true
    local wait_attempt
    for wait_attempt in $(seq 1 "$((heartbeat_term_grace_seconds * 10))"); do
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
  "$@" >"$log_file" 2>&1 &
  command_pid=$!
  local started_at="$SECONDS"
  local next_heartbeat=$interval_seconds
  local status=0
  while kill -0 "$command_pid" 2>/dev/null; do
    # Poll promptly so short commands do not pay a one-second wrapper tax.
    /bin/sleep 0.1
    local elapsed_seconds=$((SECONDS - started_at))
    if kill -0 "$command_pid" 2>/dev/null && \
      docker_e2e_maybe_print_log_heartbeat "$label" "$elapsed_seconds" "$next_heartbeat" "$log_file"; then
      next_heartbeat=$((elapsed_seconds + interval_seconds))
    fi
  done
  set +e
  wait "$command_pid"
  status=$?
  set -e
  docker_e2e_print_log "$log_file" || {
    local print_status="$?"
    cleanup_heartbeat_command 0
    return "$print_status"
  }
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
  local max_bytes
  max_bytes="$(docker_e2e_read_positive_int_env OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES 65536)" || return $?
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
