#!/usr/bin/env bash
#
# Runs disabled-config runtime-dependency isolation scenarios.
# Sourced by scripts/e2e/bundled-channel-runtime-deps-docker.sh.

run_disabled_config_scenario() {
  echo "Running bundled channel disabled-config runtime deps Docker E2E..."
  run_bundled_channel_container_with_state \
    bundled-channel-disabled-config \
    "$DOCKER_RUN_TIMEOUT" \
    bundled-channel-disabled-config \
    "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
    -i "$IMAGE_NAME" bash -s <<'EOF'
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
source scripts/e2e/lib/bundled-channel/common.sh
openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_PLUGIN_STAGE_DIR="$HOME/.openclaw/plugin-runtime-deps"
mkdir -p "$OPENCLAW_PLUGIN_STAGE_DIR"

assert_dep_absent_everywhere() {
  local channel="$1"
  local dep_path="$2"
  local root="$3"
  bundled_channel_assert_no_package_dep_available "$channel" "$dep_path" "$root"
  bundled_channel_assert_no_staged_manifest_spec "$channel" "$dep_path" /tmp/openclaw-disabled-config-doctor.log
}

bundled_channel_install_package /tmp/openclaw-disabled-config-install.log

root="$(bundled_channel_package_root)"
test -d "$root/dist/extensions/telegram"
test -d "$root/dist/extensions/discord"
test -d "$root/dist/extensions/slack"
rm -rf "$root/dist/extensions/telegram/node_modules"
rm -rf "$root/dist/extensions/discord/node_modules"
rm -rf "$root/dist/extensions/slack/node_modules"

bundled_channel_write_config disabled-config

if ! openclaw doctor --non-interactive >/tmp/openclaw-disabled-config-doctor.log 2>&1; then
  echo "doctor failed for disabled-config runtime deps smoke" >&2
  cat /tmp/openclaw-disabled-config-doctor.log >&2
  exit 1
fi

assert_dep_absent_everywhere telegram grammy "$root"
assert_dep_absent_everywhere slack @slack/web-api "$root"
assert_dep_absent_everywhere discord discord-api-types "$root"

if grep -Eq "(grammy|@slack/web-api|discord-api-types)" /tmp/openclaw-disabled-config-doctor.log; then
  echo "doctor installed runtime deps for an explicitly disabled channel/plugin" >&2
  cat /tmp/openclaw-disabled-config-doctor.log >&2
  exit 1
fi

echo "bundled channel disabled-config runtime deps Docker E2E passed"
EOF
}
