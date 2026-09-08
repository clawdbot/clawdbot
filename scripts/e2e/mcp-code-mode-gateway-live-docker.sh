#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
# Runs the packaged Gateway/code-mode/MCP API-file smoke against a live OpenAI
# provider so the real agent has to discover and use the virtual declarations.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/e2e/lib/prepublish-plugin-registry.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-mcp-code-mode-gateway-live-e2e" OPENCLAW_IMAGE)"
PORT="$(docker_e2e_read_tcp_port_env OPENCLAW_MCP_CODE_MODE_LIVE_GATEWAY_PORT 18789)"
CLIENT_TIMEOUT_MS="$(docker_e2e_read_positive_int_env OPENCLAW_MCP_CODE_MODE_CLIENT_TIMEOUT_MS 300000)"
CLIENT_BODY_MAX_BYTES="$(docker_e2e_read_positive_int_env OPENCLAW_MCP_CODE_MODE_CLIENT_BODY_MAX_BYTES 1048576)"
TOKEN="mcp-code-mode-live-e2e-$(date +%s)-$$"
CONTAINER_NAME="openclaw-mcp-code-mode-live-e2e-$$"
PROFILE_FILE="${OPENCLAW_MCP_CODE_MODE_LIVE_PROFILE_FILE:-${OPENCLAW_TESTBOX_PROFILE_FILE:-$HOME/.openclaw-testbox-live.profile}}"

CLIENT_LOG="$(mktemp -t openclaw-mcp-code-mode-live-log.XXXXXX)"

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$CLIENT_LOG"
}
trap cleanup EXIT

if [ ! -f "$PROFILE_FILE" ] && [ -f "$HOME/.profile" ]; then
  PROFILE_FILE="$HOME/.profile"
fi

PROFILE_STATUS="none"
if [ -f "$PROFILE_FILE" ] && [ -r "$PROFILE_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$PROFILE_FILE"
  set +a
  PROFILE_STATUS="$PROFILE_FILE"
fi

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "ERROR: OPENAI_API_KEY was not available after sourcing $PROFILE_STATUS." >&2
  exit 1
fi
docker_e2e_build_or_reuse "$IMAGE_NAME" mcp-code-mode-gateway-live
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 mcp-code-mode-gateway-live empty)"
OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DOCKER_ARGS=()
if [ -n "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ]; then
  openclaw_prepublish_plugin_registry_configure_docker_args "$OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR"
fi

# Pass only the selected provider's credentials into the container; importing
# the whole profile there also enables unrelated providers during startup.
unset OPENCLAW_TESTBOX

echo "Running live Docker Gateway code-mode MCP API-file smoke..."
echo "Profile file: $PROFILE_STATUS"
set +e
docker_e2e_run_with_harness \
  --name "$CONTAINER_NAME" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENAI_API_KEY \
  -e OPENAI_BASE_URL \
  -e "OPENCLAW_DOCKER_OPENAI_BASE_URL=${OPENAI_BASE_URL:-https://api.openai.com/v1}" \
  -e "OPENCLAW_GATEWAY_TOKEN=$TOKEN" \
  -e "OPENCLAW_SKIP_CHANNELS=1" \
  -e "OPENCLAW_SKIP_GMAIL_WATCHER=1" \
  -e "OPENCLAW_SKIP_CRON=1" \
  -e "OPENCLAW_SKIP_CANVAS_HOST=1" \
  -e "OPENCLAW_SKIP_ACPX_RUNTIME=1" \
  -e "OPENCLAW_SKIP_ACPX_RUNTIME_PROBE=1" \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  -e "GW_URL=http://127.0.0.1:$PORT" \
  -e "GW_TOKEN=$TOKEN" \
  -e "OPENCLAW_MCP_CODE_MODE_CLIENT_TIMEOUT_MS=$CLIENT_TIMEOUT_MS" \
  -e "OPENCLAW_MCP_CODE_MODE_CLIENT_BODY_MAX_BYTES=$CLIENT_BODY_MAX_BYTES" \
  -e "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1" \
  -e "OPENCLAW_MCP_CODE_MODE_MODEL=${OPENCLAW_MCP_CODE_MODE_LIVE_MODEL:-openclaw/main}" \
  ${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DOCKER_ARGS[@]+"${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DOCKER_ARGS[@]}"} \
  "$IMAGE_NAME" \
  bash scripts/e2e/lib/mcp-code-mode/scenario.sh live "$PORT" >"$CLIENT_LOG" 2>&1
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  echo "Live Docker MCP code-mode API-file smoke failed"
  docker_e2e_print_log "$CLIENT_LOG"
  exit "$status"
fi

docker_e2e_print_log "$CLIENT_LOG"
echo "OK"
