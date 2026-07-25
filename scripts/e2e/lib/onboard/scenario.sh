#!/usr/bin/env bash
set -euo pipefail
trap "" PIPE
export TERM=xterm-256color
source scripts/lib/openclaw-e2e-instance.sh
OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY="${OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY:-0}"
if [ "$OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY" != "1" ]; then
  openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_FUNCTION_B64:?missing OPENCLAW_TEST_STATE_FUNCTION_B64}"
fi
ONBOARD_FLAGS="${ONBOARD_FLAGS:---flow quickstart --auth-choice skip --skip-channels --skip-skills --skip-daemon --skip-ui}"
if [ -z "${OPENCLAW_ENTRY:-}" ] && [ "$OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY" != "1" ]; then
  OPENCLAW_ENTRY="$(openclaw_e2e_resolve_entrypoint)"
fi
export OPENCLAW_ENTRY
ONBOARD_TMP_ROOT="${OPENCLAW_ONBOARD_E2E_TMPDIR:-${TMPDIR:-/tmp}}"
ONBOARD_TMP_ROOT="${ONBOARD_TMP_ROOT%/}"
[ -n "$ONBOARD_TMP_ROOT" ] || ONBOARD_TMP_ROOT="/tmp"
mkdir -p "$ONBOARD_TMP_ROOT"
ONBOARD_TMP_DIR="$(mktemp -d "$ONBOARD_TMP_ROOT/openclaw-onboard.XXXXXX")"
OPENCLAW_E2E_LOG_DIR="$ONBOARD_TMP_DIR/logs"
GATEWAY_LOG_PATH="$ONBOARD_TMP_DIR/gateway-e2e.log"
export OPENCLAW_E2E_LOG_DIR
export GATEWAY_LOG_PATH
mkdir -p "$OPENCLAW_E2E_LOG_DIR"
cleanup_onboard_artifacts() {
  openclaw_e2e_stop_process "${GATEWAY_PID:-}"
  rm -rf "$ONBOARD_TMP_DIR"
}
if [ "$OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY" != "1" ]; then
  trap cleanup_onboard_artifacts EXIT
fi

# Provide a minimal trash shim to avoid noisy "missing trash" logs in containers.
if [ "$OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY" != "1" ]; then
  openclaw_e2e_install_trash_shim
fi

send() {
  local payload="$1"
  local delay="${2:-0.4}"
  # Let prompts render before sending keystrokes.
  sleep "$delay"
  printf "%b" "$payload" >&3 2>/dev/null || true
}

log_contains() {
  local needle="$1"
  if [ -z "${WIZARD_LOG_PATH:-}" ] || [ ! -f "$WIZARD_LOG_PATH" ]; then
    return 1
  fi
  if grep -a -F -q "$needle" "$WIZARD_LOG_PATH"; then
    return 0
  fi
  node scripts/e2e/lib/onboard/log-contains.mjs "$WIZARD_LOG_PATH" "$needle"
}

wait_for_log() {
  local needle="$1"
  local timeout_s="${2:-45}"
  local quiet_on_timeout="${3:-false}"
  local start_s
  start_s="$(date +%s)"
  while true; do
    if log_contains "$needle"; then
      return 0
    fi
    if [ $(($(date +%s) - start_s)) -ge "$timeout_s" ]; then
      if [ "$quiet_on_timeout" = "true" ]; then
        return 1
      fi
      echo "Timeout waiting for log: $needle"
      if [ -n "${WIZARD_LOG_PATH:-}" ] && [ -f "$WIZARD_LOG_PATH" ]; then
        tail -n 140 "$WIZARD_LOG_PATH" || true
      fi
      return 1
    fi
    sleep 0.2
  done
}

wait_for_skills_prompt_or_ready() {
  local timeout_s="${1:-45}"
  local start_s
  start_s="$(date +%s)"
  while true; do
    if log_contains "Configure skills now?"; then
      return 0
    fi
    if log_contains "All skills ready"; then
      return 2
    fi
    if [ $(($(date +%s) - start_s)) -ge "$timeout_s" ]; then
      echo "Timeout waiting for skills prompt or ready state"
      if [ -n "${WIZARD_LOG_PATH:-}" ] && [ -f "$WIZARD_LOG_PATH" ]; then
        tail -n 140 "$WIZARD_LOG_PATH" || true
      fi
      return 1
    fi
    sleep 0.2
  done
}

