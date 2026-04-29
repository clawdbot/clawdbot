#!/usr/bin/env bash
#
# Runs the root-owned global install runtime-dependency scenario.
# Sourced by scripts/e2e/bundled-channel-runtime-deps-docker.sh.

run_root_owned_global_scenario() {
  echo "Running bundled channel root-owned global install Docker E2E..."
  run_bundled_channel_container bundled-channel-root-owned "$DOCKER_RUN_TIMEOUT" \
    --user root \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
    -i "$IMAGE_NAME" bash -s <<'EOF'
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
source scripts/e2e/lib/bundled-channel/common.sh
export HOME="/root"
export OPENAI_API_KEY="sk-openclaw-bundled-channel-root-owned-e2e"
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_PLUGIN_STAGE_DIR="/var/lib/openclaw/plugin-runtime-deps"

TOKEN="bundled-channel-root-owned-token"
PORT="18791"
CHANNEL="slack"
DEP_SENTINEL="@slack/web-api"
gateway_pid=""

cleanup() {
  if [ -n "${gateway_pid:-}" ] && kill -0 "$gateway_pid" 2>/dev/null; then
    kill "$gateway_pid" 2>/dev/null || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

bundled_channel_install_package /tmp/openclaw-root-owned-install.log "mounted OpenClaw package into root-owned global npm"

root="$(bundled_channel_package_root)"
test -d "$root/dist/extensions/$CHANNEL"
rm -rf "$root/dist/extensions/$CHANNEL/node_modules"
chmod -R a-w "$root"
mkdir -p "$OPENCLAW_PLUGIN_STAGE_DIR" /home/appuser/.openclaw
chown -R appuser:appuser /home/appuser/.openclaw /var/lib/openclaw

if runuser -u appuser -- test -w "$root"; then
  echo "expected package root to be unwritable for appuser" >&2
  exit 1
fi

OPENCLAW_BUNDLED_CHANNEL_CONFIG_PATH=/home/appuser/.openclaw/openclaw.json \
  OPENCLAW_BUNDLED_CHANNEL_SLACK_BOT_TOKEN=xoxb-bundled-channel-root-owned-token \
  OPENCLAW_BUNDLED_CHANNEL_SLACK_APP_TOKEN=xapp-bundled-channel-root-owned-token \
  bundled_channel_write_config slack
chown appuser:appuser /home/appuser/.openclaw/openclaw.json

start_gateway() {
  local log_file="$1"
  : >"$log_file"
  chown appuser:appuser "$log_file"
  runuser -u appuser -- env \
    HOME=/home/appuser \
    OPENAI_API_KEY="$OPENAI_API_KEY" \
    OPENCLAW_NO_ONBOARD=1 \
    OPENCLAW_PLUGIN_STAGE_DIR="$OPENCLAW_PLUGIN_STAGE_DIR" \
    npm_config_cache=/tmp/openclaw-root-owned-npm-cache \
    bash -c 'openclaw gateway --port "$1" --bind loopback --allow-unconfigured >"$2" 2>&1' \
    bash "$PORT" "$log_file" &
  gateway_pid="$!"

  # Cold bundled dependency staging can exceed 60s under 10-way Docker aggregate load.
  for _ in $(seq 1 1200); do
    if grep -Eq "listening on ws://|\\[gateway\\] http server listening|\\[gateway\\] ready( \\(|$)" "$log_file"; then
      return 0
    fi
    if ! kill -0 "$gateway_pid" 2>/dev/null; then
      echo "gateway exited unexpectedly" >&2
      cat "$log_file" >&2
      exit 1
    fi
    sleep 0.25
  done

  echo "timed out waiting for gateway" >&2
  cat "$log_file" >&2
  exit 1
}

wait_for_slack_provider_start() {
  for _ in $(seq 1 180); do
    if grep -Eq "\\[slack\\] \\[default\\] starting provider|An API error occurred: invalid_auth|\\[plugins\\] slack installed bundled runtime deps|\\[gateway\\] ready \\(.*\\bslack\\b" /tmp/openclaw-root-owned-gateway.log; then
      return 0
    fi
    sleep 1
  done
  echo "timed out waiting for slack provider startup" >&2
  cat /tmp/openclaw-root-owned-gateway.log >&2
  exit 1
}

start_gateway /tmp/openclaw-root-owned-gateway.log
wait_for_slack_provider_start

bundled_channel_assert_no_package_dep_available "$CHANNEL" "$DEP_SENTINEL" "$root"
bundled_channel_assert_staged_dep "$CHANNEL" "$DEP_SENTINEL" /tmp/openclaw-root-owned-gateway.log
if [ -e "$root/dist/extensions/node_modules/openclaw/package.json" ]; then
  echo "root-owned package tree was mutated with SDK alias" >&2
  find "$root/dist/extensions/node_modules/openclaw" -maxdepth 4 -type f | sort | head -80 >&2 || true
  exit 1
fi
if ! find "$(bundled_channel_stage_dir)" -maxdepth 12 -path "*/dist/extensions/node_modules/openclaw/package.json" -type f | grep -q .; then
  echo "missing external staged openclaw/plugin-sdk alias" >&2
  bundled_channel_dump_stage_dir
  cat /tmp/openclaw-root-owned-gateway.log >&2
  exit 1
fi
if grep -Eq "failed to install bundled runtime deps|Cannot find package 'openclaw'|Cannot find module 'openclaw/plugin-sdk'" /tmp/openclaw-root-owned-gateway.log; then
  echo "root-owned gateway hit bundled runtime dependency errors" >&2
  cat /tmp/openclaw-root-owned-gateway.log >&2
  exit 1
fi

echo "root-owned global install Docker E2E passed"
EOF
}
