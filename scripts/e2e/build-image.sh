#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-docker-e2e:local")"
DOCKER_TARGET="${OPENCLAW_DOCKER_E2E_TARGET:-build}"

docker_e2e_build_or_reuse "$IMAGE_NAME" docker-e2e "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "$DOCKER_TARGET"
