#!/usr/bin/env bash
# Runs bundled plugin runtime-dependency Docker scenarios from a mounted OpenClaw
# npm tarball. The default image is a clean runner; each scenario installs the
# tarball so package install behavior is what gets tested.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"
source "$ROOT_DIR/scripts/e2e/lib/bundled-channel-runtime-deps-runner.sh"
source "$ROOT_DIR/scripts/e2e/lib/bundled-channel/channel.sh"
source "$ROOT_DIR/scripts/e2e/lib/bundled-channel/root-owned.sh"
source "$ROOT_DIR/scripts/e2e/lib/bundled-channel/setup-entry.sh"
source "$ROOT_DIR/scripts/e2e/lib/bundled-channel/disabled-config.sh"
source "$ROOT_DIR/scripts/e2e/lib/bundled-channel/update.sh"
source "$ROOT_DIR/scripts/e2e/lib/bundled-channel/load-failure.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-bundled-channel-deps-e2e" OPENCLAW_BUNDLED_CHANNEL_DEPS_E2E_IMAGE)"
UPDATE_BASELINE_VERSION="${OPENCLAW_BUNDLED_CHANNEL_UPDATE_BASELINE_VERSION:-2026.4.20}"
DOCKER_TARGET="${OPENCLAW_BUNDLED_CHANNEL_DOCKER_TARGET:-bare}"
HOST_BUILD="${OPENCLAW_BUNDLED_CHANNEL_HOST_BUILD:-1}"
PACKAGE_TGZ="${OPENCLAW_CURRENT_PACKAGE_TGZ:-}"
RUN_CHANNEL_SCENARIOS="${OPENCLAW_BUNDLED_CHANNEL_SCENARIOS:-1}"
RUN_UPDATE_SCENARIO="${OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO:-1}"
RUN_ROOT_OWNED_SCENARIO="${OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO:-1}"
RUN_SETUP_ENTRY_SCENARIO="${OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO:-1}"
RUN_LOAD_FAILURE_SCENARIO="${OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO:-1}"
RUN_DISABLED_CONFIG_SCENARIO="${OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO:-1}"
CHANNEL_ONLY="${OPENCLAW_BUNDLED_CHANNEL_ONLY:-}"
DOCKER_RUN_TIMEOUT="${OPENCLAW_BUNDLED_CHANNEL_DOCKER_RUN_TIMEOUT:-900s}"
DOCKER_UPDATE_RUN_TIMEOUT="${OPENCLAW_BUNDLED_CHANNEL_UPDATE_DOCKER_RUN_TIMEOUT:-${OPENCLAW_BUNDLED_CHANNEL_DOCKER_RUN_TIMEOUT:-2400s}}"

docker_e2e_build_or_reuse "$IMAGE_NAME" bundled-channel-deps "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "$DOCKER_TARGET"

prepare_package_tgz() {
  if [ -n "$PACKAGE_TGZ" ]; then
    PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz bundled-channel-deps "$PACKAGE_TGZ")"
    return 0
  fi
  if [ "$HOST_BUILD" = "0" ] && [ -z "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}" ]; then
    echo "OPENCLAW_BUNDLED_CHANNEL_HOST_BUILD=0 requires OPENCLAW_CURRENT_PACKAGE_TGZ" >&2
    exit 1
  fi
  PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz bundled-channel-deps)"
}

prepare_package_tgz
docker_e2e_package_mount_args "$PACKAGE_TGZ"
docker_e2e_harness_mount_args

run_bundled_channel_runtime_dep_scenarios
