#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-openai-chat-tools-e2e" OPENCLAW_OPENAI_CHAT_TOOLS_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_OPENAI_CHAT_TOOLS_E2E_SKIP_BUILD:-0}"
PORT="${OPENCLAW_OPENAI_CHAT_TOOLS_PORT:-18789}"
TOKEN="openai-chat-tools-e2e-$$"
PROFILE_FILE="${OPENCLAW_OPENAI_CHAT_TOOLS_PROFILE_FILE:-${OPENCLAW_TESTBOX_PROFILE_FILE:-$HOME/.openclaw-testbox-live.profile}}"
if [ ! -f "$PROFILE_FILE" ] && [ -f "$HOME/.profile" ]; then
  PROFILE_FILE="$HOME/.profile"
fi

docker_e2e_build_or_reuse "$IMAGE_NAME" openai-chat-tools "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "" "$SKIP_BUILD"
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 openai-chat-tools empty)"

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

echo "Running OpenAI Chat Completions tools Docker E2E..."
echo "Profile file: $PROFILE_STATUS"
docker_e2e_run_logged_with_harness openai-chat-tools \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENAI_API_KEY \
  -e OPENAI_BASE_URL \
  -e "OPENCLAW_GATEWAY_TOKEN=$TOKEN" \
  -e "OPENCLAW_OPENAI_CHAT_TOOLS_MODEL=${OPENCLAW_OPENAI_CHAT_TOOLS_MODEL:-openai/gpt-5.4-mini}" \
  -e "OPENCLAW_OPENAI_CHAT_TOOLS_TIMEOUT_SECONDS=${OPENCLAW_OPENAI_CHAT_TOOLS_TIMEOUT_SECONDS:-180}" \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  -e "PORT=$PORT" \
  "${PROFILE_MOUNT[@]}" \
  "$IMAGE_NAME" \
  bash scripts/e2e/lib/openai-chat-tools/scenario.sh