start_gateway() {
  GATEWAY_PID="$(openclaw_e2e_start_gateway "$OPENCLAW_ENTRY" 18789 "$GATEWAY_LOG_PATH")"
}

wait_for_gateway() {
  local wait_attempts
  wait_attempts="$(openclaw_e2e_read_positive_int_env OPENCLAW_ONBOARD_GATEWAY_WAIT_ATTEMPTS 20)" || return $?
  local wait_interval_s="${OPENCLAW_ONBOARD_GATEWAY_WAIT_INTERVAL_S:-1}"
  local saw_listening_log="false"
  for _ in $(seq 1 "$wait_attempts"); do
    if openclaw_e2e_probe_tcp 127.0.0.1 18789 500 >/dev/null 2>&1; then
      return 0
    fi
    if [ -f "$GATEWAY_LOG_PATH" ] && grep -E -q "listening on ws://[^ ]+:18789" "$GATEWAY_LOG_PATH"; then
      saw_listening_log="true"
    fi
    sleep "$wait_interval_s"
  done
  echo "Gateway failed to start"
  if [ "$saw_listening_log" = "true" ]; then
    echo "Gateway log reported listening, but TCP probe never succeeded"
  fi
  cat "$GATEWAY_LOG_PATH" || true
  return 1
}

stop_gateway() {
  openclaw_e2e_stop_process "$1"
}

cleanup_wizard_case() {
  exec 3>&- 2>/dev/null || true
  openclaw_e2e_stop_process "${wizard_pid:-}"
  stop_gateway "${gw_pid:-}"
  rm -rf "${input_fifo_dir:-}"
}

run_wizard_cmd() {
  local case_name="$1"
  local state_ref="$2"
  local command="$3"
  local send_fn="$4"
  local with_gateway="${5:-false}"
  local validate_fn="${6:-}"
  local input_fifo_dir=""
  local input_fifo=""
  local wizard_pid=""
  local gw_pid=""
  local wizard_status=0

  echo "== Wizard case: $case_name =="
  set_isolated_openclaw_env "$state_ref"

  input_fifo_dir="$(mktemp -d "$ONBOARD_TMP_DIR/${case_name}.fifo.XXXXXX")"
  input_fifo="$input_fifo_dir/stdin.fifo"
  if ! mkfifo "$input_fifo"; then
    rm -rf "$input_fifo_dir"
    return 1
  fi
  local log_path="$OPENCLAW_E2E_LOG_DIR/${case_name}.log"
  WIZARD_LOG_PATH="$log_path"
  export WIZARD_LOG_PATH
  # Run under script to keep an interactive TTY for clack prompts.
  openclaw_e2e_run_script_with_pty "$command" "$log_path" <"$input_fifo" >/dev/null 2>&1 &
  wizard_pid=$!
  if ! exec 3>"$input_fifo"; then
    cleanup_wizard_case
    return 1
  fi

  if [ "$with_gateway" = "true" ]; then
    start_gateway
    gw_pid="$GATEWAY_PID"
    if ! wait_for_gateway; then
      cleanup_wizard_case
      exit 1
    fi
  fi

  "$send_fn" || wizard_status=$?
  if [ "$wizard_status" -ne 0 ]; then
    cleanup_wizard_case
    echo "Wizard input driver exited with status $wizard_status"
    if [ -f "$log_path" ]; then
      tail -n 160 "$log_path" || true
    fi
    exit "$wizard_status"
  fi

  wait "$wizard_pid" || wizard_status=$?
  wizard_pid=""
  if [ "$wizard_status" -ne 0 ]; then
    cleanup_wizard_case
    echo "Wizard exited with status $wizard_status"
    if [ -f "$log_path" ]; then
      tail -n 160 "$log_path" || true
    fi
    exit "$wizard_status"
  fi
  cleanup_wizard_case
  if [ -n "$validate_fn" ]; then
    "$validate_fn" "$log_path"
  fi
}

