#!/usr/bin/env bash

DOCKER_BUILD_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! declare -F run_logged >/dev/null 2>&1; then
  source "$DOCKER_BUILD_LIB_DIR/docker-e2e-logs.sh"
fi
if ! declare -F docker_e2e_timeout_cmd >/dev/null 2>&1; then
  source "$DOCKER_BUILD_LIB_DIR/docker-e2e-container.sh"
fi

docker_build_on_missing_enabled() {
  case "${OPENCLAW_DOCKER_BUILD_ON_MISSING:-}" in
    1 | true | TRUE | yes | YES)
      return 0
      ;;
    0 | false | FALSE | no | NO)
      return 1
      ;;
  esac

  [ "${OPENCLAW_TESTBOX:-0}" = "1" ]
}

docker_build_command() {
  local build_cmd=(docker build)
  if [ "${OPENCLAW_DOCKER_BUILD_USE_BUILDX:-0}" = "1" ] || docker_build_args_need_buildx "$@"; then
    build_cmd=(docker buildx build --load)
    if [ -n "${OPENCLAW_DOCKER_BUILD_CACHE_FROM:-}" ]; then
      build_cmd+=(--cache-from "${OPENCLAW_DOCKER_BUILD_CACHE_FROM}")
    fi
    if [ -n "${OPENCLAW_DOCKER_BUILD_CACHE_TO:-}" ]; then
      build_cmd+=(--cache-to "${OPENCLAW_DOCKER_BUILD_CACHE_TO}")
    fi
  fi

  printf '%s\0' env DOCKER_BUILDKIT=1 "${build_cmd[@]}" "$@"
}

docker_build_args_need_buildx() {
  for arg in "$@"; do
    case "$arg" in
      --build-context | --build-context=*)
        return 0
        ;;
    esac
  done
  return 1
}

docker_build_transient_failure() {
  local log_file="$1"
  grep -Eqi \
    'frontend grpc server closed unexpectedly|failed to dial gRPC|no active session|buildkit.*connection.*closed|rpc error: code = Unavailable|failed to fetch oauth token:.*(5[0-9][0-9]|Gateway Timeout)|unexpected status from .*: 5[0-9][0-9]|TLS handshake timeout|net/http: TLS handshake timeout|ConnectTimeoutError|Connect Timeout Error|i/o timeout|connection reset by peer' \
    "$log_file"
}

docker_build_resource_exhausted_failure() {
  local log_file="$1"
  grep -Eqi 'ResourceExhausted|cannot allocate memory|out of memory|exit code: 137|signal: killed|fatal error: killed signal terminated program|(^|#[0-9]+ [0-9.]+ )Killed[[:space:]]*$' "$log_file"
}

docker_build_print_resource_exhausted_hint() {
  cat >&2 <<'EOF'
Docker build failed because the builder ran out of memory.
Try increasing the Docker/BuildKit memory limit, closing other memory-heavy processes, or rebuilding with a smaller OpenClaw build heap, for example:
  OPENCLAW_DOCKER_BUILD_NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_DOCKER_BUILD_TSDOWN_MAX_OLD_SPACE_MB=4096 ./scripts/docker/setup.sh
EOF
}

docker_build_retry_count() {
  local configured="${OPENCLAW_DOCKER_BUILD_RETRIES:-2}"
  if [[ "$configured" =~ ^[0-9]+$ ]]; then
    echo "$((10#$configured))"
    return 0
  fi
  echo "invalid OPENCLAW_DOCKER_BUILD_RETRIES: $configured" >&2
  return 2
}

docker_build_timeout_required() {
  case "${OPENCLAW_DOCKER_BUILD_REQUIRE_TIMEOUT:-0}" in
    1 | true | TRUE | yes | YES)
      return 0
      ;;
  esac
  return 1
}

docker_build_signal_exit_status() {
  case "$1" in
    129 | 130 | 143)
      return 0
      ;;
  esac
  return 1
}

docker_build_heartbeat_seconds() {
  local configured="${OPENCLAW_DOCKER_BUILD_HEARTBEAT_SECONDS:-30}"
  if [[ "$configured" =~ ^[0-9]+$ ]] && [ "$configured" -ge 1 ]; then
    echo "$((10#$configured))"
    return 0
  fi
  echo "invalid OPENCLAW_DOCKER_BUILD_HEARTBEAT_SECONDS: $configured" >&2
  return 2
}

docker_build_run_command() {
  local timeout_value="$1"
  shift

  if docker_e2e_timeout_bin >/dev/null 2>&1 || docker_build_timeout_required; then
    docker_e2e_timeout_cmd "$timeout_value" "$@"
    return
  fi

  "$@"
}

docker_build_maybe_print_heartbeat() {
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
  echo "Docker build $label still running (${elapsed_seconds}s elapsed, ${log_bytes} log bytes captured)..."
}

