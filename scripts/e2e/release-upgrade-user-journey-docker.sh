#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
# Published-baseline-to-candidate release user journey smoke.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-release-upgrade-user-journey-e2e" OPENCLAW_RELEASE_UPGRADE_USER_JOURNEY_E2E_IMAGE)"
SKIP_BUILD="${OPENCLAW_RELEASE_UPGRADE_USER_JOURNEY_E2E_SKIP_BUILD:-0}"
run_log=""
cleanup() {
  docker_e2e_cleanup_package_tgz "${PACKAGE_TGZ:-}"
  if [ -n "${run_log:-}" ]; then
    rm -f "$run_log"
  fi
}
trap cleanup EXIT

PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz release-upgrade-user-journey "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}")"
docker_e2e_package_mount_args "$PACKAGE_TGZ"

docker_e2e_build_or_reuse "$IMAGE_NAME" release-upgrade-user-journey "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "bare" "$SKIP_BUILD"
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 release-upgrade-user-journey empty)"

run_log="$(docker_e2e_run_log release-upgrade-user-journey)"
DOCKER_ENV_ARGS=(
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64"
)
ARTIFACT_ROOT="${OPENCLAW_RELEASE_UPGRADE_ARTIFACT_DIR:-$ROOT_DIR/.artifacts/release-upgrade-user-journey}"
mkdir -p "$ARTIFACT_ROOT"
ARTIFACT_DIR="$(mktemp -d "$ARTIFACT_ROOT/run.XXXXXX")"
chmod a+rwx "$ARTIFACT_DIR"
DOCKER_ENV_ARGS+=(
  -e OPENCLAW_RELEASE_UPGRADE_ARTIFACT_DIR=/tmp/release-upgrade-evidence
  -v "$(docker_e2e_abs_path "$ARTIFACT_DIR"):/tmp/release-upgrade-evidence"
)
if [ -n "${OPENCLAW_RELEASE_UPGRADE_BASELINE_SPEC:-}" ]; then
  DOCKER_ENV_ARGS+=(-e "OPENCLAW_RELEASE_UPGRADE_BASELINE_SPEC=$OPENCLAW_RELEASE_UPGRADE_BASELINE_SPEC")
fi

echo "Running release upgrade user journey Docker E2E..."
if ! docker_e2e_run_with_harness \
  "${DOCKER_ENV_ARGS[@]}" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  -i "$IMAGE_NAME" bash scripts/e2e/lib/release-upgrade-user-journey/scenario.sh >"$run_log" 2>&1; then
  docker_e2e_print_log "$run_log"
  exit 1
fi

echo "Release upgrade user journey Docker E2E passed. Evidence: $ARTIFACT_DIR"
