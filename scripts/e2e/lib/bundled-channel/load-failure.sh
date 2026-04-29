#!/usr/bin/env bash
#
# Runs load-failure isolation scenarios.
# Sourced by scripts/e2e/bundled-channel-runtime-deps-docker.sh.

run_load_failure_scenario() {
  echo "Running bundled channel load-failure isolation Docker E2E..."
  run_bundled_channel_container_with_state \
    bundled-channel-load-failure \
    "$DOCKER_RUN_TIMEOUT" \
    bundled-channel-load-failure \
    "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
    -i "$IMAGE_NAME" bash -s <<'EOF'
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
source scripts/e2e/lib/bundled-channel/common.sh
openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENCLAW_NO_ONBOARD=1

bundled_channel_install_package /tmp/openclaw-load-failure-install.log

root="$(bundled_channel_package_root)"
plugin_dir="$root/dist/extensions/load-failure-alpha"
mkdir -p "$plugin_dir"
cat >"$plugin_dir/package.json" <<'JSON'
{
  "name": "@openclaw/load-failure-alpha",
  "version": "2026.4.21",
  "private": true,
  "type": "module",
  "openclaw": {
    "extensions": ["./index.js"],
    "setupEntry": "./setup-entry.js"
  }
}
JSON
cat >"$plugin_dir/openclaw.plugin.json" <<'JSON'
{
  "id": "load-failure-alpha",
  "channels": ["load-failure-alpha"],
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {}
  }
}
JSON
cat >"$plugin_dir/index.js" <<'JS'
export default {
  kind: "bundled-channel-entry",
  id: "load-failure-alpha",
  name: "Load Failure Alpha",
  description: "Load Failure Alpha",
  register() {},
  loadChannelSecrets() {
    globalThis.__loadFailureSecrets = (globalThis.__loadFailureSecrets ?? 0) + 1;
    throw new Error("synthetic channel secrets failure");
  },
  loadChannelPlugin() {
    globalThis.__loadFailurePlugin = (globalThis.__loadFailurePlugin ?? 0) + 1;
    throw new Error("synthetic channel plugin failure");
  }
};
JS
cat >"$plugin_dir/setup-entry.js" <<'JS'
export default {
  kind: "bundled-channel-setup-entry",
  loadSetupSecrets() {
    globalThis.__loadFailureSetupSecrets = (globalThis.__loadFailureSetupSecrets ?? 0) + 1;
    throw new Error("synthetic setup secrets failure");
  },
  loadSetupPlugin() {
    globalThis.__loadFailureSetup = (globalThis.__loadFailureSetup ?? 0) + 1;
    throw new Error("synthetic setup plugin failure");
  }
};
JS

echo "Loading synthetic failing bundled channel through packaged loader..."
node scripts/e2e/lib/bundled-channel/loader-probe.mjs load-failure "$root" load-failure-alpha

echo "bundled channel load-failure isolation Docker E2E passed"
EOF
}
