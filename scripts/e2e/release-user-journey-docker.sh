#!/usr/bin/env bash
# Package-installed release journey smoke with provider, plugins, ClickClack,
# agent turn, and restart survival.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-release-user-journey-e2e" OPENCLAW_RELEASE_USER_JOURNEY_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_RELEASE_USER_JOURNEY_E2E_SKIP_BUILD:-0}"
HTTP_TIMEOUT_MS="$(
  docker_e2e_read_positive_int_env OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS 5000
)"
HTTP_BODY_MAX_BYTES="$(
  docker_e2e_read_positive_int_env OPENCLAW_RELEASE_USER_JOURNEY_HTTP_BODY_MAX_BYTES 1048576
)"
run_log=""
cleanup() {
  docker_e2e_cleanup_package_tgz "${PACKAGE_TGZ:-}"
  if [ -n "${run_log:-}" ]; then
    rm -f "$run_log"
  fi
}
trap cleanup EXIT

PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz release-user-journey "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
docker_e2e_package_mount_args "$PACKAGE_TGZ"

docker_e2e_build_or_reuse "$IMAGE_NAME" release-user-journey "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "$SKIP_BUILD"
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 release-user-journey empty)"

run_log="$(docker_e2e_run_log release-user-journey)"
echo "Running release user journey Docker E2E..."
if ! docker_e2e_run_with_harness \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e "OPENCLAW_RELEASE_USER_JOURNEY_HTTP_TIMEOUT_MS=$HTTP_TIMEOUT_MS" \
  -e "OPENCLAW_RELEASE_USER_JOURNEY_HTTP_BODY_MAX_BYTES=$HTTP_BODY_MAX_BYTES" \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  -i "$IMAGE_NAME" bash scripts/e2e/lib/release-user-journey/scenario.sh >"$run_log" 2>&1; then
  docker_e2e_print_log "$run_log"
  exit 1
fi

echo "Release user journey Docker E2E passed."
