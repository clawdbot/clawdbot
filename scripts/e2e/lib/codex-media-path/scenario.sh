#!/usr/bin/env bash
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
export OPENCLAW_SKIP_CHANNELS=1
export OPENCLAW_SKIP_GMAIL_WATCHER=1
export OPENCLAW_SKIP_CRON=1
export OPENCLAW_SKIP_CANVAS_HOST=1
export OPENCLAW_SKIP_BROWSER_CONTROL_SERVER=1
export OPENCLAW_SKIP_ACPX_RUNTIME=1
export OPENCLAW_SKIP_ACPX_RUNTIME_PROBE=1
export OPENCLAW_AGENT_HARNESS_FALLBACK=none
export OPENCLAW_CODEX_MEDIA_PATH_APP_SERVER_LOG="/tmp/openclaw-codex-media-path-app-server.jsonl"

PORT="${PORT:?missing PORT}"
TOKEN="${OPENCLAW_GATEWAY_TOKEN:?missing OPENCLAW_GATEWAY_TOKEN}"
PLUGIN_SPEC="${OPENCLAW_CODEX_MEDIA_PATH_PLUGIN_SPEC:?missing OPENCLAW_CODEX_MEDIA_PATH_PLUGIN_SPEC}"
GATEWAY_LOG="/tmp/openclaw-codex-media-path-gateway.log"
CLIENT_LOG="/tmp/openclaw-codex-media-path-client.log"
PLUGIN_INSTALL_LOG="/tmp/openclaw-codex-media-path-plugin-install.log"
PLUGIN_INSPECT_LOG="/tmp/openclaw-codex-media-path-plugin-inspect.json"
gateway_pid=""

cleanup() {
  openclaw_e2e_stop_process "$gateway_pid"
}
trap cleanup EXIT

dump_debug_logs() {
  local status="$1"
  echo "Codex media-path Docker E2E failed with exit code $status" >&2
  openclaw_e2e_dump_logs "$PLUGIN_INSTALL_LOG" "$PLUGIN_INSPECT_LOG" "$GATEWAY_LOG" "$CLIENT_LOG" "$OPENCLAW_CODEX_MEDIA_PATH_APP_SERVER_LOG"
}
trap 'status=$?; dump_debug_logs "$status"; exit "$status"' ERR

entry="$(openclaw_e2e_resolve_entrypoint)"
mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_TEST_WORKSPACE_DIR"
rm -f "$OPENCLAW_CODEX_MEDIA_PATH_APP_SERVER_LOG"

openclaw_e2e_enable_openclaw_cli_timeout

echo "Installing Codex plugin: $PLUGIN_SPEC"
openclaw plugins install "$PLUGIN_SPEC" --force >"$PLUGIN_INSTALL_LOG" 2>&1
openclaw plugins inspect codex --runtime --json >"$PLUGIN_INSPECT_LOG"

node scripts/e2e/lib/codex-media-path/write-config.mjs

gateway_pid="$(openclaw_e2e_start_gateway "$entry" "$PORT" "$GATEWAY_LOG")"
openclaw_e2e_wait_gateway_ready "$gateway_pid" "$GATEWAY_LOG" 480 "$PORT"

PORT="$PORT" OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
  tsx scripts/e2e/lib/codex-media-path/client.mjs >"$CLIENT_LOG" 2>&1

cat "$CLIENT_LOG"
echo "Codex media-path Docker E2E passed"
