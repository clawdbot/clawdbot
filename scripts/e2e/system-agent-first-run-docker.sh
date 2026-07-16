#!/usr/bin/env bash
# Runs the OpenClaw first-run Docker smoke against the package-installed
# functional E2E image, with only the test harness mounted from the checkout.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-system-agent-first-run-e2e" OPENCLAW_SYSTEM_AGENT_FIRST_RUN_E2E_IMAGE)"
CONTAINER_NAME="openclaw-system-agent-first-run-e2e-$$"
RUN_LOG="$(mktemp -t openclaw-system-agent-first-run-log.XXXXXX)"

cleanup() {
  docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -f "$RUN_LOG"
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" system-agent-first-run
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 system-agent-first-run empty)"

echo "Running in-container OpenClaw first-run smoke..."
# Harness files are mounted read-only; the app under test comes from /app/dist.
set +e
docker_e2e_run_with_harness \
  --name "$CONTAINER_NAME" \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail
    source scripts/lib/openclaw-e2e-instance.sh
    openclaw_e2e_eval_test_state_from_b64 \"\${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}\"
    tsx test/e2e/qa-lab/runtime/system-agent-first-run-docker-client.ts
  " >"$RUN_LOG" 2>&1
status=${PIPESTATUS[0]}
set -e

if [ "$status" -ne 0 ]; then
  echo "Docker OpenClaw first-run smoke failed"
  docker_e2e_print_log "$RUN_LOG"
  exit "$status"
fi

docker_e2e_print_log "$RUN_LOG"
echo "OK"
