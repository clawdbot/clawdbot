#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-build.sh"
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
docker_build_run qr-import-build \
  "${DOCKER_BUILD_ARGS[@]}" \
  -t "$IMAGE_NAME" \
  -f "$ROOT_DIR/scripts/e2e/Dockerfile.qr-import" \
  "$ROOT_DIR"

echo "Running qrcode import smoke..."
run_logged qr-import-run docker run --rm -t "$IMAGE_NAME" node -e "import('qrcode').then(async (m)=>{const q=m.default??m;process.stdout.write(await q.toString('qr-smoke',{small:true,type:'terminal'}))})"
