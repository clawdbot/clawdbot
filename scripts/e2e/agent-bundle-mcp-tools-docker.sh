#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
# Verifies embedded OpenClaw bundle MCP tool materialization and tool-policy behavior
# inside the package-installed functional E2E image.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/frozen-target-compat.sh"
SOURCE_ROOT="${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$ROOT_DIR}"
openclaw_resolve_frozen_core_harness_capabilities "$SOURCE_ROOT"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-agent-bundle-mcp-tools-e2e" OPENCLAW_IMAGE)"
CONTAINER_NAME="openclaw-agent-bundle-mcp-tools-e2e-$$"
RUN_LOG="$(mktemp -t openclaw-agent-bundle-mcp-tools-log.XXXXXX)"
LEGACY_CLIENT_SOURCE_ROOT=""

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$RUN_LOG"
  [ -z "$LEGACY_CLIENT_SOURCE_ROOT" ] || rm -rf "$LEGACY_CLIENT_SOURCE_ROOT"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" agent-bundle-mcp-tools
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 agent-bundle-mcp-tools empty)"
CLIENT_PATH="test/e2e/qa-lab/runtime/agent-bundle-mcp-tools-docker-client.ts"
CLIENT_MOUNT_ARGS=()
if [ "$OPENCLAW_FROZEN_TARGET_AGENT_BUNDLE_MCP_MODE" = "legacy" ]; then
  # The selected release's client imports sibling E2E helpers and ../../dist.
  # Materialize its committed source tree outside the trusted read-only harness.
  LEGACY_CLIENT_SOURCE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-frozen-agent-bundle-mcp-tools.XXXXXX")"
  # Preserve its root package.json so tsx retains the selected release's ESM scope,
  # then link the package-owned dependencies.
  git -C "$SOURCE_ROOT" archive "$OPENCLAW_SELECTED_SHA" -- package.json scripts/e2e |
    tar -x -C "$LEGACY_CLIENT_SOURCE_ROOT"
  LEGACY_CLIENT_ROOT="/tmp/openclaw-frozen-agent-bundle-mcp-tools"
  CLIENT_PATH="$LEGACY_CLIENT_ROOT/scripts/e2e/agent-bundle-mcp-tools-docker-client.ts"
  ln -s /app/dist "$LEGACY_CLIENT_SOURCE_ROOT/dist"
  ln -s /app/node_modules "$LEGACY_CLIENT_SOURCE_ROOT/node_modules"
  # The functional image runs as UID 1001 and must traverse this host-owned staging root.
  chmod 0755 "$LEGACY_CLIENT_SOURCE_ROOT"
  CLIENT_MOUNT_ARGS=(
    -v "$LEGACY_CLIENT_SOURCE_ROOT:$LEGACY_CLIENT_ROOT:ro"
  )
fi

echo "Running in-container OpenClaw bundle MCP tool availability smoke..."
# Harness files are mounted read-only; the app under test comes from /app/dist.
set +e
docker_e2e_run_with_harness \
  --name "$CONTAINER_NAME" \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  ${CLIENT_MOUNT_ARGS[@]+"${CLIENT_MOUNT_ARGS[@]}"} \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail
    source scripts/lib/openclaw-e2e-instance.sh
    openclaw_e2e_eval_test_state_from_b64 \"\${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}\"
    tsx $CLIENT_PATH
  " >"$RUN_LOG" 2>&1
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker OpenClaw bundle MCP tool availability smoke failed"
  docker_e2e_print_log "$RUN_LOG"
  exit "$status"
fi

docker_e2e_print_log "$RUN_LOG"
echo "OK"
