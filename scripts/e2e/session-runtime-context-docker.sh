#!/usr/bin/env bash
# Verifies hidden runtime context transcript persistence in Docker using the
# package-installed functional E2E image.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-session-runtime-context-e2e" OPENCLAW_SESSION_RUNTIME_CONTEXT_E2E_IMAGE)"
CONTAINER_NAME="openclaw-session-runtime-context-e2e-$$"
RUN_LOG="$(mktemp -t openclaw-session-runtime-context-log.XXXXXX)"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$RUN_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" session-runtime-context
docker_e2e_harness_mount_args

echo "Running session runtime context Docker E2E..."
# Harness files are mounted read-only; the app under test comes from /app/dist.
set +e
docker run --rm \
  --name "$CONTAINER_NAME" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  "${DOCKER_E2E_HARNESS_ARGS[@]}" \
  "$IMAGE_NAME" \
  bash -lc 'set -euo pipefail; tsx scripts/e2e/session-runtime-context-docker-client.ts' \
  >"$RUN_LOG" 2>&1
status=$?
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker session runtime context smoke failed"
  cat "$RUN_LOG"
  exit "$status"
fi

echo "OK"
