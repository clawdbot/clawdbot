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
TLS_DIR="$scenario_tmp/tls"
TLS_CA_CERT="$TLS_DIR/ca.crt"
TLS_CA_KEY="$TLS_DIR/ca.key"
TLS_SERVER_CERT="$TLS_DIR/server.crt"
TLS_SERVER_CSR="$TLS_DIR/server.csr"
TLS_SERVER_EXT="$TLS_DIR/server.ext"
TLS_SERVER_KEY="$TLS_DIR/server.key"
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
      openclaw_e2e_print_log "$file" >&2
    fi
  done
}
trap 'status=$?; dump_debug_logs "$status"; exit "$status"' ERR

entry="$(openclaw_e2e_resolve_entrypoint)"
mkdir -p "$OPENCLAW_STATE_DIR" "$TLS_DIR"

node scripts/e2e/lib/openai-web-search-minimal/assertions.mjs assert-patch-behavior

node scripts/e2e/lib/fixture.mjs openai-web-search-minimal-config

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 \
  -subj "/CN=OpenClaw E2E CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$TLS_CA_KEY" \
  -out "$TLS_CA_CERT" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -sha256 \
  -subj "/CN=api.openai.com" \
  -keyout "$TLS_SERVER_KEY" \
  -out "$TLS_SERVER_CSR" >/dev/null 2>&1
cat >"$TLS_SERVER_EXT" <<'EOF'
basicConstraints=critical,CA:FALSE
subjectAltName=DNS:api.openai.com
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
EOF
openssl x509 -req \
  -in "$TLS_SERVER_CSR" \
  -CA "$TLS_CA_CERT" \
  -CAkey "$TLS_CA_KEY" \
  -CAcreateserial \
  -days 1 \
  -sha256 \
  -extfile "$TLS_SERVER_EXT" \
  -out "$TLS_SERVER_CERT" >/dev/null 2>&1
export NODE_EXTRA_CA_CERTS="$TLS_CA_CERT"

MOCK_PORT="$MOCK_PORT" \
  MOCK_REQUEST_LOG="$MOCK_REQUEST_LOG" \
  MOCK_TLS_CERT="$TLS_SERVER_CERT" \
  MOCK_TLS_KEY="$TLS_SERVER_KEY" \
  SUCCESS_MARKER="$SUCCESS_MARKER" \
  RAW_SCHEMA_ERROR="$RAW_SCHEMA_ERROR" \
  node scripts/e2e/lib/openai-web-search-minimal/mock-server.mjs >"$MOCK_LOG" 2>&1 &
mock_pid="$!"

openclaw_e2e_wait_mock_openai "$MOCK_PORT" 80 400 "https://api.openai.com:$MOCK_PORT"

gateway_pid="$(openclaw_e2e_start_gateway "$entry" "$PORT" "$GATEWAY_LOG")"
openclaw_e2e_wait_gateway_ready "$gateway_pid" "$GATEWAY_LOG" 360 "$PORT"
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
