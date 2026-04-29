#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-gateway-network-e2e" OPENCLAW_GATEWAY_NETWORK_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_GATEWAY_NETWORK_E2E_SKIP_BUILD:-0}"

PORT="18789"
TOKEN="e2e-$(date +%s)-$$"
NET_NAME="openclaw-net-e2e-$$"
GW_NAME="openclaw-gateway-e2e-$$"
DOCKER_COMMAND_TIMEOUT="${OPENCLAW_GATEWAY_NETWORK_DOCKER_COMMAND_TIMEOUT:-600s}"
CLIENT_TIMEOUT="${OPENCLAW_GATEWAY_NETWORK_CLIENT_TIMEOUT:-90s}"

cleanup() {
  docker_e2e_docker_cmd rm -f "$GW_NAME" >/dev/null 2>&1 || true
  docker_e2e_docker_cmd network rm "$NET_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" gateway-network "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "" "$SKIP_BUILD"

echo "Creating Docker network..."
docker_e2e_docker_cmd network create "$NET_NAME" >/dev/null

echo "Starting gateway container..."
docker_e2e_harness_mount_args
docker_e2e_docker_cmd run -d \
  "${DOCKER_E2E_HARNESS_ARGS[@]}" \
  --name "$GW_NAME" \
  --network "$NET_NAME" \
  -e "OPENCLAW_GATEWAY_TOKEN=$TOKEN" \
  -e "OPENCLAW_SKIP_CHANNELS=1" \
  -e "OPENCLAW_SKIP_GMAIL_WATCHER=1" \
  -e "OPENCLAW_SKIP_CRON=1" \
  -e "OPENCLAW_SKIP_CANVAS_HOST=1" \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail; source scripts/lib/openclaw-e2e-instance.sh; entry=\"\$(openclaw_e2e_resolve_entrypoint)\"; node \"\$entry\" config set gateway.controlUi.enabled false >/dev/null; openclaw_e2e_exec_gateway \"\$entry\" $PORT lan /tmp/gateway-net-e2e.log" >/dev/null

echo "Waiting for gateway to come up..."
if ! docker_e2e_wait_container_bash "$GW_NAME" 180 0.5 "source scripts/lib/openclaw-e2e-instance.sh; openclaw_e2e_probe_tcp 127.0.0.1 $PORT || grep -q \"listening on ws://\" /tmp/gateway-net-e2e.log 2>/dev/null"; then
  echo "Gateway failed to start"
  docker_e2e_tail_container_file_if_running "$GW_NAME" /tmp/gateway-net-e2e.log 120
  exit 1
fi

echo "Running client container (connect + health)..."
run_logged gateway-network-client timeout "$CLIENT_TIMEOUT" docker run --rm \
  "${DOCKER_E2E_HARNESS_ARGS[@]}" \
  --network "$NET_NAME" \
  -e "GW_URL=ws://$GW_NAME:$PORT" \
  -e "GW_TOKEN=$TOKEN" \
  "$IMAGE_NAME" \
  node scripts/e2e/lib/gateway-network/client.mjs

echo "OK"
