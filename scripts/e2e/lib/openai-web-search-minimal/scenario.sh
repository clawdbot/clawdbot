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

PORT="${PORT:?missing PORT}"
MOCK_PORT="${MOCK_PORT:?missing MOCK_PORT}"
TOKEN="${OPENCLAW_GATEWAY_TOKEN:?missing OPENCLAW_GATEWAY_TOKEN}"
SUCCESS_MARKER="OPENCLAW_SCHEMA_E2E_OK"
RAW_SCHEMA_ERROR="400 The following tools cannot be used with reasoning.effort 'minimal': web_search."
scenario_tmp="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-openai-web-search-minimal.XXXXXX")"
MOCK_REQUEST_LOG="$scenario_tmp/requests.jsonl"
GATEWAY_LOG="$scenario_tmp/gateway.log"
MOCK_LOG="$scenario_tmp/mock.log"
CLIENT_SUCCESS_LOG="$scenario_tmp/client-success.log"
CLIENT_REJECT_LOG="$scenario_tmp/client-reject.log"
mock_pid=""
gateway_pid=""

cleanup() {
  openclaw_e2e_terminate_gateways "${gateway_pid:-}"
  openclaw_e2e_stop_process "${mock_pid:-}"
  rm -rf "$scenario_tmp"
}
trap cleanup EXIT

dump_debug_logs() {
  local status="$1"
  echo "OpenAI web_search minimal Docker E2E failed with exit code $status" >&2
  for file in \
    "$GATEWAY_LOG" \
    "$MOCK_LOG" \
    "$CLIENT_SUCCESS_LOG" \
    "$CLIENT_REJECT_LOG" \
    "$MOCK_REQUEST_LOG" \
    "$OPENCLAW_STATE_DIR/openclaw.json"; do
    if [ -f "$file" ]; then
      echo "--- $file ---" >&2
      sed -n '1,260p' "$file" >&2 || true
    fi
  done
}
trap 'status=$?; dump_debug_logs "$status"; exit "$status"' ERR

entry="$(openclaw_e2e_resolve_entrypoint)"
mkdir -p "$OPENCLAW_STATE_DIR"

node scripts/e2e/lib/openai-web-search-minimal/assertions.mjs assert-patch-behavior

node scripts/e2e/lib/fixture.mjs openai-web-search-minimal-config

MOCK_PORT="$MOCK_PORT" \
  MOCK_REQUEST_LOG="$MOCK_REQUEST_LOG" \
  SUCCESS_MARKER="$SUCCESS_MARKER" \
  RAW_SCHEMA_ERROR="$RAW_SCHEMA_ERROR" \
  node scripts/e2e/lib/openai-web-search-minimal/mock-server.mjs >"$MOCK_LOG" 2>&1 &
mock_pid="$!"

for _ in $(seq 1 80); do
  if node -e "fetch('http://127.0.0.1:${MOCK_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
node -e "fetch('http://127.0.0.1:${MOCK_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null

gateway_pid="$(openclaw_e2e_start_gateway "$entry" "$PORT" "$GATEWAY_LOG")"
openclaw_e2e_wait_gateway_ready "$gateway_pid" "$GATEWAY_LOG" 360
node "$entry" gateway health \
  --url "ws://127.0.0.1:$PORT" \
  --token "$TOKEN" \
  --timeout 120000 \
  --json >/dev/null

PORT="$PORT" OPENCLAW_GATEWAY_TOKEN="$TOKEN" node scripts/e2e/lib/openai-web-search-minimal/client.mjs success >"$CLIENT_SUCCESS_LOG" 2>&1

node scripts/e2e/lib/openai-web-search-minimal/assertions.mjs assert-success-request "$MOCK_REQUEST_LOG"

PORT="$PORT" OPENCLAW_GATEWAY_TOKEN="$TOKEN" node scripts/e2e/lib/openai-web-search-minimal/client.mjs reject >"$CLIENT_REJECT_LOG" 2>&1

for _ in $(seq 1 80); do
  if grep -Fq "$RAW_SCHEMA_ERROR" "$GATEWAY_LOG"; then
    break
  fi
  sleep 0.25
done
grep -F "$RAW_SCHEMA_ERROR" "$GATEWAY_LOG" >/dev/null

echo "OpenAI web_search minimal reasoning Docker E2E passed"
