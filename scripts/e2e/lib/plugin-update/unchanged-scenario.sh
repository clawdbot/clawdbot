#!/usr/bin/env bash
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh

openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
openclaw_e2e_install_package /tmp/openclaw-install.log "mounted OpenClaw package" /tmp/npm-prefix

package_root="$(openclaw_e2e_package_root /tmp/npm-prefix)"
entry="$(openclaw_e2e_package_entrypoint "$package_root")"
probe="scripts/e2e/lib/plugin-update/probe.mjs"
package_version="$(node -p "require('$package_root/package.json').version")"
OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT="$(node "$probe" legacy-compat "$package_version")"
export OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT
export NPM_CONFIG_REGISTRY=http://127.0.0.1:4873
export PATH="/tmp/npm-prefix/bin:$PATH"

node "$probe" seed

node scripts/e2e/lib/plugin-update/registry-server.mjs >/tmp/openclaw-e2e-registry.log 2>&1 &
registry_pid=$!
trap 'kill "$registry_pid" >/dev/null 2>&1 || true' EXIT

if ! node "$probe" wait-registry; then
  echo "Local npm metadata registry failed to start"
  cat /tmp/openclaw-e2e-registry.log || true
  exit 1
fi

before_config_hash=""
if [ "$OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT" != "1" ]; then
  before_config_hash="$(sha256sum "$OPENCLAW_CONFIG_PATH" | awk '{print $1}')"
fi
plugin_update_timeout_seconds="${OPENCLAW_PLUGIN_UPDATE_TIMEOUT_SECONDS:-180}"

node "$probe" snapshot > /tmp/plugin-update-before.json

set +e
timeout "${plugin_update_timeout_seconds}s" node "$entry" plugins update @example/lossless-claw > /tmp/plugin-update-output.log 2>&1
plugin_update_status=$?
set -e
if [ "$plugin_update_status" -ne 0 ]; then
  echo "Plugin update command failed or timed out after ${plugin_update_timeout_seconds}s (status ${plugin_update_status})"
  echo "--- plugin update output ---"
  cat /tmp/plugin-update-output.log || true
  echo "--- local registry output ---"
  cat /tmp/openclaw-e2e-registry.log || true
  exit "$plugin_update_status"
fi

if [ -n "$before_config_hash" ]; then
  after_config_hash="$(sha256sum "$OPENCLAW_CONFIG_PATH" | awk '{print $1}')"
  if [ "$before_config_hash" != "$after_config_hash" ]; then
    echo "Config changed unexpectedly for modern package $package_version"
    cat /tmp/plugin-update-output.log
    exit 1
  fi
fi

node "$probe" assert-snapshot /tmp/plugin-update-before.json
node "$probe" assert-output /tmp/plugin-update-output.log
cat /tmp/plugin-update-output.log
