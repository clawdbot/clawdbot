#!/usr/bin/env bash
# Bare package-level plugin lifecycle matrix with resource metrics.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-plugin-lifecycle-matrix-e2e" OPENCLAW_PLUGIN_LIFECYCLE_MATRIX_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_PLUGIN_LIFECYCLE_MATRIX_E2E_SKIP_BUILD:-0}"
cleanup() {
  docker_e2e_cleanup_package_tgz "${PACKAGE_TGZ:-}"
}
trap cleanup EXIT

PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz plugin-lifecycle-matrix "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
docker_e2e_package_mount_args "$PACKAGE_TGZ"

docker_e2e_build_or_reuse "$IMAGE_NAME" plugin-lifecycle-matrix "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "$SKIP_BUILD"
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 plugin-lifecycle-matrix empty)"
DOCKER_ENV_ARGS=(
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  -e OPENCLAW_SKIP_CHANNELS=1
  -e OPENCLAW_SKIP_PROVIDERS=1
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64"
)
if [ -n "${OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS:-}" ]; then
  DOCKER_ENV_ARGS+=(-e "OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS=$OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS")
fi
if [ -n "${OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS:-}" ]; then
  DOCKER_ENV_ARGS+=(-e "OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS=$OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS")
fi
if [ -n "${OPENCLAW_PLUGIN_LIFECYCLE_MAX_RSS_KB:-}" ]; then
  DOCKER_ENV_ARGS+=(-e "OPENCLAW_PLUGIN_LIFECYCLE_MAX_RSS_KB=$OPENCLAW_PLUGIN_LIFECYCLE_MAX_RSS_KB")
fi
if [ -n "${OPENCLAW_PLUGIN_LIFECYCLE_MAX_WALL_MS:-}" ]; then
  DOCKER_ENV_ARGS+=(-e "OPENCLAW_PLUGIN_LIFECYCLE_MAX_WALL_MS=$OPENCLAW_PLUGIN_LIFECYCLE_MAX_WALL_MS")
fi
if [ -n "${OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO:-}" ]; then
  DOCKER_ENV_ARGS+=(-e "OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO=$OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO")
fi

echo "Running plugin lifecycle matrix Docker E2E..."
docker_e2e_run_with_harness \
  "${DOCKER_ENV_ARGS[@]}" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  "$IMAGE_NAME" \
  bash scripts/e2e/lib/plugin-lifecycle-matrix/sweep.sh

echo "Plugin lifecycle matrix Docker E2E passed."
