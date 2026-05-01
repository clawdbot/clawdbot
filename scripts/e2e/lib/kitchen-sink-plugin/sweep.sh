#!/usr/bin/env bash
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
source scripts/lib/docker-e2e-logs.sh

OPENCLAW_ENTRY="$(openclaw_e2e_resolve_entrypoint)"
export OPENCLAW_ENTRY

openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"

run_expect_failure() {
  local label="$1"
  shift
  local output_file="/tmp/kitchen-sink-expected-failure-${label}.txt"
  set +e
  "$@" >"$output_file" 2>&1
  local status="$?"
  set -e
  cat "$output_file"
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

  local wait_attempts="${OPENCLAW_CLAWHUB_FIXTURE_WAIT_ATTEMPTS:-600}"
  for _ in $(seq 1 "$wait_attempts"); do
    if [[ -s "$server_port_file" ]]; then
      export OPENCLAW_CLAWHUB_URL="http://127.0.0.1:$(cat "$server_port_file")"
      trap 'if [[ -f "'"$server_pid_file"'" ]]; then kill "$(cat "'"$server_pid_file"'")" 2>/dev/null || true; fi' EXIT
      return 0
    fi
    if ! kill -0 "$server_pid" 2>/dev/null; then
      cat "$server_log"
      return 1
    fi
    sleep 0.1
  done

  cat "$server_log"
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

run_success_scenario() {
  echo "Testing ${KITCHEN_SINK_LABEL} install from ${KITCHEN_SINK_SPEC}..."
  run_logged_print "kitchen-sink-install-${KITCHEN_SINK_LABEL}" node "$OPENCLAW_ENTRY" plugins install "$KITCHEN_SINK_SPEC"
  configure_kitchen_sink_runtime
  run_logged_print "kitchen-sink-enable-${KITCHEN_SINK_LABEL}" node "$OPENCLAW_ENTRY" plugins enable "$KITCHEN_SINK_ID"
  node "$OPENCLAW_ENTRY" plugins list --json >"/tmp/kitchen-sink-${KITCHEN_SINK_LABEL}-plugins.json"
  node "$OPENCLAW_ENTRY" plugins inspect "$KITCHEN_SINK_ID" --json >"/tmp/kitchen-sink-${KITCHEN_SINK_LABEL}-inspect.json"
  node "$OPENCLAW_ENTRY" plugins inspect --all --json >"/tmp/kitchen-sink-${KITCHEN_SINK_LABEL}-inspect-all.json"
  assert_kitchen_sink_installed
  if [ "$KITCHEN_SINK_SOURCE" = "clawhub" ]; then
    run_logged_print "kitchen-sink-uninstall-${KITCHEN_SINK_LABEL}" node "$OPENCLAW_ENTRY" plugins uninstall "$KITCHEN_SINK_SPEC" --force
  else
    run_logged_print "kitchen-sink-uninstall-${KITCHEN_SINK_LABEL}" node "$OPENCLAW_ENTRY" plugins uninstall "$KITCHEN_SINK_ID" --force
  fi
  remove_kitchen_sink_channel_config
  node "$OPENCLAW_ENTRY" plugins list --json >"/tmp/kitchen-sink-${KITCHEN_SINK_LABEL}-uninstalled.json"
  assert_kitchen_sink_removed
}

run_failure_scenario() {
  echo "Testing expected ${KITCHEN_SINK_LABEL} install failure from ${KITCHEN_SINK_SPEC}..."
  run_expect_failure "install-${KITCHEN_SINK_LABEL}" node "$OPENCLAW_ENTRY" plugins install "$KITCHEN_SINK_SPEC"
  remove_kitchen_sink_channel_config
  node "$OPENCLAW_ENTRY" plugins list --json >"/tmp/kitchen-sink-${KITCHEN_SINK_LABEL}-uninstalled.json"
  assert_kitchen_sink_removed
}

if [[ "$KITCHEN_SINK_SCENARIOS" == *"clawhub:"* ]] &&
  [[ "${OPENCLAW_KITCHEN_SINK_LIVE_CLAWHUB:-0}" != "1" ]] &&
  [[ -z "${OPENCLAW_CLAWHUB_URL:-}" && -z "${CLAWHUB_URL:-}" ]]; then
  clawhub_fixture_dir="$(mktemp -d "/tmp/openclaw-kitchen-sink-clawhub.XXXXXX")"
  start_kitchen_sink_clawhub_fixture_server "$clawhub_fixture_dir"
fi

scenario_count=0
while IFS='|' read -r label spec plugin_id source expectation surface_mode personality; do
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
