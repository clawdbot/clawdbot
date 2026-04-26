#!/usr/bin/env bash
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

echo "Running session runtime context Docker E2E..."
set +e
docker run --rm \
  --name "$CONTAINER_NAME" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  "$IMAGE_NAME" \
  bash -lc 'set -euo pipefail; node --import tsx scripts/e2e/session-runtime-context-docker-client.ts' \
  >"$RUN_LOG" 2>&1
status=$?
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker session runtime context smoke failed"
  cat "$RUN_LOG"
  exit "$status"
fi

echo "OK"
