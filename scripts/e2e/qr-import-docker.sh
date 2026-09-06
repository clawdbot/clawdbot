#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_ROOT="${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$ROOT_DIR}"
source "$ROOT_DIR/scripts/lib/docker-build.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-container.sh"
IMAGE_NAME="${OPENCLAW_QR_SMOKE_IMAGE:-openclaw-qr-smoke}"
DOCKER_BUILD_ARGS=()

if [[ "${OPENCLAW_QR_SMOKE_FORCE_INSTALL:-0}" == "1" ]]; then
  INSTALL_CACHE_BUSTER="${GITHUB_SHA:-manual}-${GITHUB_RUN_ID:-$(date +%s)}-${GITHUB_RUN_ATTEMPT:-0}"
  DOCKER_BUILD_ARGS+=(
    --build-arg
    "OPENCLAW_QR_INSTALL_CACHE_BUSTER=${INSTALL_CACHE_BUSTER}"
  )
fi

echo "Building Docker image..."
# Bash 3 treats an empty array as unset under nounset.
docker_build_run qr-import-build \
  ${DOCKER_BUILD_ARGS[@]+"${DOCKER_BUILD_ARGS[@]}"} \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/scripts/e2e/Dockerfile.qr-import" \
  "$SOURCE_ROOT"

echo "Running qrcode import smoke..."
run_logged qr-import-run docker_e2e_docker_run_cmd run --rm -t "$IMAGE_NAME" node -e "import('qrcode').then(async (m)=>{const q=m.default??m;process.stdout.write(await q.toString('qr-smoke',{small:true,type:'terminal'}))})"
