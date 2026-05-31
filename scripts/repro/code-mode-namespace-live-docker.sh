#!/usr/bin/env bash
set -euo pipefail

SCRIPT_ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROOT_DIR="${OPENCLAW_LIVE_DOCKER_REPO_ROOT:-$SCRIPT_ROOT_DIR}"
ROOT_DIR="$(cd "$ROOT_DIR" && pwd)"
TRUSTED_HARNESS_DIR="${OPENCLAW_LIVE_DOCKER_TRUSTED_HARNESS_DIR:-$SCRIPT_ROOT_DIR}"
TRUSTED_HARNESS_DIR="$(cd "$TRUSTED_HARNESS_DIR" && pwd)"
source "$TRUSTED_HARNESS_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-code-mode-namespace-live-e2e" OPENCLAW_CODE_MODE_NAMESPACE_LIVE_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_CODE_MODE_NAMESPACE_LIVE_E2E_SKIP_BUILD:-0}"
PROFILE_FILE="${OPENCLAW_CODE_MODE_NAMESPACE_LIVE_PROFILE_FILE:-${OPENCLAW_TESTBOX_PROFILE_FILE:-$HOME/.openclaw-testbox-live.profile}}"
run_log=""
if [ ! -f "$PROFILE_FILE" ] && [ -f "$HOME/.profile" ]; then
  PROFILE_FILE="$HOME/.profile"
fi

cleanup() {
  if [ -n "${run_log:-}" ]; then
    rm -f "$run_log"
  fi
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" code-mode-namespace-live "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "" "$SKIP_BUILD"

PROFILE_MOUNT=()
PROFILE_STATUS="none"
if [ -f "$PROFILE_FILE" ] && [ -r "$PROFILE_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$PROFILE_FILE"
  set +a
  PROFILE_MOUNT=(-v "$PROFILE_FILE":/home/appuser/.profile:ro)
  PROFILE_STATUS="$PROFILE_FILE"
fi

echo "Running code mode namespace live Docker E2E..."
echo "Profile file: $PROFILE_STATUS"
run_log="$(docker_e2e_run_log code-mode-namespace-live)"
if ! docker_e2e_run_with_harness \
  --user root \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENAI_API_KEY \
  -e OPENAI_BASE_URL \
  -e "OPENCLAW_CODE_MODE_LIVE_MODEL=${OPENCLAW_CODE_MODE_LIVE_MODEL:-gpt-5.4-mini}" \
  -e "OPENCLAW_CODE_MODE_LIVE_TASKS=${OPENCLAW_CODE_MODE_LIVE_TASKS:-3}" \
  -v "$ROOT_DIR":/src:ro \
  "${PROFILE_MOUNT[@]}" \
  "$IMAGE_NAME" \
  bash /src/scripts/repro/code-mode-namespace-live-scenario.sh >"$run_log" 2>&1; then
  docker_e2e_print_log "$run_log"
  exit 1
fi

docker_e2e_print_log "$run_log"
echo "Code mode namespace live Docker E2E passed"
