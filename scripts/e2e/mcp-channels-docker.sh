#!/usr/bin/env bash
# Runs a Docker Gateway plus MCP stdio bridge smoke with seeded conversations and
# raw Claude notification-frame assertions.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-mcp-channels-e2e" OPENCLAW_IMAGE)"
PORT="18789"
TOKEN="mcp-e2e-$(date +%s)-$$"
CONTAINER_NAME="openclaw-mcp-e2e-$$"
CLIENT_LOG="$(mktemp -t openclaw-mcp-client-log.XXXXXX)"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$CLIENT_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" mcp-channels
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 mcp-channels empty)"

echo "Running in-container gateway + MCP smoke..."
# Harness files are mounted read-only; the app under test comes from /app/dist.
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
  -e "GW_URL=ws://127.0.0.1:$PORT" \
  -e "GW_TOKEN=$TOKEN" \
  -e "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1" \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail
    source scripts/lib/openclaw-e2e-instance.sh
    openclaw_e2e_eval_test_state_from_b64 \"\${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}\"
    entry=\"\$(openclaw_e2e_resolve_entrypoint)\"
    mock_port=44081
    export OPENCLAW_DOCKER_OPENAI_BASE_URL=\"http://127.0.0.1:\$mock_port/v1\"
    mock_pid=\"\$(openclaw_e2e_start_mock_openai \"\$mock_port\" /tmp/mcp-channels-mock-openai.log)\"
    gateway_pid=
    cleanup_inner() {
      openclaw_e2e_stop_process \"\${gateway_pid:-}\"
      openclaw_e2e_stop_process \"\${mock_pid:-}\"
    }
    dump_gateway_log_on_error() {
      status=\$?
      if [ \"\$status\" -ne 0 ]; then
        openclaw_e2e_dump_logs \
          /tmp/mcp-channels-gateway.log \
          /tmp/mcp-channels-seed.log \
          /tmp/mcp-channels-mock-openai.log
      fi
      cleanup_inner
      exit \"\$status\"
    }
    trap cleanup_inner EXIT
    trap dump_gateway_log_on_error ERR
    openclaw_e2e_wait_mock_openai \"\$mock_port\"
    tsx scripts/e2e/mcp-channels-seed.ts >/tmp/mcp-channels-seed.log
    gateway_pid=\"\$(openclaw_e2e_start_gateway \"\$entry\" $PORT /tmp/mcp-channels-gateway.log)\"
    openclaw_e2e_wait_gateway_ready \"\$gateway_pid\" /tmp/mcp-channels-gateway.log 480
    tsx scripts/e2e/mcp-channels-docker-client.ts
  " >"$CLIENT_LOG" 2>&1
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker MCP smoke failed"
  cat "$CLIENT_LOG"
  exit "$status"
fi

echo "OK"
