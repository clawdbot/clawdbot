#!/usr/bin/env bash
set -Eeuo pipefail
trap "" PIPE
export TERM=xterm-256color
export NO_COLOR=1

source scripts/lib/openclaw-e2e-instance.sh
source scripts/e2e/lib/prepublish-plugin-registry.sh

openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
openclaw_e2e_install_trash_shim

export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false
export OPENAI_API_KEY="sk-openclaw-release-typed-onboarding"

PORT="18789"
MOCK_PORT="44190"
SUCCESS_MARKER="OPENCLAW_E2E_OK_TYPED_ONBOARDING"
scenario_tmp="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-release-typed-onboarding.XXXXXX")"
LOG_DIR="$scenario_tmp/logs"
mkdir -p "$LOG_DIR"
INSTALL_LOG="$LOG_DIR/install.log"
ONBOARD_LOG="$LOG_DIR/onboard.log"
CODEX_INSTALL_LOG="$LOG_DIR/codex-install.log"
OPENAI_LOG="$LOG_DIR/openai.log"
AGENT_LOG="$LOG_DIR/agent.log"
MOCK_REQUEST_LOG="$scenario_tmp/openai-requests.jsonl"
export SUCCESS_MARKER MOCK_REQUEST_LOG

plugin_registry_pid=""
mock_pid=""
wizard_pid=""
input_fifo_dir=""
cleanup() {
  { exec 3>&-; } 2>/dev/null || true
  openclaw_e2e_stop_process "${wizard_pid:-}"
  openclaw_e2e_stop_process "${mock_pid:-}"
  openclaw_e2e_stop_process "${plugin_registry_pid:-}"
  if [ -n "${input_fifo_dir:-}" ]; then
    rm -rf "$input_fifo_dir"
  fi
  rm -rf "$scenario_tmp"
}
trap cleanup EXIT

dump_debug_logs() {
  local status="$1"
  echo "release typed onboarding failed with exit code $status" >&2
  openclaw_e2e_dump_logs \
    "$INSTALL_LOG" \
    "$ONBOARD_LOG" \
    "$CODEX_INSTALL_LOG" \
    "$OPENAI_LOG" \
    "$MOCK_REQUEST_LOG" \
    "$AGENT_LOG"
}
openclaw_e2e_enable_failure_diagnostics

send() {
  local payload="$1"
  local delay="${2:-0.4}"
  sleep "$delay"
  printf "%b" "$payload" >&3 2>/dev/null || true
}

wait_for_log() {
  local needle="$1"
  local timeout_s="${2:-60}"
  local start_s
  start_s="$(date +%s)"
  while true; do
    if [ -f "$ONBOARD_LOG" ]; then
      if grep -a -F -q "$needle" "$ONBOARD_LOG"; then
        return 0
      fi
      if node scripts/e2e/lib/onboard/log-contains.mjs "$ONBOARD_LOG" "$needle"; then
        return 0
      fi
    fi
    if [ $(($(date +%s) - start_s)) -ge "$timeout_s" ]; then
      echo "Timeout waiting for log: $needle" >&2
      tail -n 120 "$ONBOARD_LOG" 2>/dev/null || true
      return 1
    fi
    sleep 0.2
  done
}

openclaw_e2e_install_package "$INSTALL_LOG"
echo "Installed the OpenClaw package."
openclaw_prepublish_plugin_registry_start_mounted "$scenario_tmp/registry" plugin_registry_pid '["@openclaw/codex"]'
command -v openclaw >/dev/null
package_root="$(openclaw_e2e_package_root)"
entry="$(openclaw_e2e_package_entrypoint "$package_root")"
openclaw_e2e_enable_openclaw_cli_timeout

mock_pid="$(openclaw_e2e_start_mock_openai "$MOCK_PORT" "$OPENAI_LOG")"
openclaw_e2e_wait_mock_openai "$MOCK_PORT"
echo "Mock OpenAI provider is ready."

input_fifo_dir="$(mktemp -d "$scenario_tmp/input.XXXXXX")"
input_fifo="$input_fifo_dir/stdin.fifo"
mkfifo "$input_fifo"
openclaw_e2e_run_script_with_pty "node \"$entry\" onboard --flow quickstart --mode local --auth-choice skip --gateway-port \"$PORT\" --gateway-bind loopback --skip-daemon --skip-ui --skip-channels --skip-skills --skip-health --suppress-gateway-token-output" "$ONBOARD_LOG" <"$input_fifo" >/dev/null 2>&1 &
wizard_pid="$!"
exec 3>"$input_fifo"

wait_for_log "Continue?" 60
send $'y\r' 0.4
wait_for_log "Help make OpenClaw better?" 60
send $'\r' 0.4
wait_for_log "What should we call your first agent?" 60
send $'\r' 0.4
wait_for_log "to search" 60
send $'ollama\r' 0.4

wait "$wizard_pid"
wizard_pid=""
exec 3>&-
rm -rf "$input_fifo_dir"
input_fifo_dir=""
echo "Interactive typed onboarding completed."

node scripts/e2e/lib/release-scenarios/assertions.mjs assert-session-memory-hook-enabled

# Explicit older packages keep automatic setup; successful help establishes consent support.
plugin_install_help="$(openclaw plugins install --help)"
fixture_consent="$(printf '%s' "$plugin_install_help" | node scripts/e2e/lib/package-compat.mjs fixture-consent)"
if [ -n "$fixture_consent" ]; then
  codex_install_args=(codex)
  if [ -n "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ]; then
    candidate_version="${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION:?missing candidate version}"
    codex_install_args=("npm:@openclaw/codex@$candidate_version" --pin)
  fi
  openclaw_e2e_fixture_plugin_command openclaw -- plugins install "${codex_install_args[@]}" \
    >"$CODEX_INSTALL_LOG" 2>&1
fi

openclaw onboard \
  --non-interactive \
  --accept-risk \
  --flow quickstart \
  --mode local \
  --auth-choice openai-api-key \
  --secret-input-mode ref \
  --gateway-port "$PORT" \
  --gateway-bind loopback \
  --skip-daemon \
  --skip-ui \
  --skip-channels \
  --skip-skills \
  --skip-health \
  --suppress-gateway-token-output >>"$ONBOARD_LOG" 2>&1

node scripts/e2e/lib/release-scenarios/assertions.mjs assert-openai-env-ref "$OPENAI_API_KEY"
echo "OpenAI environment-reference onboarding completed."
node scripts/e2e/lib/release-scenarios/assertions.mjs configure-mock-openai "$MOCK_PORT"

if ! openclaw agent --local \
  --agent main \
  --session-id release-typed-onboarding-agent \
  --message "Return marker $SUCCESS_MARKER" \
  --thinking off \
  --json >"$AGENT_LOG" 2>&1; then
  dump_debug_logs 1
  exit 1
fi
node scripts/e2e/lib/release-scenarios/assertions.mjs assert-agent-turn "$SUCCESS_MARKER" "$AGENT_LOG" "$MOCK_REQUEST_LOG"

echo "Release typed onboarding scenario passed."
