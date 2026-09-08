#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-build.sh"

IMAGE_NAME="${OPENCLAW_SANDBOX_IMAGE:-openclaw-sandbox:bookworm-slim}"

docker_build_exec -t "${IMAGE_NAME}" -f "$ROOT_DIR/scripts/docker/sandbox/Dockerfile" "$ROOT_DIR"
echo "Built ${IMAGE_NAME}"
