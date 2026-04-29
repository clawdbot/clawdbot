#!/usr/bin/env bash
#
# Runs setup-entry runtime-dependency installation scenarios.
# Sourced by scripts/e2e/bundled-channel-runtime-deps-docker.sh.

run_setup_entry_scenario() {
  echo "Running bundled channel setup-entry runtime deps Docker E2E..."
  run_bundled_channel_container_with_state \
    bundled-channel-setup-entry \
    "$DOCKER_RUN_TIMEOUT" \
    bundled-channel-setup-entry \
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

declare -A SETUP_ENTRY_DEP_SENTINELS=(
  [feishu]="@larksuiteoapi/node-sdk"
  [whatsapp]="@whiskeysockets/baileys"
)

bundled_channel_install_package /tmp/openclaw-setup-entry-install.log

root="$(bundled_channel_package_root)"
for channel in "${!SETUP_ENTRY_DEP_SENTINELS[@]}"; do
  dep_sentinel="${SETUP_ENTRY_DEP_SENTINELS[$channel]}"
  test -d "$root/dist/extensions/$channel"
  bundled_channel_assert_no_package_dep_available "$channel" "$dep_sentinel" "$root"
done

echo "Probing real bundled setup entries before channel configuration..."
node scripts/e2e/lib/bundled-channel/loader-probe.mjs setup-entries "$root" feishu whatsapp

for channel in "${!SETUP_ENTRY_DEP_SENTINELS[@]}"; do
  dep_sentinel="${SETUP_ENTRY_DEP_SENTINELS[$channel]}"
  bundled_channel_assert_no_package_dep_available "$channel" "$dep_sentinel" "$root"
  bundled_channel_assert_no_staged_dep "$channel" "$dep_sentinel" "setup-entry discovery installed $channel external staged deps before channel configuration"
done

echo "Running packaged guided WhatsApp setup; runtime deps should be staged before finalize..."
node scripts/e2e/lib/bundled-channel/guided-whatsapp-setup.mjs "$root"

bundled_channel_assert_no_package_dep_available whatsapp @whiskeysockets/baileys "$root"
bundled_channel_assert_staged_dep whatsapp @whiskeysockets/baileys

echo "Configuring setup-entry channels; doctor should now install bundled runtime deps externally..."
bundled_channel_write_config setup-entry-channels

openclaw doctor --non-interactive >/tmp/openclaw-setup-entry-doctor.log 2>&1

for channel in "${!SETUP_ENTRY_DEP_SENTINELS[@]}"; do
  dep_sentinel="${SETUP_ENTRY_DEP_SENTINELS[$channel]}"
  bundled_channel_assert_no_package_dep_available "$channel" "$dep_sentinel" "$root"
  bundled_channel_assert_staged_dep "$channel" "$dep_sentinel" /tmp/openclaw-setup-entry-doctor.log
done

echo "bundled channel setup-entry runtime deps Docker E2E passed"
EOF
}
