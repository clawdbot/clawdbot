#!/usr/bin/env bash
# Verifies commitments safety behavior in Docker using the package-installed
# functional E2E image.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-commitments-safety-e2e" OPENCLAW_COMMITMENTS_SAFETY_E2E_IMAGE)"
CONTAINER_NAME="openclaw-commitments-safety-e2e-$$"
RUN_LOG="$(mktemp -t openclaw-commitments-safety-log.XXXXXX)"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$RUN_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" commitments-safety

echo "Running commitments safety Docker E2E..."
set +e
docker_e2e_run_with_harness \
  --name "$CONTAINER_NAME" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  "$IMAGE_NAME" \
  bash -lc 'set -euo pipefail; tsx scripts/e2e/commitments-safety-docker-client.ts' \
  >"$RUN_LOG" 2>&1
status=$?
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker commitments safety smoke failed"
  cat "$RUN_LOG"
  exit "$status"
fi

echo "OK"
