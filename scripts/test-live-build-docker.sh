#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"
IMAGE_NAME="${OPENCLAW_IMAGE:-openclaw:local}"
LIVE_IMAGE_NAME="${OPENCLAW_LIVE_IMAGE:-${IMAGE_NAME}-live}"
DOCKER_BUILD_EXTENSIONS="${OPENCLAW_DOCKER_BUILD_EXTENSIONS:-${OPENCLAW_EXTENSIONS:-}}"

case " ${DOCKER_BUILD_EXTENSIONS} " in
  *" matrix "*)
    ;;
  *)
    DOCKER_BUILD_EXTENSIONS="${DOCKER_BUILD_EXTENSIONS:+${DOCKER_BUILD_EXTENSIONS} }matrix"
    ;;
esac

DOCKER_BUILD_ARGS=()
if [[ -n "${DOCKER_BUILD_EXTENSIONS}" ]]; then
  DOCKER_BUILD_ARGS+=(--build-arg "OPENCLAW_EXTENSIONS=${DOCKER_BUILD_EXTENSIONS}")
fi

if [[ "${OPENCLAW_SKIP_DOCKER_BUILD:-}" == "1" ]]; then
  echo "==> Reuse live-test image: $LIVE_IMAGE_NAME"
  exit 0
fi

echo "==> Build live-test image: $LIVE_IMAGE_NAME (target=build)"
echo "==> Bundled plugin deps: ${DOCKER_BUILD_EXTENSIONS}"
run_logged live-build docker build "${DOCKER_BUILD_ARGS[@]}" --target build -t "$LIVE_IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"
