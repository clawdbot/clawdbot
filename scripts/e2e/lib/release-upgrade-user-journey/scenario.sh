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
scenario_tmp="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-release-upgrade-user-journey.XXXXXX")"
LOG_DIR="$scenario_tmp/logs"
mkdir -p "$LOG_DIR"
BASELINE_INSTALL_LOG="$LOG_DIR/baseline-install.log"
CANDIDATE_INSTALL_LOG="$LOG_DIR/candidate-install.log"
ONBOARD_LOG="$LOG_DIR/onboard.log"
OPENAI_LOG="$LOG_DIR/openai.log"
PLUGIN_INSTALL_LOG="$LOG_DIR/plugin-install.log"
PLUGIN_CLI_BEFORE_LOG="$LOG_DIR/plugin-cli-before.log"
PLUGIN_CLI_AFTER_LOG="$LOG_DIR/plugin-cli-after.log"
AGENT_LOG="$LOG_DIR/agent.log"
STATUS_JSON="$LOG_DIR/status.json"
STATUS_ERR="$LOG_DIR/status.err"
CLICKCLACK_PLUGIN_INSTALL_LOG="$LOG_DIR/clickclack-plugin-install.log"
CLICKCLACK_OUTBOUND_JSON="$LOG_DIR/clickclack-outbound.json"
CLICKCLACK_OUTBOUND_ERR="$LOG_DIR/clickclack-outbound.err"
CLICKCLACK_SERVER_LOG="$LOG_DIR/clickclack-server.log"
GATEWAY_LOG="$LOG_DIR/gateway.log"
MOCK_REQUEST_LOG="$scenario_tmp/openai-requests.jsonl"
CLICKCLACK_STATE="$scenario_tmp/clickclack.json"
export SUCCESS_MARKER MOCK_REQUEST_LOG CLICKCLACK_STATE

candidate_version="$(
  tar -xOf "${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}" package/package.json |
    node -e 'let raw = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { raw += chunk; }); process.stdin.on("end", () => { process.stdout.write(JSON.parse(raw).version); });'
)"
if [ -n "${OPENCLAW_RELEASE_UPGRADE_BASELINE_SPEC:-}" ]; then
  BASELINE_SPEC="$OPENCLAW_RELEASE_UPGRADE_BASELINE_SPEC"
else
  BASELINE_SPEC="$(node scripts/lib/release-upgrade-baseline.mjs --candidate-version "$candidate_version")"
fi

mock_pid=""
clickclack_pid=""
gateway_pid=""
cleanup() {
  openclaw_e2e_terminate_gateways "${gateway_pid:-}"
  openclaw_e2e_stop_process "${clickclack_pid:-}"
  openclaw_e2e_stop_process "${mock_pid:-}"
  rm -rf "$scenario_tmp"
}
trap cleanup EXIT

dump_debug_logs() {
  local status="$1"
  echo "release upgrade user journey failed with exit code $status" >&2
  openclaw_e2e_dump_logs \
    "$BASELINE_INSTALL_LOG" \
    "$CANDIDATE_INSTALL_LOG" \
    "$ONBOARD_LOG" \
    "$OPENAI_LOG" \
    "$MOCK_REQUEST_LOG" \
    "$PLUGIN_INSTALL_LOG" \
    "$PLUGIN_CLI_BEFORE_LOG" \
    "$PLUGIN_CLI_AFTER_LOG" \
    "$AGENT_LOG" \
    "$STATUS_JSON" \
    "$CLICKCLACK_PLUGIN_INSTALL_LOG" \
    "$CLICKCLACK_OUTBOUND_JSON" \
    "$CLICKCLACK_SERVER_LOG" \
    "$GATEWAY_LOG" \
    "$CLICKCLACK_STATE"
}
trap 'status=$?; dump_debug_logs "$status"; exit "$status"' ERR

start_gateway() {
  local log_path="$1"
  gateway_pid="$(openclaw_e2e_start_gateway "$entry" "$PORT" "$log_path")"
  openclaw_e2e_wait_gateway_ready "$gateway_pid" "$log_path" 300 "$PORT"
}

echo "Installing published baseline $BASELINE_SPEC..."
if ! openclaw_e2e_maybe_timeout "${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}" npm install -g "$BASELINE_SPEC" --no-fund --no-audit >"$BASELINE_INSTALL_LOG" 2>&1; then
  cat "$BASELINE_INSTALL_LOG" >&2 || true
  exit 1
fi
command -v openclaw >/dev/null
baseline_root="$(openclaw_e2e_package_root)"
baseline_entry="$(openclaw_e2e_package_entrypoint "$baseline_root")"
openclaw_e2e_enable_openclaw_cli_timeout

