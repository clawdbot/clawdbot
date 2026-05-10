#!/usr/bin/env bash
set -euo pipefail
trap "" PIPE
export TERM=xterm-256color
source scripts/lib/openclaw-e2e-instance.sh
openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_FUNCTION_B64:?missing OPENCLAW_TEST_STATE_FUNCTION_B64}"
ONBOARD_FLAGS="--flow quickstart --auth-choice skip --skip-channels --skip-skills --skip-daemon --skip-ui"
OPENCLAW_ENTRY="$(openclaw_e2e_resolve_entrypoint)"
export OPENCLAW_ENTRY

# Provide a minimal trash shim to avoid noisy "missing trash" logs in containers.
openclaw_e2e_install_trash_shim

send() {
  local payload="$1"
  local delay="${2:-0.4}"
  # Let prompts render before sending keystrokes.
  sleep "$delay"
  printf "%b" "$payload" >&3 2>/dev/null || true
}

wait_for_log() {
  local needle="$1"
  local timeout_s="${2:-45}"
  local quiet_on_timeout="${3:-false}"
  local start_s
  start_s="$(date +%s)"
  while true; do
    if [ -n "${WIZARD_LOG_PATH:-}" ] && [ -f "$WIZARD_LOG_PATH" ]; then
      if grep -a -F -q "$needle" "$WIZARD_LOG_PATH"; then
        return 0
      fi
      if node scripts/e2e/lib/onboard/log-contains.mjs "$WIZARD_LOG_PATH" "$needle"; then
        return 0
      fi
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

start_gateway() {
  GATEWAY_PID="$(openclaw_e2e_start_gateway "$OPENCLAW_ENTRY" 18789 /tmp/gateway-e2e.log)"
}

wait_for_gateway() {
  for _ in $(seq 1 20); do
    if openclaw_e2e_probe_tcp 127.0.0.1 18789 500 >/dev/null 2>&1; then
      return 0
    fi
    if [ -f /tmp/gateway-e2e.log ] && grep -E -q "listening on ws://[^ ]+:18789" /tmp/gateway-e2e.log; then
      if [ -n "${GATEWAY_PID:-}" ] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
        return 0
      fi
    fi
    sleep 1
  done
  echo "Gateway failed to start"
  cat /tmp/gateway-e2e.log || true
  return 1
}

stop_gateway() {
  openclaw_e2e_stop_process "$1"
}

run_wizard_cmd() {
  local case_name="$1"
  local state_ref="$2"
  local command="$3"
  local send_fn="$4"
  local with_gateway="${5:-false}"
  local validate_fn="${6:-}"

  echo "== Wizard case: $case_name =="
  set_isolated_openclaw_env "$state_ref"

  input_fifo="$(mktemp -u "/tmp/openclaw-onboard-${case_name}.XXXXXX")"
  mkfifo "$input_fifo"
  local log_path="/tmp/openclaw-onboard-${case_name}.log"
  WIZARD_LOG_PATH="$log_path"
  export WIZARD_LOG_PATH
  # Run under script to keep an interactive TTY for clack prompts.
  script -q -f -c "$command" "$log_path" <"$input_fifo" >/dev/null 2>&1 &
  wizard_pid=$!
  exec 3>"$input_fifo"

  local gw_pid=""
  if [ "$with_gateway" = "true" ]; then
    start_gateway
    gw_pid="$GATEWAY_PID"
    wait_for_gateway
  fi

  "$send_fn"

  if ! wait "$wizard_pid"; then
    wizard_status=$?
    exec 3>&-
    rm -f "$input_fifo"
    stop_gateway "$gw_pid"
    echo "Wizard exited with status $wizard_status"
    if [ -f "$log_path" ]; then
      tail -n 160 "$log_path" || true
    fi
    exit "$wizard_status"
  fi
  exec 3>&-
  rm -f "$input_fifo"
  stop_gateway "$gw_pid"
  if [ -n "$validate_fn" ]; then
    "$validate_fn" "$log_path"
  fi
}

run_wizard() {
  local case_name="$1"
  local state_ref="$2"
  local send_fn="$3"
  local validate_fn="${4:-}"

  # Default onboarding command wrapper.
  run_wizard_cmd "$case_name" "$state_ref" "node \"$OPENCLAW_ENTRY\" onboard $ONBOARD_FLAGS" "$send_fn" true "$validate_fn"
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

select_skip_hooks() {
  # Hooks multiselect: pick "Skip for now".
  wait_for_log "Enable hooks?" 60
  send $' \r' 0.6
}

send_local_basic() {
  # Risk acknowledgement (default is "No").
  wait_for_log "Continue?" 60
  send $'y\r' 0.6
  # Non-interactive flow; no gateway-location prompt.
  select_skip_hooks
}

send_reset_config_only() {
  # Risk acknowledgement (default is "No").
  wait_for_log "Continue?" 40
  send $'y\r' 0.8
  # Select reset flow for existing config.
  wait_for_log "Config handling" 40
  send $'\e[B' 0.3
  send $'\e[B' 0.3
  send $'\r' 0.4
  # Reset scope -> Config only (default).
  wait_for_log "Reset scope" 40
  send $'\r' 0.4
  select_skip_hooks
}

send_channels_flow() {
  # Configure channels via configure wizard. Use the remove-config branch for
  # a stable no-op smoke path when the config starts empty.
  wait_for_log "Where will the Gateway run?" 120
  send $'\r' 0.6
  wait_for_log "Channel setup" 120
  send $'\e[B\r' 0.8
  # Keep stdin open until wizard exits.
  send "" 2.0
}

send_skills_flow() {
  # configure --section skills still runs the configure wizard.
  wait_for_log "Where will the Gateway run?" 120
  send $'\r' 0.6
  wait_for_log "Configure skills now?" 120
  send $'n\r' 0.8
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

run_case_local_basic
run_case_remote_non_interactive
run_case_reset
run_case_channels
run_case_skills
