#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
# Runs a deterministic packaged Gateway/code-mode/MCP smoke using the Docker
# functional image and the local mock OpenAI Responses server.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/e2e/lib/prepublish-plugin-registry.sh"
source "$ROOT_DIR/scripts/lib/frozen-target-compat.sh"
openclaw_resolve_frozen_core_harness_capabilities "${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$ROOT_DIR}"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-mcp-code-mode-gateway-e2e" OPENCLAW_IMAGE)"
PORT="$(docker_e2e_read_tcp_port_env OPENCLAW_MCP_CODE_MODE_GATEWAY_PORT 18789)"
MOCK_PORT="$(docker_e2e_read_tcp_port_env OPENCLAW_MCP_CODE_MODE_MOCK_PORT 44082)"
CLIENT_TIMEOUT_MS="$(docker_e2e_read_positive_int_env OPENCLAW_MCP_CODE_MODE_CLIENT_TIMEOUT_MS 300000)"
CLIENT_BODY_MAX_BYTES="$(docker_e2e_read_positive_int_env OPENCLAW_MCP_CODE_MODE_CLIENT_BODY_MAX_BYTES 1048576)"
TOKEN="mcp-code-mode-e2e-$(date +%s)-$$"
CONTAINER_NAME="openclaw-mcp-code-mode-e2e-$$"

CLIENT_LOG="$(mktemp -t openclaw-mcp-code-mode-client-log.XXXXXX)"

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$CLIENT_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" mcp-code-mode-gateway
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 mcp-code-mode-gateway empty)"
OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DOCKER_ARGS=()
if [ -n "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ]; then
  openclaw_prepublish_plugin_registry_configure_docker_args "$OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR"
fi
MCP_CODE_MODE_SEED_ENV_ARGS=()
if [ "$OPENCLAW_FROZEN_TARGET_MCP_MEMORY_CONFIG_MODE" = "agent" ]; then
  MCP_CODE_MODE_SEED_ENV_ARGS+=( -e "OPENCLAW_FROZEN_TARGET_MCP_MEMORY_CONFIG_MODE=agent" )
fi
if [ "$OPENCLAW_FROZEN_TARGET_MCP_CODE_MODE_CATALOG_MODE" = "legacy" ]; then
  MCP_CODE_MODE_SEED_ENV_ARGS+=( -e "OPENCLAW_FROZEN_TARGET_MCP_CODE_MODE_CATALOG_MODE=legacy" )
fi

echo "Running in-container deterministic Gateway code-mode MCP API-file smoke..."
set +e
docker_e2e_run_with_harness \
  --name "$CONTAINER_NAME" \
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
  ${MCP_CODE_MODE_SEED_ENV_ARGS[@]+"${MCP_CODE_MODE_SEED_ENV_ARGS[@]}"} \
  -e "OPENCLAW_ALLOW_INSECURE_PRIVATE_WS=1" \
  ${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DOCKER_ARGS[@]+"${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DOCKER_ARGS[@]}"} \
  "$IMAGE_NAME" \
  bash scripts/e2e/lib/mcp-code-mode/scenario.sh mock "$PORT" "$MOCK_PORT" >"$CLIENT_LOG" 2>&1
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker MCP code-mode API-file smoke failed"
  docker_e2e_print_log "$CLIENT_LOG"
  exit "$status"
fi

docker_e2e_print_log "$CLIENT_LOG"
echo "OK"
