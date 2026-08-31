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

DOCKER_ENV_ARGS=(
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  -e OPENCLAW_SKIP_CHANNELS=1
  -e OPENCLAW_SKIP_PROVIDERS=1
)

append_positive_int_env() {
  local name="$1"
  local value="${!name-}"
  if [ -z "$value" ]; then
    return 0
  fi
  value="$(docker_e2e_normalize_positive_int_value "$name" "$value")" || return $?
  DOCKER_ENV_ARGS+=(-e "$name=$value")
}

append_positive_number_env() {
  local name="$1"
  local value="${!name-}"
  if [ -z "$value" ]; then
    return 0
  fi
  if [[ ! "$value" =~ ^[0-9]+([.][0-9]+)?$ ]] || [[ -z "${value//[0.]/}" ]]; then
    echo "invalid $name: $value" >&2
    return 2
  fi
  DOCKER_ENV_ARGS+=(-e "$name=$value")
}

append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_PHASE_TIMEOUT_MS
append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_TIMEOUT_KILL_GRACE_MS
append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_METRIC_POLL_MS
append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_MAX_RSS_KB
append_positive_int_env OPENCLAW_PLUGIN_LIFECYCLE_MAX_WALL_MS
append_positive_number_env OPENCLAW_PLUGIN_LIFECYCLE_MAX_CPU_CORE_RATIO

PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz plugin-lifecycle-matrix "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
docker_e2e_package_mount_args "$PACKAGE_TGZ"

docker_e2e_build_or_reuse "$IMAGE_NAME" plugin-lifecycle-matrix "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "$SKIP_BUILD"

echo "Running plugin lifecycle matrix Docker E2E..."
docker_e2e_run_with_harness \
  "${DOCKER_ENV_ARGS[@]}" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  "$IMAGE_NAME" \
  tsx test/e2e/qa-lab/plugins/plugin-lifecycle-probe-runtime.ts --lifecycle-matrix

echo "Plugin lifecycle matrix Docker E2E passed."
