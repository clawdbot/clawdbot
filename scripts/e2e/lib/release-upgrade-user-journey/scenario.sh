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
export OPENAI_API_KEY="sk-openclaw-release-upgrade-user-journey"
export CLICKCLACK_BOT_TOKEN="clickclack-release-upgrade-token"

PORT="18789"
MOCK_PORT="44210"
CLICKCLACK_PORT="44211"
SUCCESS_MARKER="OPENCLAW_E2E_OK_RELEASE_UPGRADE"
MOCK_REQUEST_LOG="/tmp/openclaw-release-upgrade-user-journey-openai.jsonl"
CLICKCLACK_STATE="/tmp/openclaw-release-upgrade-user-journey-clickclack.json"
BASELINE_SPEC="${OPENCLAW_RELEASE_UPGRADE_BASELINE_SPEC:-openclaw@latest}"
export SUCCESS_MARKER MOCK_REQUEST_LOG CLICKCLACK_STATE

mock_pid=""
clickclack_pid=""
gateway_pid=""
cleanup() {
  openclaw_e2e_terminate_gateways "${gateway_pid:-}"
  openclaw_e2e_stop_process "${clickclack_pid:-}"
  openclaw_e2e_stop_process "${mock_pid:-}"
}
trap cleanup EXIT

dump_debug_logs() {
  local status="$1"
  echo "release upgrade user journey failed with exit code $status" >&2
  openclaw_e2e_dump_logs \
    /tmp/openclaw-release-upgrade-baseline-install.log \
    /tmp/openclaw-release-upgrade-candidate-install.log \
    /tmp/openclaw-release-upgrade-onboard.log \
    /tmp/openclaw-release-upgrade-openai.log \
    "$MOCK_REQUEST_LOG" \
    /tmp/openclaw-release-upgrade-plugin-install.log \
    /tmp/openclaw-release-upgrade-plugin-cli-before.log \
    /tmp/openclaw-release-upgrade-plugin-cli-after.log \
    /tmp/openclaw-release-upgrade-agent.log \
    /tmp/openclaw-release-upgrade-status.json \
    /tmp/openclaw-release-upgrade-clickclack-outbound.json \
    /tmp/openclaw-release-upgrade-clickclack-server.log \
    /tmp/openclaw-release-upgrade-gateway.log \
    "$CLICKCLACK_STATE"
}
trap 'status=$?; dump_debug_logs "$status"; exit "$status"' ERR

start_gateway() {
  local log_path="$1"
  gateway_pid="$(openclaw_e2e_start_gateway "$entry" "$PORT" "$log_path")"
  openclaw_e2e_wait_gateway_ready "$gateway_pid" "$log_path"
}

echo "Installing published baseline $BASELINE_SPEC..."
npm install -g "$BASELINE_SPEC" --no-fund --no-audit >/tmp/openclaw-release-upgrade-baseline-install.log 2>&1
command -v openclaw >/dev/null
baseline_root="$(openclaw_e2e_package_root)"
baseline_entry="$(openclaw_e2e_package_entrypoint "$baseline_root")"

mock_pid="$(openclaw_e2e_start_mock_openai "$MOCK_PORT" /tmp/openclaw-release-upgrade-openai.log)"
openclaw_e2e_wait_mock_openai "$MOCK_PORT"

CLICKCLACK_FIXTURE_PORT="$CLICKCLACK_PORT" \
CLICKCLACK_FIXTURE_TOKEN="$CLICKCLACK_BOT_TOKEN" \
CLICKCLACK_FIXTURE_STATE="$CLICKCLACK_STATE" \
  node scripts/e2e/lib/release-user-journey/clickclack-fixture.mjs >/tmp/openclaw-release-upgrade-clickclack-server.log 2>&1 &
clickclack_pid="$!"
for _ in $(seq 1 100); do
  if openclaw_e2e_probe_http_status "http://127.0.0.1:$CLICKCLACK_PORT/health" 200 >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
