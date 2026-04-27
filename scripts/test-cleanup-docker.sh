#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-build.sh"
IMAGE_NAME="${OPENCLAW_CLEANUP_SMOKE_IMAGE:-openclaw-cleanup-smoke:local}"
PLATFORM="${OPENCLAW_CLEANUP_SMOKE_PLATFORM:-linux/amd64}"

echo "==> Build image: $IMAGE_NAME"
docker_build_run cleanup-build \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/scripts/docker/cleanup-smoke/Dockerfile" \
  "$ROOT_DIR"

echo "==> Run cleanup smoke test"
docker run --rm --platform "$PLATFORM" -t "$IMAGE_NAME"
