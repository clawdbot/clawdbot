#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-build.sh"

BASE_IMAGE="${BASE_IMAGE:-openclaw-sandbox:bookworm-slim}"
TARGET_IMAGE="${TARGET_IMAGE:-openclaw-sandbox-common:bookworm-slim}"
PACKAGES="${PACKAGES:-curl wget jq coreutils grep nodejs npm python3 git ca-certificates golang-go rustc cargo unzip pkg-config libasound2-dev build-essential file}"
INSTALL_PNPM="${INSTALL_PNPM:-1}"
INSTALL_BUN="${INSTALL_BUN:-1}"
BUN_INSTALL_DIR="${BUN_INSTALL_DIR:-/opt/bun}"
INSTALL_BREW="${INSTALL_BREW:-1}"
BREW_INSTALL_DIR="${BREW_INSTALL_DIR:-/home/linuxbrew/.linuxbrew}"
FINAL_USER="${FINAL_USER:-sandbox}"
OPENCLAW_DOCKER_BUILD_USE_BUILDX="${OPENCLAW_DOCKER_BUILD_USE_BUILDX:-0}"
OPENCLAW_DOCKER_BUILD_CACHE_FROM="${OPENCLAW_DOCKER_BUILD_CACHE_FROM:-}"
OPENCLAW_DOCKER_BUILD_CACHE_TO="${OPENCLAW_DOCKER_BUILD_CACHE_TO:-}"

if ! docker image inspect "${BASE_IMAGE}" >/dev/null 2>&1; then
  echo "Base image missing: ${BASE_IMAGE}"
  echo "Building base image via scripts/sandbox-setup.sh..."
  "$ROOT_DIR/scripts/sandbox-setup.sh"
fi

echo "Building ${TARGET_IMAGE} with: ${PACKAGES}"

docker_build_exec \
  -t "${TARGET_IMAGE}" \
  -f "$ROOT_DIR/Dockerfile.sandbox-common" \
  --build-arg BASE_IMAGE="${BASE_IMAGE}" \
  --build-arg PACKAGES="${PACKAGES}" \
  --build-arg INSTALL_PNPM="${INSTALL_PNPM}" \
  --build-arg INSTALL_BUN="${INSTALL_BUN}" \
  --build-arg BUN_INSTALL_DIR="${BUN_INSTALL_DIR}" \
  --build-arg INSTALL_BREW="${INSTALL_BREW}" \
  --build-arg BREW_INSTALL_DIR="${BREW_INSTALL_DIR}" \
  --build-arg FINAL_USER="${FINAL_USER}" \
  "$ROOT_DIR"

cat <<NOTE
Built ${TARGET_IMAGE}.
To use it, set agents.defaults.sandbox.docker.image to "${TARGET_IMAGE}" and restart.
If you want a clean re-create, remove old sandbox containers:
  docker rm -f \$(docker ps -aq --filter label=openclaw.sandbox=1)
NOTE
