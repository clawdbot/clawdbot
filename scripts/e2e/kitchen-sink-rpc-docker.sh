#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-kitchen-sink-rpc-e2e" OPENCLAW_KITCHEN_SINK_RPC_E2E_IMAGE)"
MAX_MEMORY_MIB="${OPENCLAW_KITCHEN_SINK_MAX_MEMORY_MIB:-2048}"
MAX_CPU_PERCENT="${OPENCLAW_KITCHEN_SINK_MAX_CPU_PERCENT:-1200}"
DOCKER_RUN_TIMEOUT="${OPENCLAW_KITCHEN_SINK_RPC_DOCKER_RUN_TIMEOUT:-900s}"
CONTAINER_NAME="openclaw-kitchen-sink-rpc-e2e-$$"
RUN_LOG="$(mktemp "${TMPDIR:-/tmp}/openclaw-kitchen-sink-rpc.XXXXXX")"
STATS_LOG="$(mktemp "${TMPDIR:-/tmp}/openclaw-kitchen-sink-rpc-stats.XXXXXX")"

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$RUN_LOG" "$STATS_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" kitchen-sink-rpc

DOCKER_ENV_ARGS=(
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  -e OPENCLAW_ENTRY=/app/openclaw.mjs
)

for env_name in \
  OPENCLAW_KITCHEN_SINK_NPM_SPEC \
  OPENCLAW_KITCHEN_SINK_PLUGIN_ID \
  OPENCLAW_KITCHEN_SINK_PERSONALITY \
  OPENCLAW_KITCHEN_SINK_RPC_READY_MS \
  OPENCLAW_KITCHEN_SINK_RPC_COMMAND_MS \
  OPENCLAW_KITCHEN_SINK_RPC_INSTALL_MS \
  OPENCLAW_KITCHEN_SINK_RPC_CALL_MS \
  OPENCLAW_KITCHEN_SINK_RPC_PORT \
  OPENCLAW_KITCHEN_SINK_RPC_FETCH_MS \
  OPENCLAW_KITCHEN_SINK_RPC_FETCH_BODY_BYTES \
  OPENCLAW_KITCHEN_SINK_OUTPUT_CAPTURE_CHARS \
  OPENCLAW_KITCHEN_SINK_KEEP_TMP \
  OPENCLAW_KITCHEN_SINK_MAX_RSS_MIB \
  OPENCLAW_KITCHEN_SINK_COMMAND_MAX_RSS_MIB; do
  env_value="${!env_name:-}"
  if [[ -n "$env_value" && "$env_value" != "undefined" && "$env_value" != "null" ]]; then
    DOCKER_ENV_ARGS+=(-e "$env_name")
  fi
done

echo "Running kitchen-sink RPC Docker E2E..."
docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker_e2e_harness_mount_args
DOCKER_COMMAND_TIMEOUT="$DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run --name "$CONTAINER_NAME" "${DOCKER_E2E_HARNESS_ARGS[@]}" "${DOCKER_ENV_ARGS[@]}" -i "$IMAGE_NAME" \
  node scripts/e2e/kitchen-sink-rpc-walk.mjs >"$RUN_LOG" 2>&1 &
docker_pid="$!"

docker_e2e_sample_stats_until_exit \
  "$CONTAINER_NAME" \
  "$docker_pid" \
  "$STATS_LOG" \
  "$RUN_LOG" \
  "Kitchen-sink RPC Docker E2E" \
  "${OPENCLAW_DOCKER_E2E_STATS_HEARTBEAT_SECONDS:-30}"

set +e
wait "$docker_pid"
run_status="$?"
set -e

docker_e2e_print_log "$RUN_LOG"

if [ "$run_status" -eq 0 ]; then
  node scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs "$STATS_LOG" "$MAX_MEMORY_MIB" "$MAX_CPU_PERCENT" kitchen-sink-rpc
elif [ -s "$STATS_LOG" ]; then
  if ! node scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs "$STATS_LOG" "$MAX_MEMORY_MIB" "$MAX_CPU_PERCENT" kitchen-sink-rpc; then
    echo "RESOURCE_CEILING_FAILED lane=kitchen-sink-rpc primary_status=$run_status" >&2
  fi
fi

exit "$run_status"
