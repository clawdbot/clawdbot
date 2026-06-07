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
export OPENAI_API_KEY="sk-openclaw-release-user-journey"
export OPENCLAW_GATEWAY_TOKEN="release-user-journey-token"
export CLICKCLACK_BOT_TOKEN="clickclack-release-token"

PORT="18789"
MOCK_PORT="44180"
CLICKCLACK_PORT="44181"
SUCCESS_MARKER="OPENCLAW_E2E_OK_RELEASE_USER_JOURNEY"
scenario_tmp="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-release-user-journey.XXXXXX")"
LOG_DIR="$scenario_tmp/logs"
mkdir -p "$LOG_DIR"
INSTALL_LOG="$LOG_DIR/install.log"
ONBOARD_LOG="$LOG_DIR/onboard.log"
OPENAI_LOG="$LOG_DIR/openai.log"
AGENT_LOG="$LOG_DIR/agent.log"
PLUGIN_A_INSTALL_LOG="$LOG_DIR/plugin-a-install.log"
PLUGIN_A_CLI_LOG="$LOG_DIR/plugin-a-cli.log"
PLUGIN_A_UNINSTALL_LOG="$LOG_DIR/plugin-a-uninstall.log"
PLUGIN_B_INSTALL_LOG="$LOG_DIR/plugin-b-install.log"
PLUGIN_B_CLI_LOG="$LOG_DIR/plugin-b-cli.log"
PLUGIN_B_AFTER_RESTART_JSON="$LOG_DIR/plugin-b-after-restart.json"
CLICKCLACK_SERVER_LOG="$LOG_DIR/clickclack-server.log"
CLICKCLACK_OUTBOUND_JSON="$LOG_DIR/clickclack-outbound.json"
CLICKCLACK_OUTBOUND_ERR="$LOG_DIR/clickclack-outbound.err"
GATEWAY_1_LOG="$LOG_DIR/gateway-1.log"
GATEWAY_2_LOG="$LOG_DIR/gateway-2.log"
STATUS_JSON="$LOG_DIR/status.json"
STATUS_ERR="$LOG_DIR/status.err"
STATUS_AFTER_RESTART_JSON="$LOG_DIR/status-after-restart.json"
STATUS_AFTER_RESTART_ERR="$LOG_DIR/status-after-restart.err"
DOCTOR_LOG="$LOG_DIR/doctor.log"
PLUGIN_A_INSTALL_PATH_FILE="$scenario_tmp/plugin-a-install-path.txt"
PLUGIN_A_SOURCE_PATH_FILE="$scenario_tmp/plugin-a-source-path.txt"
MOCK_REQUEST_LOG="$scenario_tmp/openai-requests.jsonl"
CLICKCLACK_STATE="$scenario_tmp/clickclack.json"
export SUCCESS_MARKER MOCK_REQUEST_LOG CLICKCLACK_STATE

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
  echo "release user journey failed with exit code $status" >&2
  openclaw_e2e_dump_logs \
    "$INSTALL_LOG" \
    "$ONBOARD_LOG" \
    "$OPENAI_LOG" \
    "$MOCK_REQUEST_LOG" \
    "$AGENT_LOG" \
    "$PLUGIN_A_INSTALL_LOG" \
    "$PLUGIN_A_CLI_LOG" \
    "$PLUGIN_A_UNINSTALL_LOG" \
    "$PLUGIN_B_INSTALL_LOG" \
    "$PLUGIN_B_CLI_LOG" \
    "$CLICKCLACK_SERVER_LOG" \
    "$CLICKCLACK_OUTBOUND_JSON" \
    "$GATEWAY_1_LOG" \
    "$GATEWAY_2_LOG" \
    "$STATUS_JSON" \
    "$STATUS_AFTER_RESTART_JSON" \
    "$DOCTOR_LOG" \
    "$CLICKCLACK_STATE"
}
trap 'status=$?; dump_debug_logs "$status"; exit "$status"' ERR

start_gateway() {
  local log_path="$1"
  gateway_pid="$(openclaw_e2e_start_gateway "$entry" "$PORT" "$log_path")"
  openclaw_e2e_wait_gateway_ready "$gateway_pid" "$log_path" 300 "$PORT"
}

stop_gateway() {
  openclaw_e2e_terminate_gateways "${gateway_pid:-}"
  gateway_pid=""
}

write_journey_plugin() {
  local dir="$1"
  local id="$2"
  local version="$3"
  local method="$4"
  local name="$5"
  local cli_root="$6"
  local cli_output="$7"

  mkdir -p "$dir"
  node - "$dir" "$id" "$version" "$method" "$name" "$cli_root" "$cli_output" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const [dir, id, version, method, name, cliRoot, cliOutput] = process.argv.slice(2);
fs.writeFileSync(
  path.join(dir, "package.json"),
  `${JSON.stringify(
    {
      name: `@openclaw/${id}`,
      version,
      openclaw: { extensions: ["./index.js"] },
    },
    null,
    2,
  )}\n`,
);
fs.writeFileSync(
  path.join(dir, "index.js"),
  `module.exports = { id: ${JSON.stringify(id)}, name: ${JSON.stringify(name)}, register(api) { api.registerGatewayMethod(${JSON.stringify(method)}, async () => ({ ok: true })); api.registerCli(({ program }) => { const root = program.command(${JSON.stringify(cliRoot)}).description(${JSON.stringify(`${name} fixture command`)}); root.command("ping").description("Print fixture ping output").action(() => { console.log(${JSON.stringify(cliOutput)}); }); }, { descriptors: [{ name: ${JSON.stringify(cliRoot)}, description: ${JSON.stringify(`${name} fixture command`)}, hasSubcommands: true }] }); }, };\n`,
);
fs.writeFileSync(
  path.join(dir, "openclaw.plugin.json"),
  `${JSON.stringify({ id, configSchema: { type: "object", properties: {} } }, null, 2)}\n`,
);
NODE
}

