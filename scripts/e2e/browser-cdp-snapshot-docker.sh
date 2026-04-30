#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

BASE_IMAGE="$(docker_e2e_resolve_image "openclaw-browser-cdp-base-e2e" OPENCLAW_BROWSER_CDP_BASE_E2E_IMAGE)"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-browser-cdp-snapshot-e2e" OPENCLAW_BROWSER_CDP_SNAPSHOT_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_BROWSER_CDP_SNAPSHOT_E2E_SKIP_BUILD:-0}"
PORT="18789"
CDP_PORT="19222"
FIXTURE_PORT="18080"
TOKEN="browser-cdp-e2e-token"
CONTAINER_NAME="openclaw-browser-cdp-e2e-$$"
DOCKER_COMMAND_TIMEOUT="${OPENCLAW_BROWSER_CDP_SNAPSHOT_DOCKER_COMMAND_TIMEOUT:-900s}"

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

if [ "${OPENCLAW_SKIP_DOCKER_BUILD:-0}" = "1" ] || [ "$SKIP_BUILD" = "1" ]; then
  echo "Reusing Docker image: $IMAGE_NAME"
  docker_e2e_docker_cmd image inspect "$IMAGE_NAME" >/dev/null
else
  docker_e2e_build_or_reuse "$BASE_IMAGE" browser-cdp-base "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "" "0"
  build_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-browser-cdp-build.XXXXXX")"
  trap 'cleanup; rm -rf "$build_dir"' EXIT
  cat >"$build_dir/Dockerfile" <<EOF
FROM $BASE_IMAGE
USER root
RUN apt-get update \\
 && apt-get install -y --no-install-recommends chromium fonts-liberation procps \\
 && rm -rf /var/lib/apt/lists/*
USER appuser
EOF
  echo "Building Docker image: $IMAGE_NAME"
  docker_build_run browser-cdp-snapshot-build -t "$IMAGE_NAME" -f "$build_dir/Dockerfile" "$build_dir"
fi
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 browser-cdp-snapshot empty)"

echo "Starting browser CDP snapshot container..."
docker_e2e_harness_mount_args
docker_e2e_docker_cmd run -d \
  "${DOCKER_E2E_HARNESS_ARGS[@]}" \
  --name "$CONTAINER_NAME" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
  -e OPENCLAW_DISABLE_BONJOUR=1 \
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
mkdir -p /tmp/openclaw-browser-cdp/chrome
find dist -maxdepth 1 -type f -name 'pw-ai-*.js' ! -name 'pw-ai-state-*' -exec mv {} /tmp/openclaw-browser-cdp/ \;
PORT=$PORT CDP_PORT=$CDP_PORT node scripts/e2e/lib/fixture.mjs browser-cdp
chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \\
  --remote-debugging-address=127.0.0.1 \\
  --remote-debugging-port=$CDP_PORT \\
  --user-data-dir=/tmp/openclaw-browser-cdp/chrome \\
  about:blank >/tmp/browser-cdp-chromium.log 2>&1 &
FIXTURE_PORT=$FIXTURE_PORT node scripts/e2e/lib/browser-cdp-snapshot/fixture-server.mjs >/tmp/browser-cdp-fixture.log 2>&1 &
openclaw_e2e_exec_gateway \"\$entry\" $PORT loopback /tmp/browser-cdp-gateway.log" >/dev/null

echo "Waiting for Chromium and Gateway..."
if ! docker_e2e_wait_container_bash "$CONTAINER_NAME" 180 0.5 "
    source scripts/lib/openclaw-e2e-instance.sh
    openclaw_e2e_probe_http_status http://127.0.0.1:$CDP_PORT/json/version
    openclaw_e2e_probe_tcp 127.0.0.1 $PORT
"; then
  echo "Browser CDP snapshot container failed to become ready"
  docker_e2e_tail_container_file_if_running "$CONTAINER_NAME" "/tmp/browser-cdp-chromium.log /tmp/browser-cdp-gateway.log /tmp/browser-cdp-fixture.log" 120
  exit 1
fi

echo "Running browser CDP snapshot smoke..."
docker_e2e_docker_cmd exec "$CONTAINER_NAME" bash -lc "
set -euo pipefail
source /tmp/openclaw-test-state-env
source scripts/lib/openclaw-e2e-instance.sh
entry=\"\$(openclaw_e2e_resolve_entrypoint)\"
base_args=(--url ws://127.0.0.1:$PORT --token '$TOKEN')
node \"\$entry\" browser \"\${base_args[@]}\" --browser-profile docker-cdp doctor --deep >/tmp/browser-cdp-doctor.txt
grep -q 'OK live-snapshot' /tmp/browser-cdp-doctor.txt
node \"\$entry\" browser \"\${base_args[@]}\" --browser-profile docker-cdp open http://127.0.0.1:$FIXTURE_PORT/ >/tmp/browser-cdp-open.txt
node \"\$entry\" browser \"\${base_args[@]}\" --browser-profile docker-cdp snapshot --interactive --urls --out /tmp/browser-cdp-snapshot.txt >/tmp/browser-cdp-snapshot.out
node scripts/e2e/lib/browser-cdp-snapshot/assert-snapshot.mjs /tmp/browser-cdp-snapshot.txt
"

echo "Browser CDP snapshot Docker E2E passed."
