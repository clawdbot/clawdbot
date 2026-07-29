#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-kitchen-sink-plugin-e2e" OPENCLAW_KITCHEN_SINK_PLUGIN_E2E_IMAGE)"
OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES="$(
  docker_e2e_read_positive_int_env OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES 65536
)"
CLAW_HUB_FIXTURE_WAIT_ATTEMPTS="$(
  docker_e2e_read_positive_int_env OPENCLAW_CLAWHUB_FIXTURE_WAIT_ATTEMPTS 600
)"

OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 kitchen-sink-plugin empty)"
KITCHEN_SINK_NPM_SPEC="${OPENCLAW_KITCHEN_SINK_NPM_SPEC:-npm:@openclaw/kitchen-sink@latest}"
KITCHEN_SINK_NPM_MISSING_SPEC="${OPENCLAW_KITCHEN_SINK_NPM_MISSING_SPEC:-npm:@openclaw/kitchen-sink@beta}"

DEFAULT_KITCHEN_SINK_SCENARIOS="$(
  cat <<SCENARIOS
npm-latest-full|${KITCHEN_SINK_NPM_SPEC}|openclaw-kitchen-sink-fixture|npm|success|full
npm-latest-conformance|${KITCHEN_SINK_NPM_SPEC}|openclaw-kitchen-sink-fixture|npm|success|conformance|conformance
npm-latest-adversarial|${KITCHEN_SINK_NPM_SPEC}|openclaw-kitchen-sink-fixture|npm|success|adversarial|adversarial
npm-beta|${KITCHEN_SINK_NPM_MISSING_SPEC}|openclaw-kitchen-sink-fixture|npm|failure|none
clawhub-latest|clawhub:@openclaw/kitchen-sink@latest|openclaw-kitchen-sink-fixture|clawhub|success|basic
clawhub-beta|clawhub:@openclaw/kitchen-sink@beta|openclaw-kitchen-sink-fixture|clawhub|failure|none
npm-to-clawhub|clawhub:@openclaw/kitchen-sink@latest|openclaw-kitchen-sink-fixture|clawhub|success|basic||${KITCHEN_SINK_NPM_SPEC}
SCENARIOS
)"
KITCHEN_SINK_SCENARIOS="${OPENCLAW_KITCHEN_SINK_PLUGIN_SCENARIOS:-$DEFAULT_KITCHEN_SINK_SCENARIOS}"
MAX_MEMORY_MIB="$(
  if [[ -n "${OPENCLAW_KITCHEN_SINK_PLUGIN_MAX_MEMORY_MIB:-}" ]]; then
    docker_e2e_read_nonnegative_decimal_env OPENCLAW_KITCHEN_SINK_PLUGIN_MAX_MEMORY_MIB 2304
  else
    docker_e2e_read_nonnegative_decimal_env OPENCLAW_KITCHEN_SINK_MAX_MEMORY_MIB 2304
  fi
)"
MAX_CPU_PERCENT="$(docker_e2e_read_nonnegative_decimal_env OPENCLAW_KITCHEN_SINK_MAX_CPU_PERCENT 1200)"
DOCKER_RUN_TIMEOUT="${OPENCLAW_KITCHEN_SINK_PLUGIN_DOCKER_RUN_TIMEOUT:-1200s}"
KITCHEN_SINK_CLI_TIMEOUT="${OPENCLAW_KITCHEN_SINK_PLUGIN_CLI_TIMEOUT:-${KITCHEN_SINK_CLI_TIMEOUT:-180s}}"
CONTAINER_NAME="openclaw-kitchen-sink-plugin-e2e-$$"
RUN_LOG="$(mktemp "${TMPDIR:-/tmp}/openclaw-kitchen-sink-plugin.XXXXXX")"
STATS_LOG="$(mktemp "${TMPDIR:-/tmp}/openclaw-kitchen-sink-plugin-stats.XXXXXX")"

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$RUN_LOG" "$STATS_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" kitchen-sink-plugin

DOCKER_ENV_ARGS=(
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  -e "OPENCLAW_CLAWHUB_FIXTURE_WAIT_ATTEMPTS=$CLAW_HUB_FIXTURE_WAIT_ATTEMPTS"
  -e "OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES=$OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES"
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64"
  -e "KITCHEN_SINK_SCENARIOS=$KITCHEN_SINK_SCENARIOS"
  -e "KITCHEN_SINK_CLI_TIMEOUT=$KITCHEN_SINK_CLI_TIMEOUT"
)
if [[ "${OPENCLAW_KITCHEN_SINK_LIVE_CLAWHUB:-0}" = "1" ]]; then
  for env_name in \
    OPENCLAW_KITCHEN_SINK_LIVE_CLAWHUB \
    OPENCLAW_CLAWHUB_URL \
    CLAWHUB_URL \
    CLAWHUB_TOKEN \
    CLAWHUB_AUTH_TOKEN; do
    env_value="${!env_name:-}"
    if [[ -n "$env_value" && "$env_value" != "undefined" && "$env_value" != "null" ]]; then
      DOCKER_ENV_ARGS+=(-e "$env_name")
    fi
  done
fi

echo "Running kitchen-sink plugin Docker E2E..."
docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker_e2e_harness_mount_args
DOCKER_COMMAND_TIMEOUT="$DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run --name "$CONTAINER_NAME" "${DOCKER_E2E_HARNESS_ARGS[@]}" "${DOCKER_ENV_ARGS[@]}" -i "$IMAGE_NAME" bash scripts/e2e/lib/kitchen-sink-plugin/sweep.sh \
  >"$RUN_LOG" 2>&1 &
docker_pid="$!"

docker_e2e_sample_stats_until_exit \
  "$CONTAINER_NAME" \
  "$docker_pid" \
  "$STATS_LOG" \
  "$RUN_LOG" \
  "Kitchen-sink plugin Docker E2E" \
  "${OPENCLAW_DOCKER_E2E_STATS_HEARTBEAT_SECONDS:-30}"

set +e
wait "$docker_pid"
run_status="$?"
set -e

docker_e2e_print_log "$RUN_LOG"

if [ "$run_status" -eq 0 ]; then
  node scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs "$STATS_LOG" "$MAX_MEMORY_MIB" "$MAX_CPU_PERCENT" kitchen-sink
elif [ -s "$STATS_LOG" ]; then
  if ! node scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs "$STATS_LOG" "$MAX_MEMORY_MIB" "$MAX_CPU_PERCENT" kitchen-sink; then
    echo "RESOURCE_CEILING_FAILED lane=kitchen-sink primary_status=$run_status" >&2
  fi
fi

exit "$run_status"
