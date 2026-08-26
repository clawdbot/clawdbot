#!/usr/bin/env bash
# Installs a prepared OpenClaw npm tarball in Docker, runs OpenAI onboarding,
# and verifies the Codex plugin plus @openai/codex dependency are downloaded on demand.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-codex-on-demand-e2e" OPENCLAW_CODEX_ON_DEMAND_E2E_IMAGE)"
DOCKER_TARGET="${OPENCLAW_CODEX_ON_DEMAND_DOCKER_TARGET:-bare}"
HOST_BUILD="${OPENCLAW_CODEX_ON_DEMAND_HOST_BUILD:-1}"
PACKAGE_TGZ="${OPENCLAW_CURRENT_PACKAGE_TGZ:-}"
PREPUBLISH_PLUGIN_REGISTRY_ARGS=()
AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT=""
run_log=""

# This lane installs the package and then exercises a managed npm install of Codex.
# Keep the package install budget above the shared default so slow npm hosts reach
# the Codex assertions instead of failing as a silent package-install timeout.
export OPENCLAW_E2E_NPM_INSTALL_TIMEOUT="${OPENCLAW_E2E_NPM_INSTALL_TIMEOUT:-1200s}"

configure_prepublish_plugin_registry() {
  local registry_dir="$1"
  local resolved_registry_dir
  resolved_registry_dir="$(cd "$registry_dir" && pwd)"
  if [ ! -f "$resolved_registry_dir/prepublish-plugin-registry.json" ]; then
    echo "Prepublish plugin registry manifest is missing." >&2
    exit 1
  fi
  PREPUBLISH_PLUGIN_REGISTRY_ARGS=(
    -e OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR=/tmp/openclaw-prepublish-plugin-registry
    -v "$resolved_registry_dir:/tmp/openclaw-prepublish-plugin-registry:ro"
  )
}
if [ -n "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ]; then
  configure_prepublish_plugin_registry "$OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR"
fi

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
  configure_prepublish_plugin_registry \
    "$AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT/prepublish-plugin-registry"
fi

docker_e2e_package_mount_args "$PACKAGE_TGZ"
run_log="$(docker_e2e_run_log codex-on-demand)"
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 codex-on-demand empty)"

echo "Running Codex on-demand Docker E2E..."
if ! docker_e2e_run_with_harness \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  ${PREPUBLISH_PLUGIN_REGISTRY_ARGS[@]+"${PREPUBLISH_PLUGIN_REGISTRY_ARGS[@]}"} \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  -i "$IMAGE_NAME" bash -s >"$run_log" 2>&1 <<'EOF'; then
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
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
  [ -n "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ] || return 0
  local registry_root="/tmp/openclaw-codex-registry"
  local manifest="$OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR/prepublish-plugin-registry.json"
  local package_name package_version package_tarball
  IFS=$'\t' read -r package_name package_version package_tarball < <(
    PREPUBLISH_PLUGIN_REGISTRY_MANIFEST="$manifest" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const manifestPath = process.env.PREPUBLISH_PLUGIN_REGISTRY_MANIFEST;
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const matches = Array.isArray(manifest.packages)
  ? manifest.packages.filter((entry) => entry?.name === "@openclaw/codex")
  : [];
if (matches.length !== 1) {
  throw new Error("prepublish plugin registry must contain exactly one @openclaw/codex package");
}
const entry = matches[0];
if (
  typeof entry.version !== "string" ||
  typeof entry.tarball !== "string" ||
  path.basename(entry.tarball) !== entry.tarball
) {
  throw new Error("invalid @openclaw/codex prepublish plugin registry entry");
}
process.stdout.write(
  `${entry.name}\t${entry.version}\t${path.join(path.dirname(manifestPath), entry.tarball)}\n`,
);
NODE
  )
  mkdir -p "$registry_root"
  OPENCLAW_NPM_REGISTRY_DIST_TAGS="latest=0.0.0,beta=$package_version" \
  OPENCLAW_NPM_REGISTRY_UPSTREAM=https://registry.npmjs.org \
    node scripts/e2e/lib/plugins/npm-registry-server.mjs \
    "$registry_root/port" \
    "$package_name" "$package_version" "$package_tarball" \
    >"$registry_root/server.log" 2>&1 &
  plugin_registry_pid="$!"
  for _ in $(seq 1 100); do
    [ -s "$registry_root/port" ] && break
    openclaw_e2e_process_alive "$plugin_registry_pid" || break
    sleep 0.1
  done
  if [ ! -s "$registry_root/port" ]; then
    openclaw_e2e_print_log "$registry_root/server.log" >&2
    echo "Timed out waiting for Codex npm registry." >&2
    return 1
  fi
  export NPM_CONFIG_REGISTRY="http://127.0.0.1:$(cat "$registry_root/port")"
  export npm_config_registry="$NPM_CONFIG_REGISTRY"
}

mkdir -p "$NPM_CONFIG_PREFIX" "$XDG_CACHE_HOME" "$NPM_CONFIG_CACHE"
chmod 700 "$XDG_CACHE_HOME" "$NPM_CONFIG_CACHE" || true

openclaw_e2e_install_package /tmp/openclaw-install.log
command -v openclaw >/dev/null
openclaw_e2e_enable_openclaw_cli_timeout

openclaw_e2e_assert_dep_absent "@openclaw/codex" "$HOME/.openclaw" "$NPM_CONFIG_PREFIX"
openclaw_e2e_assert_dep_absent "@openai/codex" "$HOME/.openclaw" "$NPM_CONFIG_PREFIX"

configure_plugin_registry

echo "Running non-interactive OpenAI onboarding; Codex should install on demand..."
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

echo "Codex on-demand Docker E2E passed"
EOF
  docker_e2e_print_log "$run_log"
  exit 1
fi

echo "Codex on-demand Docker E2E passed"