openclaw_e2e_probe_http_status "http://127.0.0.1:$CLICKCLACK_PORT/health" 200

node "$baseline_entry" onboard \
  --non-interactive \
  --accept-risk \
  --flow quickstart \
  --mode local \
  --auth-choice skip \
  --gateway-port "$PORT" \
  --gateway-bind loopback \
  --skip-daemon \
  --skip-ui \
  --skip-channels \
  --skip-skills \
  --skip-health >/tmp/openclaw-release-upgrade-onboard.log 2>&1
node scripts/e2e/lib/release-scenarios/assertions.mjs configure-mock-openai "$MOCK_PORT"

plugin_dir="$(mktemp -d "/tmp/openclaw-release-upgrade-plugin.XXXXXX")"
node scripts/e2e/lib/release-scenarios/write-cli-plugin.mjs \
  "$plugin_dir" \
  release-upgrade-plugin \
  0.0.1 \
  release.upgrade.plugin \
  "Release Upgrade Plugin" \
  release-upgrade \
  "release-upgrade-plugin:pong"
openclaw plugins install "$plugin_dir" >/tmp/openclaw-release-upgrade-plugin-install.log 2>&1
openclaw release-upgrade ping >/tmp/openclaw-release-upgrade-plugin-cli-before.log 2>&1
node scripts/e2e/lib/release-scenarios/assertions.mjs assert-file-contains /tmp/openclaw-release-upgrade-plugin-cli-before.log "release-upgrade-plugin:pong"
node scripts/e2e/lib/release-user-journey/assertions.mjs configure-clickclack "http://127.0.0.1:$CLICKCLACK_PORT"

openclaw_e2e_install_package /tmp/openclaw-release-upgrade-candidate-install.log "candidate OpenClaw package"
package_root="$(openclaw_e2e_package_root)"
entry="$(openclaw_e2e_package_entrypoint "$package_root")"

openclaw agent --local \
  --agent main \
  --session-id release-upgrade-user-journey-agent \
  --message "Return marker $SUCCESS_MARKER" \
  --thinking off \
  --json >/tmp/openclaw-release-upgrade-agent.log 2>&1
node scripts/e2e/lib/release-scenarios/assertions.mjs assert-agent-turn "$SUCCESS_MARKER" /tmp/openclaw-release-upgrade-agent.log "$MOCK_REQUEST_LOG"

openclaw release-upgrade ping >/tmp/openclaw-release-upgrade-plugin-cli-after.log 2>&1
node scripts/e2e/lib/release-scenarios/assertions.mjs assert-file-contains /tmp/openclaw-release-upgrade-plugin-cli-after.log "release-upgrade-plugin:pong"

openclaw channels status --json >/tmp/openclaw-release-upgrade-status.json 2>/tmp/openclaw-release-upgrade-status.err
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-channel-status clickclack /tmp/openclaw-release-upgrade-status.json
openclaw message send \
  --channel clickclack \
  --target channel:general \
  --message "release upgrade outbound" \
  --json >/tmp/openclaw-release-upgrade-clickclack-outbound.json 2>/tmp/openclaw-release-upgrade-clickclack-outbound.err
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-clickclack-state outbound "$CLICKCLACK_STATE" "release upgrade outbound"

start_gateway /tmp/openclaw-release-upgrade-gateway.log
node scripts/e2e/lib/release-user-journey/assertions.mjs wait-clickclack-socket "http://127.0.0.1:$CLICKCLACK_PORT" 45
node scripts/e2e/lib/release-user-journey/assertions.mjs post-clickclack-inbound "http://127.0.0.1:$CLICKCLACK_PORT" "Return marker $SUCCESS_MARKER"
node scripts/e2e/lib/release-user-journey/assertions.mjs wait-clickclack-reply "$CLICKCLACK_STATE" "$SUCCESS_MARKER" 45

echo "Release upgrade user journey scenario passed."
