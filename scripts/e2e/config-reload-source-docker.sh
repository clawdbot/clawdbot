#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-config-reload-e2e" OPENCLAW_CONFIG_RELOAD_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_CONFIG_RELOAD_E2E_SKIP_BUILD:-0}"
PORT="18789"
TOKEN="reload-e2e-token"
CONTAINER_NAME="openclaw-config-reload-e2e-$$"

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" config-reload "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "" "$SKIP_BUILD"
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 config-reload empty)"

echo "Starting gateway container..."
docker_e2e_run_detached_with_harness \
  --name "$CONTAINER_NAME" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e GATEWAY_AUTH_TOKEN_REF="$TOKEN" \
  -e OPENCLAW_SKIP_CHANNELS=1 \
  -e OPENCLAW_SKIP_PROVIDERS=1 \
  -e OPENCLAW_SKIP_GMAIL_WATCHER=1 \
  -e OPENCLAW_SKIP_CRON=1 \
  -e OPENCLAW_SKIP_CANVAS_HOST=1 \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail
source scripts/lib/openclaw-e2e-instance.sh
openclaw_e2e_eval_test_state_from_b64 \"\${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}\"
openclaw_e2e_write_state_env
entry=\"\$(openclaw_e2e_resolve_entrypoint)\"
PORT=$PORT node scripts/e2e/lib/fixture.mjs config-reload
openclaw_e2e_exec_gateway \"\$entry\" $PORT loopback /tmp/config-reload-e2e.log" >/dev/null

echo "Waiting for gateway..."
if ! docker_e2e_wait_container_bash "$CONTAINER_NAME" 180 0.5 "source scripts/lib/openclaw-e2e-instance.sh; openclaw_e2e_probe_tcp 127.0.0.1 $PORT"; then
  echo "Gateway failed to start"
  docker_e2e_docker_cmd logs "$CONTAINER_NAME" 2>&1 | tail -n 120 || true
  docker_e2e_docker_cmd exec "$CONTAINER_NAME" bash -lc "tail -n 120 /tmp/config-reload-e2e.log" || true
  exit 1
fi

echo "Checking initial RPC status..."
docker_e2e_docker_cmd exec "$CONTAINER_NAME" bash -lc "
source /tmp/openclaw-test-state-env
source scripts/lib/openclaw-e2e-instance.sh
entry=\"\$(openclaw_e2e_resolve_entrypoint)\"
node \"\$entry\" gateway status --url ws://127.0.0.1:$PORT --token '$TOKEN' --require-rpc --timeout 30000 >/tmp/config-reload-status-before.log
"

echo "Mutating hot-reload gateway metadata..."
docker_e2e_docker_cmd exec "$CONTAINER_NAME" bash -lc "source /tmp/openclaw-test-state-env
node scripts/e2e/lib/config-reload/mutate-metadata.mjs"

sleep 2

if [ "$(docker_e2e_docker_cmd inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo false)" != "true" ]; then
  echo "Gateway container exited after config metadata write"
  docker_e2e_docker_cmd logs "$CONTAINER_NAME" 2>&1 | tail -n 120 || true
  exit 1
fi

echo "Checking post-write RPC status..."
docker_e2e_docker_cmd exec "$CONTAINER_NAME" bash -lc "
source /tmp/openclaw-test-state-env
source scripts/lib/openclaw-e2e-instance.sh
entry=\"\$(openclaw_e2e_resolve_entrypoint)\"
node \"\$entry\" gateway status --url ws://127.0.0.1:$PORT --token '$TOKEN' --require-rpc --timeout 30000 >/tmp/config-reload-status-after.log
"

echo "Checking reload log..."
docker_e2e_docker_cmd exec "$CONTAINER_NAME" bash -lc "node scripts/e2e/lib/config-reload/assert-log.mjs"

echo "Config reload Docker E2E passed."
