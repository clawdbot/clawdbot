#!/usr/bin/env bash
# Verifies `openclaw plugins update` is a no-op for an already-current plugin.
# The CLI under test is installed from the prepared npm tarball in a bare runner.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-plugin-update-e2e" OPENCLAW_PLUGIN_UPDATE_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_PLUGIN_UPDATE_E2E_SKIP_BUILD:-0}"
PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz plugin-update "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
# Bare lanes mount the package artifact instead of baking app sources into the image.
docker_e2e_package_mount_args "$PACKAGE_TGZ"

docker_e2e_build_or_reuse "$IMAGE_NAME" plugin-update "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "$SKIP_BUILD"
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 plugin-update empty)"

echo "Running unchanged plugin update smoke..."
docker_e2e_run_with_harness \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENCLAW_SKIP_CHANNELS=1 \
  -e OPENCLAW_SKIP_PROVIDERS=1 \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  "$IMAGE_NAME" \
  bash scripts/e2e/lib/plugin-update/unchanged-scenario.sh

echo "Plugin update unchanged Docker E2E passed."
