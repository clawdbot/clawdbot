#!/usr/bin/env bash
# Runs a deterministic packaged Gateway/code-mode/MCP smoke using the Docker
# functional image and the local mock OpenAI Responses server.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-mcp-code-mode-gateway-e2e" OPENCLAW_IMAGE)"
PORT="${OPENCLAW_MCP_CODE_MODE_GATEWAY_PORT:-18789}"
MOCK_PORT="${OPENCLAW_MCP_CODE_MODE_MOCK_PORT:-44082}"
TOKEN="mcp-code-mode-e2e-$(date +%s)-$$"
CONTAINER_NAME="openclaw-mcp-code-mode-e2e-$$"
CLIENT_LOG="$(mktemp -t openclaw-mcp-code-mode-client-log.XXXXXX)"

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$CLIENT_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" mcp-code-mode-gateway
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 mcp-code-mode-gateway empty)"

echo "Running in-container deterministic Gateway code-mode MCP API-file smoke..."
set +e
docker_e2e_run_with_harness \
  --name "$CONTAINER_NAME" \
  -e "OPENCLAW_GATEWAY_TOKEN=$TOKEN" \
  -e "OPENCLAW_SKIP_CHANNELS=1" \
  -e "OPENCLAW_SKIP_GMAIL_WATCHER=1" \
  -e "OPENCLAW_SKIP_CRON=1" \
  -e "OPENCLAW_SKIP_CANVAS_HOST=1" \
  -e "OPENCLAW_SKIP_ACPX_RUNTIME=1" \
  -e "OPENCLAW_SKIP_ACPX_RUNTIME_PROBE=1" \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  -e "GW_URL=http://127.0.0.1:$PORT" \
  -e "GW_TOKEN=$TOKEN" \
  -e "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1" \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail
    source scripts/lib/openclaw-e2e-instance.sh
    openclaw_e2e_eval_test_state_from_b64 \"\${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}\"
    entry=\"\$(openclaw_e2e_resolve_entrypoint)\"
    export OPENCLAW_DOCKER_OPENAI_BASE_URL=\"http://127.0.0.1:$MOCK_PORT/v1\"
    mock_pid=\"\$(openclaw_e2e_start_mock_openai \"$MOCK_PORT\" /tmp/mcp-code-mode-mock-openai.log)\"
    gateway_pid=
    cleanup_inner() {
      openclaw_e2e_stop_process \"\${gateway_pid:-}\"
      openclaw_e2e_stop_process \"\${mock_pid:-}\"
    }
    dump_logs_on_error() {
      status=\$?
      if [ \"\$status\" -ne 0 ]; then
        openclaw_e2e_dump_logs \
          /tmp/mcp-code-mode-gateway.log \
          /tmp/mcp-code-mode-seed.log \
          /tmp/mcp-code-mode-mock-openai.log
      fi
      cleanup_inner
      exit \"\$status\"
    }
    trap cleanup_inner EXIT
    trap dump_logs_on_error ERR
    openclaw_e2e_wait_mock_openai \"$MOCK_PORT\"
    tsx scripts/e2e/mcp-code-mode-gateway-seed.ts >/tmp/mcp-code-mode-seed.log
    gateway_pid=\"\$(openclaw_e2e_start_gateway \"\$entry\" $PORT /tmp/mcp-code-mode-gateway.log)\"
    openclaw_e2e_wait_gateway_ready \"\$gateway_pid\" /tmp/mcp-code-mode-gateway.log 480
    tsx scripts/e2e/mcp-code-mode-gateway-client.ts
  " >"$CLIENT_LOG" 2>&1
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker MCP code-mode API-file smoke failed"
  cat "$CLIENT_LOG"
  exit "$status"
fi

cat "$CLIENT_LOG"
echo "OK"
