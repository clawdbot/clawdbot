#!/usr/bin/env bash
# Published-baseline-to-candidate release user journey smoke.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-release-upgrade-user-journey-e2e" OPENCLAW_RELEASE_UPGRADE_USER_JOURNEY_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_RELEASE_UPGRADE_USER_JOURNEY_E2E_SKIP_BUILD:-0}"
PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz release-upgrade-user-journey "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
docker_e2e_package_mount_args "$PACKAGE_TGZ"

docker_e2e_build_or_reuse "$IMAGE_NAME" release-upgrade-user-journey "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "$SKIP_BUILD"
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 release-upgrade-user-journey empty)"

run_log="$(docker_e2e_run_log release-upgrade-user-journey)"
echo "Running release upgrade user journey Docker E2E..."
if ! docker_e2e_run_with_harness \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  -e "OPENCLAW_RELEASE_UPGRADE_BASELINE_SPEC=${OPENCLAW_RELEASE_UPGRADE_BASELINE_SPEC:-openclaw@latest}" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  -i "$IMAGE_NAME" bash scripts/e2e/lib/release-upgrade-user-journey/scenario.sh >"$run_log" 2>&1; then
  docker_e2e_print_log "$run_log"
  rm -f "$run_log"
  exit 1
fi

rm -f "$run_log"
echo "Release upgrade user journey Docker E2E passed."