mock_pid="$(openclaw_e2e_start_mock_openai "$MOCK_PORT" "$OPENAI_LOG")"
openclaw_e2e_wait_mock_openai "$MOCK_PORT"

CLICKCLACK_FIXTURE_PORT="$CLICKCLACK_PORT" \
CLICKCLACK_FIXTURE_TOKEN="$CLICKCLACK_BOT_TOKEN" \
CLICKCLACK_FIXTURE_STATE="$CLICKCLACK_STATE" \
  node scripts/e2e/lib/release-user-journey/clickclack-fixture.mjs >"$CLICKCLACK_SERVER_LOG" 2>&1 &
clickclack_pid="$!"
for _ in $(seq 1 100); do
  if openclaw_e2e_probe_http_status "http://127.0.0.1:$CLICKCLACK_PORT/health" 200 >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
openclaw_e2e_probe_http_status "http://127.0.0.1:$CLICKCLACK_PORT/health" 200

openclaw_e2e_run_command node "$baseline_entry" onboard \
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
  --skip-health >"$ONBOARD_LOG" 2>&1
node scripts/e2e/lib/release-scenarios/assertions.mjs configure-mock-openai "$MOCK_PORT"

plugin_dir="$(mktemp -d "$scenario_tmp/plugin.XXXXXX")"
node scripts/e2e/lib/release-scenarios/write-cli-plugin.mjs \
  "$plugin_dir" \
  release-upgrade-plugin \
  0.0.1 \
  release.upgrade.plugin \
  "Release Upgrade Plugin" \
  release-upgrade \
  "release-upgrade-plugin:pong"
openclaw plugins install "$plugin_dir" --force >"$PLUGIN_INSTALL_LOG" 2>&1
openclaw release-upgrade ping >"$PLUGIN_CLI_BEFORE_LOG" 2>&1
node scripts/e2e/lib/release-scenarios/assertions.mjs assert-file-contains "$PLUGIN_CLI_BEFORE_LOG" "release-upgrade-plugin:pong"
node scripts/e2e/lib/release-user-journey/assertions.mjs configure-clickclack "http://127.0.0.1:$CLICKCLACK_PORT"

openclaw_e2e_install_package "$CANDIDATE_INSTALL_LOG" "candidate OpenClaw package"
package_root="$(openclaw_e2e_package_root)"
entry="$(openclaw_e2e_package_entrypoint "$package_root")"
openclaw_e2e_enable_openclaw_cli_timeout
node scripts/e2e/lib/release-scenarios/assertions.mjs assert-package-version "$package_root" "$candidate_version" candidate

openclaw agent --local \
  --agent main \
  --session-id release-upgrade-user-journey-agent \
  --message "Return marker $SUCCESS_MARKER" \
  --thinking off \
  --json >"$AGENT_LOG" 2>&1
node scripts/e2e/lib/release-scenarios/assertions.mjs assert-agent-turn "$SUCCESS_MARKER" "$AGENT_LOG" "$MOCK_REQUEST_LOG"

openclaw release-upgrade ping >"$PLUGIN_CLI_AFTER_LOG" 2>&1
node scripts/e2e/lib/release-scenarios/assertions.mjs assert-file-contains "$PLUGIN_CLI_AFTER_LOG" "release-upgrade-plugin:pong"

clickclack_plugin_dir="$(mktemp -d "$scenario_tmp/clickclack-plugin.XXXXXX")"
node scripts/e2e/lib/release-user-journey/write-clickclack-plugin.mjs "$clickclack_plugin_dir"
openclaw plugins install "$clickclack_plugin_dir" --force >"$CLICKCLACK_PLUGIN_INSTALL_LOG" 2>&1

openclaw channels status --json >"$STATUS_JSON" 2>"$STATUS_ERR"
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-channel-status clickclack "$STATUS_JSON"
openclaw message send \
  --channel clickclack \
  --target channel:general \
  --message "release upgrade outbound" \
  --json >"$CLICKCLACK_OUTBOUND_JSON" 2>"$CLICKCLACK_OUTBOUND_ERR"
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-clickclack-state outbound "$CLICKCLACK_STATE" "release upgrade outbound"

start_gateway "$GATEWAY_LOG"
node scripts/e2e/lib/release-user-journey/assertions.mjs wait-clickclack-socket "http://127.0.0.1:$CLICKCLACK_PORT" 45
node scripts/e2e/lib/release-user-journey/assertions.mjs post-clickclack-inbound "http://127.0.0.1:$CLICKCLACK_PORT" "Return marker $SUCCESS_MARKER"
node scripts/e2e/lib/release-user-journey/assertions.mjs wait-clickclack-reply "$CLICKCLACK_STATE" "$SUCCESS_MARKER" 45

echo "Release upgrade user journey scenario passed."
