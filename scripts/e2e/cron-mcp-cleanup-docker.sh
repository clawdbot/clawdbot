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
docker_e2e_harness_mount_args

echo "Running in-container cron/subagent MCP cleanup smoke..."
# Harness files are mounted read-only; the app under test comes from /app/dist.
set +e
docker run --rm \
  --name "$CONTAINER_NAME" \
  -e "OPENCLAW_TEST_FAST=1" \
  -e "OPENCLAW_GATEWAY_TOKEN=$TOKEN" \
  -e "OPENCLAW_SKIP_CHANNELS=1" \
  -e "OPENCLAW_SKIP_GMAIL_WATCHER=1" \
  -e "OPENCLAW_SKIP_CANVAS_HOST=1" \
  -e "OPENCLAW_SKIP_ACPX_RUNTIME=1" \
  -e "OPENCLAW_SKIP_ACPX_RUNTIME_PROBE=1" \
  -e "OPENCLAW_STATE_DIR=/tmp/openclaw-state" \
  -e "OPENCLAW_CONFIG_PATH=/tmp/openclaw-state/openclaw.json" \
  -e "GW_URL=ws://127.0.0.1:$PORT" \
  -e "GW_TOKEN=$TOKEN" \
  -e "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1" \
  "${DOCKER_E2E_HARNESS_ARGS[@]}" \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail
    entry=dist/index.mjs
    [ -f \"\$entry\" ] || entry=dist/index.js
    export MOCK_PORT=44081
    export SUCCESS_MARKER=OPENCLAW_CRON_MCP_CLEANUP_OK
    export MOCK_REQUEST_LOG=/tmp/openclaw-cron-mock-openai-requests.jsonl
    export OPENCLAW_DOCKER_OPENAI_BASE_URL=\"http://127.0.0.1:\$MOCK_PORT/v1\"
    node scripts/e2e/mock-openai-server.mjs >/tmp/cron-mcp-cleanup-mock-openai.log 2>&1 &
    mock_pid=\$!
    tsx scripts/e2e/cron-mcp-cleanup-seed.ts >/tmp/cron-mcp-cleanup-seed.log
    node \"\$entry\" gateway --port $PORT --bind loopback --allow-unconfigured >/tmp/cron-mcp-cleanup-gateway.log 2>&1 &
    gateway_pid=\$!
    stop_process() {
      pid=\"\$1\"
      kill \"\$pid\" >/dev/null 2>&1 || true
      for _ in \$(seq 1 40); do
        if ! kill -0 \"\$pid\" >/dev/null 2>&1; then
          wait \"\$pid\" >/dev/null 2>&1 || true
          return
        fi
        sleep 0.25
      done
      kill -9 \"\$pid\" >/dev/null 2>&1 || true
      wait \"\$pid\" >/dev/null 2>&1 || true
    }
    cleanup_inner() {
      stop_process \"\$mock_pid\"
      stop_process \"\$gateway_pid\"
    }
    dump_gateway_log_on_error() {
      status=\$?
      if [ \"\$status\" -ne 0 ]; then
        tail -n 80 /tmp/cron-mcp-cleanup-gateway.log 2>/dev/null || true
        cat /tmp/cron-mcp-cleanup-seed.log 2>/dev/null || true
        cat /tmp/cron-mcp-cleanup-mock-openai.log 2>/dev/null || true
        cat \"\$MOCK_REQUEST_LOG\" 2>/dev/null || true
      fi
      cleanup_inner
      exit \"\$status\"
    }
    trap cleanup_inner EXIT
    trap dump_gateway_log_on_error ERR
    for _ in \$(seq 1 80); do
      if node -e \"fetch('http://127.0.0.1:' + process.env.MOCK_PORT + '/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"; then
        break
      fi
      sleep 0.1
    done
    node -e \"fetch('http://127.0.0.1:' + process.env.MOCK_PORT + '/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\"
    gateway_ready=0
    for _ in \$(seq 1 300); do
      if grep -q '\[gateway\] ready' /tmp/cron-mcp-cleanup-gateway.log 2>/dev/null; then
        gateway_ready=1
        break
      fi
      sleep 0.25
    done
    if [ \"\$gateway_ready\" -ne 1 ]; then
      echo \"Gateway did not become ready\"
      tail -n 120 /tmp/cron-mcp-cleanup-gateway.log 2>/dev/null || true
      exit 1
    fi
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
