#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-onboard-e2e" OPENCLAW_ONBOARD_E2E_IMAGE)"
OPENCLAW_TEST_STATE_FUNCTION_B64="$(docker_e2e_test_state_function_b64)"
MAX_MEMORY_MIB="${OPENCLAW_ONBOARD_MAX_MEMORY_MIB:-2048}"
MAX_CPU_PERCENT="${OPENCLAW_ONBOARD_MAX_CPU_PERCENT:-1200}"
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
docker_e2e_docker_run_cmd run --name "$CONTAINER_NAME" "${DOCKER_E2E_HARNESS_ARGS[@]}" -t \
  -e "OPENCLAW_TEST_STATE_FUNCTION_B64=$OPENCLAW_TEST_STATE_FUNCTION_B64" \
  "$IMAGE_NAME" bash scripts/e2e/lib/onboard/scenario.sh >"$RUN_LOG" 2>&1 &
docker_pid="$!"

while kill -0 "$docker_pid" 2>/dev/null; do
  if docker_e2e_docker_cmd inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    docker_e2e_docker_cmd stats --no-stream --format '{{json .}}' "$CONTAINER_NAME" >>"$STATS_LOG" 2>/dev/null || true
  fi
  sleep 2
done

set +e
wait "$docker_pid"
run_status="$?"
set -e

cat "$RUN_LOG"

node scripts/e2e/lib/docker-stats/assert-resource-ceiling.mjs "$STATS_LOG" "$MAX_MEMORY_MIB" "$MAX_CPU_PERCENT" onboard

echo "E2E complete."
exit "$run_status"
