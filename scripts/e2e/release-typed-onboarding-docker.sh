#!/usr/bin/env bash
# Package-installed release onboarding smoke with real TTY keypresses and env-ref provider auth.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"
source "$ROOT_DIR/scripts/e2e/lib/prepublish-plugin-registry.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-release-typed-onboarding-e2e" OPENCLAW_RELEASE_TYPED_ONBOARDING_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_RELEASE_TYPED_ONBOARDING_E2E_SKIP_BUILD:-0}"
AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT=""
run_log=""
cleanup() {
  docker_e2e_cleanup_package_tgz "${PACKAGE_TGZ:-}"
  if [ -n "$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT" ]; then
    rm -rf "$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT"
  fi
  if [ -n "${run_log:-}" ]; then
    rm -f "$run_log"
  fi
}
trap cleanup EXIT

PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz release-typed-onboarding "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
if [ -z "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ] && [ -z "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}" ]; then
  # Source builds need matching companions; explicit package overrides keep their catalog source.
  AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT="$(
    mktemp -d "${TMPDIR:-/tmp}/openclaw-typed-onboarding-plugin-registry.XXXXXX"
  )"
  OPENCLAW_DOCKER_ALL_LANES=release-typed-onboarding \
    OPENCLAW_DOCKER_ALL_LOG_DIR="$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT" \
    OPENCLAW_DOCKER_ALL_TIMINGS=0 \
    node "$ROOT_DIR/scripts/test-docker-all.mjs" --prepare-plugin-registry >/dev/null
  export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR="$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT/prepublish-plugin-registry"
fi

docker_e2e_package_mount_args "$PACKAGE_TGZ"

docker_e2e_build_or_reuse "$IMAGE_NAME" release-typed-onboarding "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "$SKIP_BUILD"
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 release-typed-onboarding empty)"

run_log="$(docker_e2e_run_log release-typed-onboarding)"
echo "Running release typed onboarding Docker E2E..."
if ! docker_e2e_run_with_harness \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  -i "$IMAGE_NAME" bash scripts/e2e/lib/release-typed-onboarding/scenario.sh >"$run_log" 2>&1; then
  docker_e2e_print_log "$run_log"
  exit 1
fi

echo "Release typed onboarding Docker E2E passed."
