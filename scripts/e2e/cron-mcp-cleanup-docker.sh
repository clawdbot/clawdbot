#!/usr/bin/env bash
# Starts Gateway plus seeded cron/subagent MCP work in Docker, then verifies MCP
# child-process cleanup through a mounted test harness.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-cron-mcp-cleanup-e2e" OPENCLAW_IMAGE)"
PORT="18789"
TOKEN="cron-mcp-e2e-$(date +%s)-$$"
CONTAINER_NAME="openclaw-cron-mcp-e2e-$$"
CLIENT_LOG="$(mktemp -t openclaw-cron-mcp-client-log.XXXXXX)"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$CLIENT_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" cron-mcp-cleanup
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 cron-mcp-cleanup empty)"

echo "Running in-container cron/subagent MCP cleanup smoke..."
# Harness files are mounted read-only; the app under test comes from /app/dist.
set +e
docker_e2e_run_with_harness \
  --name "$CONTAINER_NAME" \
  -e "OPENCLAW_TEST_FAST=1" \
  -e "OPENCLAW_GATEWAY_TOKEN=$TOKEN" \
  -e "OPENCLAW_SKIP_CHANNELS=1" \
  -e "OPENCLAW_SKIP_GMAIL_WATCHER=1" \
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
    export MOCK_PORT=44081
    export SUCCESS_MARKER=OPENCLAW_CRON_MCP_CLEANUP_OK
    export MOCK_REQUEST_LOG=/tmp/openclaw-cron-mock-openai-requests.jsonl
    export OPENCLAW_DOCKER_OPENAI_BASE_URL=\"http://127.0.0.1:\$MOCK_PORT/v1\"
    mock_pid=\"\$(openclaw_e2e_start_mock_openai \"\$MOCK_PORT\" /tmp/cron-mcp-cleanup-mock-openai.log)\"
    gateway_pid=
    cleanup_inner() {
      openclaw_e2e_stop_process \"\${gateway_pid:-}\"
      openclaw_e2e_stop_process \"\${mock_pid:-}\"
    }
    dump_gateway_log_on_error() {
      status=\$?
      if [ \"\$status\" -ne 0 ]; then
        openclaw_e2e_dump_logs \
          /tmp/cron-mcp-cleanup-gateway.log \
          /tmp/cron-mcp-cleanup-seed.log \
          /tmp/cron-mcp-cleanup-mock-openai.log \
          \"\$MOCK_REQUEST_LOG\"
      fi
      cleanup_inner
      exit \"\$status\"
    }
    trap cleanup_inner EXIT
    trap dump_gateway_log_on_error ERR
    openclaw_e2e_wait_mock_openai \"\$MOCK_PORT\"
    tsx scripts/e2e/cron-mcp-cleanup-seed.ts >/tmp/cron-mcp-cleanup-seed.log
    gateway_pid=\"\$(openclaw_e2e_start_gateway \"\$entry\" $PORT /tmp/cron-mcp-cleanup-gateway.log)\"
    openclaw_e2e_wait_gateway_ready \"\$gateway_pid\" /tmp/cron-mcp-cleanup-gateway.log 300
    tsx scripts/e2e/cron-mcp-cleanup-docker-client.ts
  " >"$CLIENT_LOG" 2>&1
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker cron/subagent MCP cleanup smoke failed"
  cat "$CLIENT_LOG"
  exit "$status"
fi

echo "OK"
