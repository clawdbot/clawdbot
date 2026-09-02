#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-build.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"
IMAGE_NAME="${OPENCLAW_CLEANUP_SMOKE_IMAGE:-openclaw-cleanup-smoke:local}"
DOCKER_COMMAND_TIMEOUT="${DOCKER_COMMAND_TIMEOUT:-${OPENCLAW_CLEANUP_SMOKE_DOCKER_TIMEOUT:-600s}}"

resolve_default_cleanup_platform() {
  local host_arch
  if [[ -n "${OPENCLAW_CLEANUP_SMOKE_PLATFORM:-}" ]]; then
    printf "%s" "$OPENCLAW_CLEANUP_SMOKE_PLATFORM"
    return
  fi
  host_arch="$(uname -m)"
  if [[ "${CI:-}" == "true" || "${GITHUB_ACTIONS:-}" == "true" ]]; then
    case "$host_arch" in
      arm64 | aarch64)
        printf "linux/arm64"
        return
        ;;
    esac
    printf "linux/amd64"
    return
  fi
  case "$host_arch" in
    arm64 | aarch64)
      printf "linux/arm64"
      ;;
    *)
      printf "linux/amd64"
      ;;
  esac
}

PLATFORM="$(resolve_default_cleanup_platform)"

echo "==> Build image: $IMAGE_NAME"
docker_build_run cleanup-build \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/scripts/docker/cleanup-smoke/Dockerfile" \
  "$ROOT_DIR"

echo "==> Run cleanup smoke test"
docker_e2e_docker_run_cmd run --rm --platform "$PLATFORM" -t "$IMAGE_NAME"
