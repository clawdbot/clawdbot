#!/usr/bin/env bash
# Installs OpenClaw and Codex from npm artifacts with explicit capability consent,
# then verifies OpenAI onboarding, managed dependencies, and doctor in Docker.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"
source "$ROOT_DIR/scripts/e2e/lib/prepublish-plugin-registry.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-codex-on-demand-e2e" OPENCLAW_CODEX_ON_DEMAND_E2E_IMAGE)"
DOCKER_TARGET="${OPENCLAW_CODEX_ON_DEMAND_DOCKER_TARGET:-bare}"
HOST_BUILD="${OPENCLAW_CODEX_ON_DEMAND_HOST_BUILD:-1}"
PACKAGE_TGZ="${OPENCLAW_CURRENT_PACKAGE_TGZ:-}"
AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT=""
run_log=""

# This lane installs the package and then exercises a managed npm install of Codex.
# Keep the package install budget above the shared default so slow npm hosts reach
# the Codex assertions instead of failing as a silent package-install timeout.
export OPENCLAW_E2E_NPM_INSTALL_TIMEOUT="${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-1200s}"

cleanup() {
  if [ -n "${PACKAGE_TGZ:-}" ]; then
    docker_e2e_cleanup_package_tgz "$PACKAGE_TGZ"
  fi
  if [ -n "$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT" ]; then
    rm -rf "$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT"
  fi
  if [ -n "${run_log:-}" ]; then
    rm -f "$run_log"
  fi
}
trap cleanup EXIT

docker_e2e_build_or_reuse "$IMAGE_NAME" codex-on-demand "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "$DOCKER_TARGET"

prepare_package_tgz() {
  if [ -n "$PACKAGE_TGZ" ]; then
    PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz codex-on-demand "$PACKAGE_TGZ")"
    return 0
  fi
  if [ "$HOST_BUILD" = "0" ] && [ -z "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}" ]; then
    echo "OPENCLAW_CODEX_ON_DEMAND_HOST_BUILD=0 requires OPENCLAW_CURRENT_PACKAGE_TGZ" >&2
    exit 1
  fi
  PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz codex-on-demand)"
}

prepare_package_tgz

if [ -z "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ] &&
  [ -z "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}" ] &&
  [ "$HOST_BUILD" != "0" ]; then
  AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT="$(
    mktemp -d "${TMPDIR:-/tmp}/openclaw-codex-on-demand-plugin-registry.XXXXXX"
  )"
  OPENCLAW_DOCKER_ALL_LANES=codex-on-demand \
    OPENCLAW_DOCKER_ALL_LOG_DIR="$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT" \
    OPENCLAW_DOCKER_ALL_TIMINGS=0 \
    node "$ROOT_DIR/scripts/test-docker-all.mjs" --prepare-plugin-registry >/dev/null
  export OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR="$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT/prepublish-plugin-registry"
fi

docker_e2e_package_mount_args "$PACKAGE_TGZ"
run_log="$(docker_e2e_run_log codex-on-demand)"
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 codex-on-demand empty)"

echo "Running Codex on-demand Docker E2E..."
if ! docker_e2e_run_with_harness \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  -i "$IMAGE_NAME" bash -s >"$run_log" 2>&1 <<'EOF'; then
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
source scripts/e2e/lib/prepublish-plugin-registry.sh
openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export npm_config_prefix="$NPM_CONFIG_PREFIX"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$XDG_CACHE_HOME/npm}"
export npm_config_cache="$NPM_CONFIG_CACHE"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENAI_API_KEY="sk-openclaw-codex-on-demand-e2e"

dump_debug_logs() {
  local status="$1"
  echo "Codex on-demand scenario failed with exit code $status" >&2
  openclaw_e2e_dump_logs \
    /tmp/openclaw-install.log \
    /tmp/openclaw-codex-plugin-install.log \
    /tmp/openclaw-codex-registry/server.log \
    /tmp/openclaw-onboard.json \
    /tmp/openclaw-plugins-list.json \
    /tmp/openclaw-codex-inspect.json
}
trap 'status=$?; dump_debug_logs "$status"; exit "$status"' ERR

plugin_registry_pid=""
cleanup_inner() {
  openclaw_e2e_stop_process "${plugin_registry_pid:-}"
}
trap cleanup_inner EXIT

configure_plugin_registry() {
  openclaw_prepublish_plugin_registry_start_mounted \
    /tmp/openclaw-codex-registry plugin_registry_pid '["@openclaw/codex"]'
}

mkdir -p "$NPM_CONFIG_PREFIX" "$XDG_CACHE_HOME" "$NPM_CONFIG_CACHE"
chmod 700 "$XDG_CACHE_HOME" "$NPM_CONFIG_CACHE" || true

openclaw_e2e_install_package /tmp/openclaw-install.log
command -v openclaw >/dev/null
openclaw_e2e_enable_openclaw_cli_timeout

openclaw_e2e_assert_dep_absent "@openclaw/codex" "$HOME/.openclaw" "$NPM_CONFIG_PREFIX"
openclaw_e2e_assert_dep_absent "@openai/codex" "$HOME/.openclaw" "$NPM_CONFIG_PREFIX"

configure_plugin_registry

# Non-interactive onboarding cannot grant capabilities. Use the shared fixture
# consent flow and the exact companion when testing an unpublished candidate.
codex_install_args=("@openclaw/codex")
if [ -n "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ]; then
  codex_install_args=("npm:@openclaw/codex@${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION:?missing candidate version}" --pin)
fi
echo "Installing Codex on demand with explicit capability consent..."
openclaw_e2e_fixture_plugin_command openclaw -- plugins install "${codex_install_args[@]}" \
  >/tmp/openclaw-codex-plugin-install.log 2>&1

echo "Running non-interactive OpenAI onboarding with the accepted Codex plugin..."
openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice openai-api-key \
  --secret-input-mode ref \
  --skip-daemon \
  --skip-ui \
  --skip-channels \
  --skip-skills \
  --skip-health \
  --json >/tmp/openclaw-onboard.json

openclaw plugins list --json >/tmp/openclaw-plugins-list.json
openclaw plugins inspect codex --runtime --json >/tmp/openclaw-codex-inspect.json
node scripts/e2e/lib/codex-on-demand/assertions.mjs
node scripts/e2e/lib/codex-on-demand/doctor-checks.mjs

echo "Codex on-demand Docker E2E passed"
EOF
  docker_e2e_print_log "$run_log"
  exit 1
fi

docker_e2e_print_log "$run_log"
echo "Codex on-demand Docker E2E passed"
