#!/usr/bin/env bash
# Runs the Crestodian planner fallback Docker smoke against the package-installed
# functional E2E image, with only the test harness mounted from the checkout.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-crestodian-planner-e2e" OPENCLAW_CRESTODIAN_PLANNER_E2E_IMAGE)"
CONTAINER_NAME="openclaw-crestodian-planner-e2e-$$"
RUN_LOG="$(mktemp -t openclaw-crestodian-planner-log.XXXXXX)"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$RUN_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" crestodian-planner
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 crestodian-planner empty)"

echo "Running in-container Crestodian planner fallback smoke..."
# Harness files are mounted read-only; the app under test comes from /app/dist.
set +e
docker_e2e_run_with_harness \
  --name "$CONTAINER_NAME" \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail
    source scripts/lib/openclaw-e2e-instance.sh
    openclaw_e2e_eval_test_state_from_b64 \"\${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}\"
    node scripts/e2e/crestodian-planner-docker-client.mjs
  " >"$RUN_LOG" 2>&1
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker Crestodian planner fallback smoke failed"
  cat "$RUN_LOG"
  exit "$status"
fi

cat "$RUN_LOG"
echo "OK"
