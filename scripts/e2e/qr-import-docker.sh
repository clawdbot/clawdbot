#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="${CLAWDBOT_QR_SMOKE_IMAGE:-moltbot-qr-smoke}"

echo "Building Docker image..."
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/scripts/e2e/Dockerfile.qr-import" "$ROOT_DIR"

echo "Running qrcode-terminal import smoke..."
docker run --rm -t "$IMAGE_NAME" node -e "import('qrcode-terminal').then((m)=>m.default.generate('qr-smoke',{small:true}))"
