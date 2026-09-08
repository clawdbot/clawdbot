#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
# Verifies the target's Doctor service-maintenance contract across package and
# git installs. Both fixtures use the same prepared tarball.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET_ROOT_DIR="$(cd "${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$ROOT_DIR}" && pwd)"
TARGET_CONTRACT_DIR="$TARGET_ROOT_DIR/scripts/e2e/lib/doctor-install-switch"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"
IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-doctor-install-switch-e2e" OPENCLAW_DOCTOR_INSTALL_SWITCH_E2E_IMAGE)"
NPM_INSTALL_TIMEOUT="${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-600s}"
COMMAND_TIMEOUT="${OPENCLAW_DOCKER_DOCTOR_SWITCH_COMMAND_TIMEOUT:-900s}"
cleanup() {
  docker_e2e_cleanup_package_tgz "${PACKAGE_TGZ:-}"
}
trap cleanup EXIT

PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz doctor-switch "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
# Bare lanes mount the package artifact instead of baking app sources into the image.
docker_e2e_package_mount_args "$PACKAGE_TGZ"
OPENCLAW_TEST_STATE_FUNCTION_B64="$(docker_e2e_test_state_function_b64)"

docker_e2e_build_or_reuse "$IMAGE_NAME" doctor-switch "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare"

echo "Running doctor install switch E2E..."
# Maintenance loads the installed unit's canonical PATH. Mount the shims there
# so the unprivileged container keeps using the fixture manager during inspection.
SHIM_DIR="$ROOT_DIR/scripts/e2e/lib/doctor-install-switch/shims"
docker_e2e_run_with_harness \
  -v "$SHIM_DIR/systemctl:/usr/local/bin/systemctl:ro" \
  -v "$SHIM_DIR/loginctl:/usr/local/bin/loginctl:ro" \
  -v "$SHIM_DIR/busctl:/usr/local/bin/busctl:ro" \
  -v "$SHIM_DIR/systemd-exec-start.mjs:/usr/local/bin/systemd-exec-start.mjs:ro" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e "OPENCLAW_DOCKER_DOCTOR_SWITCH_COMMAND_TIMEOUT=$COMMAND_TIMEOUT" \
  -e "OPENCLAW_E2E_NPM_INSTALL_TIMEOUT=$NPM_INSTALL_TIMEOUT" \
  -e "OPENCLAW_TEST_STATE_FUNCTION_B64=$OPENCLAW_TEST_STATE_FUNCTION_B64" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  -v "$TARGET_CONTRACT_DIR:/app/scripts/e2e/lib/doctor-install-switch:ro" \
  "$IMAGE_NAME" \
  bash scripts/e2e/lib/doctor-install-switch/scenario.sh