assert_onboard_config() {
  local scenario="$1"
  shift
  openclaw_e2e_assert_file "$OPENCLAW_CONFIG_PATH"
  node scripts/e2e/lib/onboard/assert-config.mjs "$scenario" "$OPENCLAW_CONFIG_PATH" "$@"
}

set_isolated_openclaw_env() {
  local state_ref="$1"
  openclaw_test_state_create "$state_ref" empty
}

send_channels_flow() {
  # Configure channels via configure wizard. Use the remove-config branch for
  # a stable no-op smoke path when the config starts empty.
  # Section-scoped configure flows skip gateway run-mode selection.
  wait_for_log "Channel setup" 120
  send $'\e[B\r' 0.8
  # Keep stdin open until wizard exits.
  send "" 2.0
}

send_skills_flow() {
  # configure --section skills still runs the configure wizard, without the
  # gateway run-mode prompt used by the full wizard.
  if wait_for_skills_prompt_or_ready 120; then
    send $'n\r' 0.8
  else
    local status="$?"
    if [ "$status" -ne 2 ]; then
      return "$status"
    fi
  fi
  send "" 2.0
}

run_case_local_basic() {
  set_isolated_openclaw_env local-basic
  openclaw_e2e_run_logged local-basic node "$OPENCLAW_ENTRY" onboard \
    --non-interactive \
    --accept-risk \
    --flow quickstart \
    --mode local \
    --skip-channels \
    --skip-skills \
    --skip-daemon \
    --skip-ui \
    --skip-health

  validate_local_basic_log "$OPENCLAW_E2E_LAST_LOG_PATH"

  # Assert config + workspace scaffolding.
  workspace_dir="$OPENCLAW_STATE_DIR/workspace"
  sessions_dir="$OPENCLAW_STATE_DIR/agents/main/sessions"

  openclaw_e2e_assert_dir "$sessions_dir"
  for file in AGENTS.md BOOTSTRAP.md IDENTITY.md SOUL.md TOOLS.md USER.md; do
    openclaw_e2e_assert_file "$workspace_dir/$file"
  done

  assert_onboard_config local-basic "$workspace_dir"

}

run_case_remote_non_interactive() {
  set_isolated_openclaw_env remote-non-interactive
  # Smoke test non-interactive remote config write.
  openclaw_e2e_run_logged remote-non-interactive node "$OPENCLAW_ENTRY" onboard --non-interactive --accept-risk \
    --mode remote \
    --remote-url ws://gateway.local:18789 \
    --remote-token remote-token \
    --skip-skills \
    --skip-health

  assert_onboard_config remote-non-interactive
}

run_case_reset() {
  set_isolated_openclaw_env reset-config
  node scripts/e2e/lib/onboard/write-config.mjs reset "$OPENCLAW_CONFIG_PATH"

  openclaw_e2e_run_logged reset-config node "$OPENCLAW_ENTRY" onboard \
    --non-interactive \
    --accept-risk \
    --flow quickstart \
    --mode local \
    --reset \
    --skip-channels \
    --skip-skills \
    --skip-daemon \
    --skip-ui \
    --skip-health

  assert_onboard_config reset
}

run_case_channels() {
  # Channels-only configure flow.
  run_wizard_cmd channels channels "node \"$OPENCLAW_ENTRY\" configure --section channels" send_channels_flow

  assert_onboard_config channels
}

run_case_skills() {
  local home_dir
  set_isolated_openclaw_env skills
  home_dir="$HOME"
  node scripts/e2e/lib/onboard/write-config.mjs skills "$OPENCLAW_CONFIG_PATH"

  run_wizard_cmd skills "$home_dir" "node \"$OPENCLAW_ENTRY\" configure --section skills" send_skills_flow

  assert_onboard_config skills
}

validate_local_basic_log() {
  local log_path="$1"
  openclaw_e2e_assert_log_not_contains "$log_path" "systemctl --user unavailable"
}

if [ "$OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY" != "1" ]; then
  run_case_local_basic
  run_case_remote_non_interactive
  run_case_reset
  run_case_channels
  run_case_skills
fi
