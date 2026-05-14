#!/usr/bin/env bash
set -euo pipefail
trap "" PIPE
export TERM=xterm-256color
export NO_COLOR=1

source scripts/lib/openclaw-e2e-instance.sh

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
MOCK_REQUEST_LOG="/tmp/openclaw-release-typed-onboarding-openai.jsonl"
export SUCCESS_MARKER MOCK_REQUEST_LOG

mock_pid=""
cleanup() {
  openclaw_e2e_stop_process "${mock_pid:-}"
}
trap cleanup EXIT

dump_debug_logs() {
  local status="$1"
  echo "release typed onboarding failed with exit code $status" >&2
  openclaw_e2e_dump_logs \
    /tmp/openclaw-release-typed-onboarding-install.log \
    /tmp/openclaw-release-typed-onboarding.log \
    /tmp/openclaw-release-typed-onboarding-openai.log \
    "$MOCK_REQUEST_LOG" \
    /tmp/openclaw-release-typed-onboarding-agent.log \
    "$OPENCLAW_CONFIG_PATH" \
    "$HOME/.openclaw/agents/main/agent/auth-profiles.json"
}
trap 'status=$?; dump_debug_logs "$status"; exit "$status"' ERR

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
    if [ -f /tmp/openclaw-release-typed-onboarding.log ]; then
      if grep -a -F -q "$needle" /tmp/openclaw-release-typed-onboarding.log; then
        return 0
      fi
      if node scripts/e2e/lib/onboard/log-contains.mjs /tmp/openclaw-release-typed-onboarding.log "$needle"; then
        return 0
      fi
    fi
    if [ $(($(date +%s) - start_s)) -ge "$timeout_s" ]; then
      echo "Timeout waiting for log: $needle" >&2
      tail -n 120 /tmp/openclaw-release-typed-onboarding.log 2>/dev/null || true
      return 1
    fi
    sleep 0.2
  done
}

openclaw_e2e_install_package /tmp/openclaw-release-typed-onboarding-install.log
command -v openclaw >/dev/null
package_root="$(openclaw_e2e_package_root)"
entry="$(openclaw_e2e_package_entrypoint "$package_root")"

mock_pid="$(openclaw_e2e_start_mock_openai "$MOCK_PORT" /tmp/openclaw-release-typed-onboarding-openai.log)"
openclaw_e2e_wait_mock_openai "$MOCK_PORT"

input_fifo="$(mktemp -u "/tmp/openclaw-release-typed-onboarding.XXXXXX")"
mkfifo "$input_fifo"
script -q -f -c "node \"$entry\" onboard --flow quickstart --mode local --auth-choice skip --gateway-port \"$PORT\" --gateway-bind loopback --skip-daemon --skip-ui --skip-channels --skip-skills --skip-health" /tmp/openclaw-release-typed-onboarding.log <"$input_fifo" >/dev/null 2>&1 &
wizard_pid="$!"
exec 3>"$input_fifo"

wait_for_log "Continue?" 60
send $'y\r' 0.4
wait_for_log "to search" 60
send $'ollama\r' 0.4
wait_for_log "Enable hooks?" 60
send $' \r' 0.4
send $'\r' 0.4

wait "$wizard_pid"
exec 3>&-
rm -f "$input_fifo"

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
  --skip-health >>/tmp/openclaw-release-typed-onboarding.log 2>&1

node scripts/e2e/lib/release-scenarios/assertions.mjs assert-openai-env-ref "$OPENAI_API_KEY"
node scripts/e2e/lib/release-scenarios/assertions.mjs configure-mock-openai "$MOCK_PORT"

openclaw agent --local \
  --agent main \
  --session-id release-typed-onboarding-agent \
  --message "Return marker $SUCCESS_MARKER" \
  --thinking off \
  --json >/tmp/openclaw-release-typed-onboarding-agent.log 2>&1
node scripts/e2e/lib/release-scenarios/assertions.mjs assert-agent-turn "$SUCCESS_MARKER" /tmp/openclaw-release-typed-onboarding-agent.log "$MOCK_REQUEST_LOG"

echo "Release typed onboarding scenario passed."