openclaw_e2e_install_package "$INSTALL_LOG"
command -v openclaw >/dev/null
package_root="$(openclaw_e2e_package_root)"
entry="$(openclaw_e2e_package_entrypoint "$package_root")"
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

echo "Running non-interactive onboarding..."
openclaw onboard \
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
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-onboard "$HOME"
node scripts/e2e/lib/release-user-journey/assertions.mjs configure-mock-model "$MOCK_PORT"

echo "Running package-installed agent turn..."
openclaw agent --local \
  --agent main \
  --session-id release-user-journey-agent \
  --message "Return marker $SUCCESS_MARKER" \
  --thinking off \
  --json >"$AGENT_LOG" 2>&1
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-agent-turn "$SUCCESS_MARKER" "$AGENT_LOG" "$MOCK_REQUEST_LOG"

echo "Installing first external plugin..."
plugin_a_dir="$(mktemp -d "$scenario_tmp/plugin-a.XXXXXX")"
plugin_a_install_path_file="$PLUGIN_A_INSTALL_PATH_FILE"
plugin_a_source_path_file="$PLUGIN_A_SOURCE_PATH_FILE"
write_journey_plugin "$plugin_a_dir" journey-plugin-a 0.0.1 journey.a "Journey Plugin A" journey-a "journey-plugin-a:pong"
openclaw plugins install "$plugin_a_dir" >"$PLUGIN_A_INSTALL_LOG" 2>&1
node scripts/e2e/lib/release-user-journey/assertions.mjs \
  remember-plugin-install-path \
  journey-plugin-a \
  "$plugin_a_install_path_file" \
  "$plugin_a_source_path_file" \
  "$plugin_a_dir"
openclaw journey-a ping >"$PLUGIN_A_CLI_LOG" 2>&1
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-file-contains "$PLUGIN_A_CLI_LOG" "journey-plugin-a:pong"

echo "Uninstalling first external plugin..."
openclaw plugins uninstall journey-plugin-a --force >"$PLUGIN_A_UNINSTALL_LOG" 2>&1
node scripts/e2e/lib/release-user-journey/assertions.mjs \
  assert-plugin-uninstalled \
  journey-plugin-a \
  "$plugin_a_install_path_file" \
  "$plugin_a_source_path_file"

echo "Installing replacement external plugin..."
plugin_b_dir="$(mktemp -d "$scenario_tmp/plugin-b.XXXXXX")"
write_journey_plugin "$plugin_b_dir" journey-plugin-b 0.0.1 journey.b "Journey Plugin B" journey-b "journey-plugin-b:pong"
openclaw plugins install "$plugin_b_dir" >"$PLUGIN_B_INSTALL_LOG" 2>&1
openclaw journey-b ping >"$PLUGIN_B_CLI_LOG" 2>&1
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-file-contains "$PLUGIN_B_CLI_LOG" "journey-plugin-b:pong"

echo "Configuring ClickClack..."
node scripts/e2e/lib/release-user-journey/assertions.mjs configure-clickclack "http://127.0.0.1:$CLICKCLACK_PORT"
openclaw channels status --json >"$STATUS_JSON" 2>"$STATUS_ERR"
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-channel-status clickclack "$STATUS_JSON"

echo "Sending ClickClack outbound message..."
openclaw message send \
  --channel clickclack \
  --target channel:general \
  --message "release journey outbound" \
  --json >"$CLICKCLACK_OUTBOUND_JSON" 2>"$CLICKCLACK_OUTBOUND_ERR"
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-clickclack-state outbound "$CLICKCLACK_STATE" "release journey outbound"

echo "Starting Gateway for ClickClack inbound..."
start_gateway "$GATEWAY_1_LOG"
node scripts/e2e/lib/release-user-journey/assertions.mjs wait-clickclack-socket "http://127.0.0.1:$CLICKCLACK_PORT" 45
node scripts/e2e/lib/release-user-journey/assertions.mjs post-clickclack-inbound "http://127.0.0.1:$CLICKCLACK_PORT" "Return marker $SUCCESS_MARKER"
node scripts/e2e/lib/release-user-journey/assertions.mjs wait-clickclack-reply "$CLICKCLACK_STATE" "$SUCCESS_MARKER" 45

echo "Restarting Gateway and checking state survival..."
stop_gateway
start_gateway "$GATEWAY_2_LOG"
openclaw plugins inspect journey-plugin-b --runtime --json >"$PLUGIN_B_AFTER_RESTART_JSON" 2>&1
openclaw channels status --json >"$STATUS_AFTER_RESTART_JSON" 2>"$STATUS_AFTER_RESTART_ERR"
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-channel-status clickclack "$STATUS_AFTER_RESTART_JSON"
node scripts/e2e/lib/release-user-journey/assertions.mjs assert-file-contains "$PLUGIN_B_AFTER_RESTART_JSON" "journey-plugin-b"
stop_gateway

echo "Running doctor at end of release journey..."
openclaw doctor --repair --non-interactive >"$DOCTOR_LOG" 2>&1

echo "Release user journey scenario passed."
