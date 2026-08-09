#!/usr/bin/env bash
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh

KITCHEN_SINK_SWEEP_SOURCE_ONLY="${KITCHEN_SINK_SWEEP_SOURCE_ONLY:-0}"
if [[ -z "${OPENCLAW_ENTRY:-}" && "$KITCHEN_SINK_SWEEP_SOURCE_ONLY" != "1" ]]; then
  OPENCLAW_ENTRY="$(openclaw_e2e_resolve_entrypoint)"
fi
export OPENCLAW_ENTRY
KITCHEN_SINK_CREATED_TMP_DIR=0
if [[ -z "${KITCHEN_SINK_TMP_DIR:-}" ]]; then
  KITCHEN_SINK_TMP_DIR="$(mktemp -d "/tmp/openclaw-kitchen-sink.XXXXXX")"
  KITCHEN_SINK_CREATED_TMP_DIR=1
else
  mkdir -p "$KITCHEN_SINK_TMP_DIR"
fi
export KITCHEN_SINK_TMP_DIR
KITCHEN_SINK_CLI_TIMEOUT="${KITCHEN_SINK_CLI_TIMEOUT:-180s}"
KITCHEN_SINK_CLAWHUB_FIXTURE_DIR=""
KITCHEN_SINK_CLAWHUB_PID_FILE=""

cleanup_kitchen_sink_sweep() {
  if [[ -n "${KITCHEN_SINK_CLAWHUB_PID_FILE:-}" && -f "$KITCHEN_SINK_CLAWHUB_PID_FILE" ]]; then
    openclaw_e2e_stop_process "$(cat "$KITCHEN_SINK_CLAWHUB_PID_FILE" 2>/dev/null || true)"
  fi
  if [[ -n "${KITCHEN_SINK_CLAWHUB_FIXTURE_DIR:-}" ]]; then
    rm -rf "$KITCHEN_SINK_CLAWHUB_FIXTURE_DIR"
  fi
  if [[ "${KITCHEN_SINK_CREATED_TMP_DIR:-0}" = "1" ]]; then
    rm -rf "$KITCHEN_SINK_TMP_DIR"
  fi
}

if [[ "$KITCHEN_SINK_SWEEP_SOURCE_ONLY" != "1" ]]; then
  trap cleanup_kitchen_sink_sweep EXIT
  openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
fi

