#!/usr/bin/env bash
# Runs the Crestodian first-run Docker smoke against the package-installed
# functional E2E image, with only the test harness mounted from the checkout.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-crestodian-first-run-e2e" OPENCLAW_CRESTODIAN_FIRST_RUN_E2E_IMAGE)"
CONTAINER_NAME="openclaw-crestodian-first-run-e2e-$$"
RUN_LOG="$(mktemp -t openclaw-crestodian-first-run-log.XXXXXX)"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$RUN_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" crestodian-first-run
docker_e2e_harness_mount_args

echo "Running in-container Crestodian first-run smoke..."
# Harness files are mounted read-only; the app under test comes from /app/dist.
set +e
docker run --rm \
  --name "$CONTAINER_NAME" \
  -e "OPENCLAW_STATE_DIR=/tmp/openclaw-state" \
  -e "OPENCLAW_CONFIG_PATH=/tmp/openclaw-state/openclaw.json" \
  "${DOCKER_E2E_HARNESS_ARGS[@]}" \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail
    tsx scripts/e2e/crestodian-first-run-docker-client.ts
  " >"$RUN_LOG" 2>&1
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker Crestodian first-run smoke failed"
  cat "$RUN_LOG"
  exit "$status"
fi

cat "$RUN_LOG"
echo "OK"
