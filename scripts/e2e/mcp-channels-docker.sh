#!/usr/bin/env bash
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

echo "Running in-container gateway + MCP smoke..."
set +e
docker run --rm \
  --name "$CONTAINER_NAME" \
  -e "OPENCLAW_GATEWAY_TOKEN=$TOKEN" \
  -e "OPENCLAW_SKIP_CHANNELS=1" \
  -e "OPENCLAW_SKIP_GMAIL_WATCHER=1" \
  -e "OPENCLAW_SKIP_CRON=1" \
  -e "OPENCLAW_SKIP_CANVAS_HOST=1" \
  -e "OPENCLAW_STATE_DIR=/tmp/openclaw-state" \
  -e "OPENCLAW_CONFIG_PATH=/tmp/openclaw-state/openclaw.json" \
  -e "GW_URL=ws://127.0.0.1:$PORT" \
  -e "GW_TOKEN=$TOKEN" \
  -e "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1" \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail
    entry=dist/index.mjs
    [ -f \"\$entry\" ] || entry=dist/index.js
    node --import tsx scripts/e2e/mcp-channels-seed.ts >/tmp/mcp-channels-seed.log
    node \"\$entry\" gateway --port $PORT --bind loopback --allow-unconfigured >/tmp/mcp-channels-gateway.log 2>&1 &
    gateway_pid=\$!
    cleanup_inner() {
      kill \"\$gateway_pid\" >/dev/null 2>&1 || true
      wait \"\$gateway_pid\" >/dev/null 2>&1 || true
    }
    dump_gateway_log_on_error() {
      status=\$?
      if [ \"\$status\" -ne 0 ]; then
        tail -n 80 /tmp/mcp-channels-gateway.log 2>/dev/null || true
      fi
      cleanup_inner
      exit \"\$status\"
    }
    trap cleanup_inner EXIT
    trap dump_gateway_log_on_error ERR
    gateway_ready=0
    for _ in \$(seq 1 160); do
      if grep -q '\[gateway\] ready' /tmp/mcp-channels-gateway.log 2>/dev/null; then
        gateway_ready=1
        break
      fi
      sleep 0.25
    done
    if [ \"\$gateway_ready\" -ne 1 ]; then
      echo \"Gateway did not become ready\"
      tail -n 120 /tmp/mcp-channels-gateway.log 2>/dev/null || true
      exit 1
    fi
    node --import tsx scripts/e2e/mcp-channels-docker-client.ts
  " >"$CLIENT_LOG" 2>&1
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker MCP smoke failed"
  cat "$CLIENT_LOG"
  exit "$status"
fi

echo "OK"
