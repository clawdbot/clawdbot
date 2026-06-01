#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-onboard-e2e" OPENCLAW_ONBOARD_E2E_IMAGE)"
OPENCLAW_TEST_STATE_FUNCTION_B64="$(docker_e2e_test_state_function_b64)"
MAX_MEMORY_MIB="${OPENCLAW_ONBOARD_MAX_MEMORY_MIB:-2048}"
MAX_CPU_PERCENT="${OPENCLAW_ONBOARD_MAX_CPU_PERCENT:-1200}"
DOCKER_RUN_TIMEOUT="${OPENCLAW_ONBOARD_DOCKER_RUN_TIMEOUT:-1200s}"
COMMAND_TIMEOUT="${OPENCLAW_ONBOARD_COMMAND_TIMEOUT:-${OPENCLAW_E2E_COMMAND_TIMEOUT:-300s}}"
CONTAINER_NAME="openclaw-onboard-e2e-$$"
RUN_LOG="$(mktemp "${TMPDIR:-/tmp}/openclaw-onboard.XXXXXX")"
STATS_LOG="$(mktemp "${TMPDIR:-/tmp}/openclaw-onboard-stats.XXXXXX")"

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$RUN_LOG" "$STATS_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" onboard

echo "Running onboarding E2E..."
docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker_e2e_harness_mount_args
DOCKER_COMMAND_TIMEOUT="$DOCKER_RUN_TIMEOUT" docker_e2e_docker_run_cmd run --name "$CONTAINER_NAME" "${DOCKER_E2E_HARNESS_ARGS[@]}" -t \
  -e "OPENCLAW_TEST_STATE_FUNCTION_B64=$OPENCLAW_TEST_STATE_FUNCTION_B64" \
  -e "OPENCLAW_E2E_COMMAND_TIMEOUT=$COMMAND_TIMEOUT" \
  "$IMAGE_NAME" bash scripts/e2e/lib/onboard/scenario.sh >"$RUN_LOG" 2>&1 &
docker_pid="$!"

docker_e2e_sample_stats_until_exit \
  "$CONTAINER_NAME" \
  "$docker_pid" \
  "$STATS_LOG" \
  "$RUN_LOG" \
  "Onboarding Docker E2E" \
  "${OPENCLAW_DOCKER_E2E_STATS_HEARTBEAT_SECONDS:-30}"

set +e
wait "$docker_pid"
run_status="$?"
set -e

cat "$RUN_LOG"

if [ "$run_status" -eq 0 ]; then
  node scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs "$STATS_LOG" "$MAX_MEMORY_MIB" "$MAX_CPU_PERCENT" onboard
  echo "E2E complete."
elif [ -s "$STATS_LOG" ]; then
  node scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs "$STATS_LOG" "$MAX_MEMORY_MIB" "$MAX_CPU_PERCENT" onboard || true
fi
exit "$run_status"
