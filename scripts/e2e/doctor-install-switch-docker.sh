#!/usr/bin/env bash
# Verifies doctor/daemon repair switches service entrypoints between package and
# git installs. Both fixtures come from the same prepared OpenClaw npm tarball.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-doctor-install-switch-e2e" OPENCLAW_DOCTOR_INSTALL_SWITCH_E2E_IMAGE)"
PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz doctor-switch "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
# Bare lanes mount the package artifact instead of baking app sources into the image.
docker_e2e_package_mount_args "$PACKAGE_TGZ"
OPENCLAW_TEST_STATE_FUNCTION_B64="$(docker_e2e_test_state_function_b64)"

docker_e2e_build_or_reuse "$IMAGE_NAME" doctor-switch "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare"

echo "Running doctor install switch E2E..."
docker_e2e_run_with_harness \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e "OPENCLAW_TEST_STATE_FUNCTION_B64=$OPENCLAW_TEST_STATE_FUNCTION_B64" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  "$IMAGE_NAME" \
  bash scripts/e2e/lib/doctor-install-switch/scenario.sh
