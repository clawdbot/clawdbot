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
node scripts/e2e/lib/bundled-channel/write-load-failure-fixture.mjs "$plugin_dir"

echo "Loading synthetic failing bundled channel through packaged loader..."
node scripts/e2e/lib/bundled-channel/loader-probe.mjs load-failure "$root" load-failure-alpha

echo "bundled channel load-failure isolation Docker E2E passed"
EOF
}