docker_build_run_logged() {
  local label="$1"
  local timeout_value="$2"
  local log_file="$3"
  shift 3
  local heartbeat_seconds
  heartbeat_seconds="$(docker_build_heartbeat_seconds)"
  local started_at="$SECONDS"
  local next_heartbeat=$heartbeat_seconds
  local build_status=0
  local build_pid=""
  local previous_int_trap
  local previous_term_trap
  local previous_hup_trap
  local heartbeat_sleep_pid=""

  previous_int_trap="$(trap -p INT || true)"
  previous_term_trap="$(trap -p TERM || true)"
  previous_hup_trap="$(trap -p HUP || true)"

  docker_build_restore_signal_traps() {
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

  docker_build_signal_process_tree() {
    local signal="$1"
    local process_id="$2"
    local child_pid
    if command -v pgrep >/dev/null 2>&1; then
      while IFS= read -r child_pid; do
        if [ -n "$child_pid" ]; then
          docker_build_signal_process_tree "$signal" "$child_pid"
        fi
      done < <(pgrep -P "$process_id" 2>/dev/null || true)
    fi
    # A successful group signal does not prove this exact PID was in that group;
    # send both so timeout/build wrappers cannot exit while their command stays alive.
    kill -s "$signal" -- "-$process_id" 2>/dev/null || true
    kill -s "$signal" "$process_id" 2>/dev/null || true
  }

  docker_build_stop_tracked_build() {
    local signal="$1"
    local exit_code="$2"
    if [ -n "$heartbeat_sleep_pid" ] && kill -0 "$heartbeat_sleep_pid" 2>/dev/null; then
      kill "$heartbeat_sleep_pid" 2>/dev/null || true
      wait "$heartbeat_sleep_pid" 2>/dev/null || true
    fi
    if [ -n "$build_pid" ] && kill -0 "$build_pid" 2>/dev/null; then
      docker_build_signal_process_tree "$signal" "$build_pid"
      wait "$build_pid" 2>/dev/null || true
    fi
    docker_build_restore_signal_traps
    return "$exit_code"
  }

  trap 'docker_build_stop_tracked_build TERM 130; return 130' INT
  trap 'docker_build_stop_tracked_build TERM 143; return 143' TERM
  trap 'docker_build_stop_tracked_build HUP 129; return 129' HUP

  docker_build_run_command "$timeout_value" "$@" >"$log_file" 2>&1 &
  build_pid="$!"
  while kill -0 "$build_pid" 2>/dev/null; do
    # Poll promptly so short builds do not pay a one-second wrapper tax.
    /bin/sleep 0.1 &
    heartbeat_sleep_pid="$!"
    wait "$heartbeat_sleep_pid" 2>/dev/null || true
    heartbeat_sleep_pid=""
    local elapsed_seconds=$((SECONDS - started_at))
    if kill -0 "$build_pid" 2>/dev/null && \
      docker_build_maybe_print_heartbeat "$label" "$elapsed_seconds" "$next_heartbeat" "$log_file"; then
      next_heartbeat=$((elapsed_seconds + heartbeat_seconds))
    fi
  done

  wait "$build_pid" || build_status="$?"
  docker_build_restore_signal_traps
  return "$build_status"
}

docker_build_with_retries() {
  local label="$1"
  shift
  local retries
  retries="$(docker_build_retry_count)" || return $?
  docker_build_heartbeat_seconds >/dev/null || return $?
  local attempt=1
  local max_attempts=$((retries + 1))
  local log_file
  local command=()
  local build_status=0
  while IFS= read -r -d '' part; do
    command+=("$part")
  done < <(docker_build_command "$@")

  local timeout_value="${OPENCLAW_DOCKER_BUILD_TIMEOUT:-3600s}"
  while true; do
    log_file="$(docker_e2e_run_log "$label")"
    if docker_build_run_logged "$label" "$timeout_value" "$log_file" "${command[@]}"; then
      rm -f "$log_file"
      return 0
    else
      build_status="$?"
    fi

    if docker_build_signal_exit_status "$build_status"; then
      rm -f "$log_file"
      return "$build_status"
    fi

    if [ "$attempt" -ge "$max_attempts" ] || ! docker_build_transient_failure "$log_file"; then
      docker_e2e_print_log "$log_file"
      if docker_build_resource_exhausted_failure "$log_file"; then
        docker_build_print_resource_exhausted_hint
      fi
      rm -f "$log_file"
      return 1
    fi

    echo "Docker build failed with a transient Docker/registry error; retrying ($attempt/$retries)..." >&2
    docker_e2e_print_log "$log_file"
    rm -f "$log_file"
    attempt=$((attempt + 1))
    /bin/sleep "$attempt"
  done
}

docker_build_exec() {
  docker_build_with_retries docker-build "$@"
}

docker_build_run() {
  local label="$1"
  shift

  OPENCLAW_DOCKER_BUILD_REQUIRE_TIMEOUT="${OPENCLAW_DOCKER_BUILD_REQUIRE_TIMEOUT:-1}" \
    docker_build_with_retries "$label" "$@"
}