print_kitchen_sink_log() {
  local log_file="$1"
  local max_bytes
  max_bytes="$(openclaw_e2e_read_positive_int_env OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES 65536)" || return $?
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

openclaw_e2e_read_positive_int_env OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES 65536 >/dev/null

run_kitchen_sink_openclaw_logged() {
  local label="$1"
  shift
  local safe_label="${label//[^[:alnum:]._-]/_}"
  local log_file="${KITCHEN_SINK_TMP_DIR}/${safe_label}.log"
  if ! openclaw_e2e_maybe_timeout "$KITCHEN_SINK_CLI_TIMEOUT" node "$OPENCLAW_ENTRY" "$@" >"$log_file" 2>&1; then
    print_kitchen_sink_log "$log_file"
    return 1
  fi
  print_kitchen_sink_log "$log_file"
}

run_kitchen_sink_openclaw_capture() {
  local output_file="$1"
  shift
  openclaw_e2e_maybe_timeout "$KITCHEN_SINK_CLI_TIMEOUT" node "$OPENCLAW_ENTRY" "$@" >"$output_file"
}

run_expect_failure() {
  local label="$1"
  shift
  local safe_label="${label//[^[:alnum:]._-]/_}"
  local output_file="${KITCHEN_SINK_TMP_DIR}/kitchen-sink-expected-failure-${safe_label}.log"
  set +e
  "$@" >"$output_file" 2>&1
  local status="$?"
  set -e
  print_kitchen_sink_log "$output_file"
  if [ "$status" -eq 0 ]; then
    echo "Expected ${label} to fail, but it succeeded." >&2
    exit 1
  fi
  node scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs expect-failure "$output_file"
}

start_kitchen_sink_clawhub_fixture_server() {
  local fixture_dir="$1"
  local server_log="$fixture_dir/clawhub-fixture.log"
  local server_port_file="$fixture_dir/clawhub-fixture-port"
  local server_pid_file="$fixture_dir/clawhub-fixture-pid"

  node scripts/e2e/lib/clawhub-fixture-server.cjs kitchen-sink-plugin "$server_port_file" >"$server_log" 2>&1 &
  local server_pid="$!"
  echo "$server_pid" >"$server_pid_file"
  KITCHEN_SINK_CLAWHUB_FIXTURE_DIR="$fixture_dir"
  KITCHEN_SINK_CLAWHUB_PID_FILE="$server_pid_file"

  local wait_attempts
  wait_attempts="$(openclaw_e2e_read_positive_int_env OPENCLAW_CLAWHUB_FIXTURE_WAIT_ATTEMPTS 600)" || return $?
  for _ in $(seq 1 "$wait_attempts"); do
    if [[ -s "$server_port_file" ]]; then
      export OPENCLAW_CLAWHUB_URL="http://127.0.0.1:$(cat "$server_port_file")"
      return 0
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      print_kitchen_sink_log "$server_log"
      return 1
    fi
    sleep 0.1
  done

  print_kitchen_sink_log "$server_log"
  ps -p "$server_pid" -o pid=,stat=,etime=,command= || true
  echo "Timed out waiting for kitchen-sink ClawHub fixture server." >&2
  return 1
}

scan_logs_for_unexpected_errors() {
  node scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs scan-logs
}

configure_kitchen_sink_runtime() {
  node scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs configure-runtime
}

remove_kitchen_sink_channel_config() {
  node scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs remove-channel-config
}

assert_kitchen_sink_installed() {
  node scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs assert-installed
}

assert_kitchen_sink_removed() {
  node scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs assert-removed
}

assert_kitchen_sink_cutover_preinstalled() {
  node scripts/e2e/lib/kitchen-sink-plugin/assertions.mjs assert-cutover-preinstalled
}

run_success_scenario() {
  echo "Testing ${KITCHEN_SINK_LABEL} install from ${KITCHEN_SINK_SPEC}..."
  local install_args=("$KITCHEN_SINK_SPEC")
  if [ -n "${KITCHEN_SINK_PREINSTALL_SPEC:-}" ]; then
    run_kitchen_sink_openclaw_logged "kitchen-sink-preinstall-${KITCHEN_SINK_LABEL}" plugins install "$KITCHEN_SINK_PREINSTALL_SPEC" --force
    assert_kitchen_sink_cutover_preinstalled
    install_args+=("--force")
  fi
  run_kitchen_sink_openclaw_logged "kitchen-sink-install-${KITCHEN_SINK_LABEL}" plugins install "${install_args[@]}" --force
  configure_kitchen_sink_runtime
  run_kitchen_sink_openclaw_logged "kitchen-sink-enable-${KITCHEN_SINK_LABEL}" plugins enable "$KITCHEN_SINK_ID"
  run_kitchen_sink_openclaw_capture "${KITCHEN_SINK_TMP_DIR}/kitchen-sink-${KITCHEN_SINK_LABEL}-plugins.json" plugins list --json
  run_kitchen_sink_openclaw_capture "${KITCHEN_SINK_TMP_DIR}/kitchen-sink-${KITCHEN_SINK_LABEL}-inspect.json" plugins inspect "$KITCHEN_SINK_ID" --runtime --json
  run_kitchen_sink_openclaw_capture "${KITCHEN_SINK_TMP_DIR}/kitchen-sink-${KITCHEN_SINK_LABEL}-inspect-all.json" plugins inspect --all --runtime --json
  assert_kitchen_sink_installed
  if [ "$KITCHEN_SINK_SOURCE" = "clawhub" ]; then
    run_kitchen_sink_openclaw_logged "kitchen-sink-uninstall-${KITCHEN_SINK_LABEL}" plugins uninstall "$KITCHEN_SINK_SPEC" --force
  else
    run_kitchen_sink_openclaw_logged "kitchen-sink-uninstall-${KITCHEN_SINK_LABEL}" plugins uninstall "$KITCHEN_SINK_ID" --force
  fi
  remove_kitchen_sink_channel_config
  run_kitchen_sink_openclaw_capture "${KITCHEN_SINK_TMP_DIR}/kitchen-sink-${KITCHEN_SINK_LABEL}-uninstalled.json" plugins list --json
  assert_kitchen_sink_removed
}

run_failure_scenario() {
  echo "Testing expected ${KITCHEN_SINK_LABEL} install failure from ${KITCHEN_SINK_SPEC}..."
  run_expect_failure "install-${KITCHEN_SINK_LABEL}" openclaw_e2e_maybe_timeout "$KITCHEN_SINK_CLI_TIMEOUT" node "$OPENCLAW_ENTRY" plugins install "$KITCHEN_SINK_SPEC" --force
  remove_kitchen_sink_channel_config
  run_kitchen_sink_openclaw_capture "${KITCHEN_SINK_TMP_DIR}/kitchen-sink-${KITCHEN_SINK_LABEL}-uninstalled.json" plugins list --json
  assert_kitchen_sink_removed
}

run_kitchen_sink_sweep_main() {
  if [[ "$KITCHEN_SINK_SCENARIOS" == *"clawhub:"* ]]; then
    if [[ "${OPENCLAW_KITCHEN_SINK_LIVE_CLAWHUB:-0}" = "1" ]]; then
      export OPENCLAW_CLAWHUB_URL="${OPENCLAW_CLAWHUB_URL:-${CLAWHUB_URL:-https://clawhub.ai}}"
    else
      if [[ -n "${OPENCLAW_CLAWHUB_URL:-}" || -n "${CLAWHUB_URL:-}" ]]; then
        echo "Ignoring ambient ClawHub URL for fixture-mode kitchen-sink E2E; set OPENCLAW_KITCHEN_SINK_LIVE_CLAWHUB=1 for live ClawHub."
      fi
      unset OPENCLAW_CLAWHUB_URL CLAWHUB_URL
      clawhub_fixture_dir="$(mktemp -d "${KITCHEN_SINK_TMP_DIR}/clawhub.XXXXXX")"
      start_kitchen_sink_clawhub_fixture_server "$clawhub_fixture_dir"
    fi
  fi

  scenario_count=0
  while IFS='|' read -r label spec plugin_id source expectation surface_mode personality preinstall_spec; do
    if [ -z "${label:-}" ] || [[ "$label" == \#* ]]; then
      continue
    fi
    scenario_count=$((scenario_count + 1))
    export KITCHEN_SINK_LABEL="$label"
    export KITCHEN_SINK_SPEC="$spec"
    export KITCHEN_SINK_ID="$plugin_id"
    export KITCHEN_SINK_SOURCE="$source"
    export KITCHEN_SINK_SURFACE_MODE="$surface_mode"
    export KITCHEN_SINK_PERSONALITY="${personality:-}"
    export OPENCLAW_KITCHEN_SINK_PERSONALITY="${personality:-}"
    export KITCHEN_SINK_PREINSTALL_SPEC="${preinstall_spec:-}"
    case "$expectation" in
    success)
      run_success_scenario
      ;;
    failure)
      run_failure_scenario
      ;;
    *)
      echo "Unknown kitchen-sink expectation for ${label}: ${expectation}" >&2
      exit 1
      ;;
    esac
  done <<<"$KITCHEN_SINK_SCENARIOS"

  if [ "$scenario_count" -eq 0 ]; then
    echo "No kitchen-sink plugin scenarios configured." >&2
    exit 1
  fi

  scan_logs_for_unexpected_errors
  echo "kitchen-sink plugin Docker E2E passed (${scenario_count} scenario(s))"
}

if [[ "$KITCHEN_SINK_SWEEP_SOURCE_ONLY" != "1" ]]; then
  run_kitchen_sink_sweep_main
fi
