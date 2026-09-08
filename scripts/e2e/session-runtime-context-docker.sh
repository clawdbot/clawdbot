#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
# Verifies hidden runtime context transcript persistence in Docker using the
# package-installed functional E2E image.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/frozen-target-compat.sh"
openclaw_resolve_frozen_core_harness_capabilities "${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$ROOT_DIR}"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-session-runtime-context-e2e" OPENCLAW_SESSION_RUNTIME_CONTEXT_E2E_IMAGE)"
CONTAINER_NAME="openclaw-session-runtime-context-e2e-$$"
RUN_LOG="$(mktemp -t openclaw-session-runtime-context-log.XXXXXX)"

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$RUN_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" session-runtime-context

echo "Running session runtime context Docker E2E..."
# Harness files are mounted read-only; the app under test comes from /app/dist.
set +e
docker_e2e_run_with_harness \
  --name "$CONTAINER_NAME" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e "OPENCLAW_FROZEN_TARGET_RUNTIME_CONTEXT_INPUT_MODE=$OPENCLAW_FROZEN_TARGET_RUNTIME_CONTEXT_INPUT_MODE" \
  -e "OPENCLAW_FROZEN_TARGET_SESSION_REPAIR_MODE=$OPENCLAW_FROZEN_TARGET_SESSION_REPAIR_MODE" \
  "$IMAGE_NAME" \
  bash -lc 'set -euo pipefail; tsx scripts/e2e/session-runtime-context-docker-client.ts' \
  >"$RUN_LOG" 2>&1
status=$?
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker session runtime context smoke failed"
  docker_e2e_print_log "$RUN_LOG"
  exit "$status"
fi

echo "OK"
