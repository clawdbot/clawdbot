#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="${OPENCLAW_LIVE_DOCKER_REPO_ROOT:-$SCRIPT_ROOT_DIR}"
ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"
source "$SCRIPT_ROOT_DIR/scripts/lib/docker-build.sh"
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
  if docker image inspect "$LIVE_IMAGE_NAME" >/dev/null 2>&1; then
    exit 0
  fi
  echo "==> Live-test image not found locally; pulling: $LIVE_IMAGE_NAME"
  if docker pull "$LIVE_IMAGE_NAME"; then
    exit 0
  fi
  if ! docker_build_on_missing_enabled; then
    echo "Live-test image not found: $LIVE_IMAGE_NAME" >&2
    echo "Build it first or unset OPENCLAW_SKIP_DOCKER_BUILD." >&2
    exit 1
  fi
  echo "==> Live-test image not available; building because OPENCLAW_DOCKER_BUILD_ON_MISSING/OPENCLAW_TESTBOX allows fallback."
fi

echo "==> Build live-test image: $LIVE_IMAGE_NAME (target=build)"
echo "==> Bundled plugins: ${DOCKER_BUILD_EXTENSIONS}"
docker_build_run live-build "${DOCKER_BUILD_ARGS[@]}" --target build -t "$LIVE_IMAGE_NAME" -f "$ROOT_DIR/Dockerfile" "$ROOT_DIR"
