#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-pi-bundle-mcp-tools-e2e" OPENCLAW_IMAGE)"
CONTAINER_NAME="openclaw-pi-bundle-mcp-tools-e2e-$$"
RUN_LOG="$(mktemp -t openclaw-pi-bundle-mcp-tools-log.XXXXXX)"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$RUN_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" pi-bundle-mcp-tools

echo "Running in-container Pi bundle MCP tool availability smoke..."
set +e
docker run --rm \
  --name "$CONTAINER_NAME" \
  -e "OPENCLAW_STATE_DIR=/tmp/openclaw-state" \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail
    node --import tsx scripts/e2e/pi-bundle-mcp-tools-docker-client.ts
  " >"$RUN_LOG" 2>&1
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker Pi bundle MCP tool availability smoke failed"
  cat "$RUN_LOG"
  exit "$status"
fi

cat "$RUN_LOG"
echo "OK"
