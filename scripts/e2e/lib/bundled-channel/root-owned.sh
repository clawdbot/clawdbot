#!/usr/bin/env bash
#
# Runs the root-owned global install runtime-dependency scenario.
# Sourced by scripts/e2e/bundled-channel-runtime-deps-docker.sh.

run_root_owned_global_scenario() {
  local run_log
  run_log="$(docker_e2e_run_log bundled-channel-root-owned)"

  echo "Running bundled channel root-owned global install Docker E2E..."
  if ! timeout "$DOCKER_RUN_TIMEOUT" docker run --rm --user root \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
    -i "$IMAGE_NAME" bash -s >"$run_log" 2>&1 <<'EOF'
set -euo pipefail

export HOME="/root"
export OPENAI_API_KEY="sk-openclaw-bundled-channel-root-owned-e2e"
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_PLUGIN_STAGE_DIR="/var/lib/openclaw/plugin-runtime-deps"

TOKEN="bundled-channel-root-owned-token"
PORT="18791"
CHANNEL="slack"
DEP_SENTINEL="@slack/web-api"
gateway_pid=""

package_root() {
  printf "%s/openclaw" "$(npm root -g)"
}

cleanup() {
  if [ -n "${gateway_pid:-}" ] && kill -0 "$gateway_pid" 2>/dev/null; then
    kill "$gateway_pid" 2>/dev/null || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "Installing mounted OpenClaw package into root-owned global npm..."
package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
if ! npm install -g "$package_tgz" --no-fund --no-audit >/tmp/openclaw-root-owned-install.log 2>&1; then
  echo "root-owned global npm install failed" >&2
  cat /tmp/openclaw-root-owned-install.log >&2
  exit 1
fi

root="$(package_root)"
test -d "$root/dist/extensions/$CHANNEL"
rm -rf "$root/dist/extensions/$CHANNEL/node_modules"
chmod -R a-w "$root"
mkdir -p "$OPENCLAW_PLUGIN_STAGE_DIR" /home/appuser/.openclaw
chown -R appuser:appuser /home/appuser/.openclaw /var/lib/openclaw

if runuser -u appuser -- test -w "$root"; then
  echo "expected package root to be unwritable for appuser" >&2
  exit 1
fi

node - <<'NODE' "$TOKEN" "$PORT"
const fs = require("node:fs");
const path = require("node:path");
const token = process.argv[2];
const port = Number(process.argv[3]);
const configPath = "/home/appuser/.openclaw/openclaw.json";
const config = {
  gateway: {
    port,
    auth: { mode: "token", token },
    controlUi: { enabled: false },
  },
  agents: {
    defaults: {
      model: { primary: "openai/gpt-4.1-mini" },
    },
  },
  models: {
    providers: {
      openai: {
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: "https://api.openai.com/v1",
        models: [],
      },
    },
  },
  plugins: { enabled: true },
  channels: {
    slack: {
      enabled: true,
      botToken: "xoxb-bundled-channel-root-owned-token",
      appToken: "xapp-bundled-channel-root-owned-token",
    },
  },
};
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE
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

if [ -e "$root/dist/extensions/$CHANNEL/node_modules/$DEP_SENTINEL/package.json" ]; then
  echo "root-owned package tree was mutated" >&2
  find "$root/dist/extensions/$CHANNEL/node_modules" -maxdepth 4 -type f | sort | head -80 >&2 || true
  exit 1
fi
if ! find "$OPENCLAW_PLUGIN_STAGE_DIR" -maxdepth 12 -path "*/node_modules/$DEP_SENTINEL/package.json" -type f | grep -q .; then
  echo "missing external staged dependency sentinel for $DEP_SENTINEL" >&2
  find "$OPENCLAW_PLUGIN_STAGE_DIR" -maxdepth 12 -type f | sort | head -120 >&2 || true
  cat /tmp/openclaw-root-owned-gateway.log >&2
  exit 1
fi
if [ -e "$root/dist/extensions/node_modules/openclaw/package.json" ]; then
  echo "root-owned package tree was mutated with SDK alias" >&2
  find "$root/dist/extensions/node_modules/openclaw" -maxdepth 4 -type f | sort | head -80 >&2 || true
  exit 1
fi
if ! find "$OPENCLAW_PLUGIN_STAGE_DIR" -maxdepth 12 -path "*/dist/extensions/node_modules/openclaw/package.json" -type f | grep -q .; then
  echo "missing external staged openclaw/plugin-sdk alias" >&2
  find "$OPENCLAW_PLUGIN_STAGE_DIR" -maxdepth 12 -type f | sort | head -120 >&2 || true
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
  then
    docker_e2e_print_log "$run_log"
    rm -f "$run_log"
    exit 1
  fi

  docker_e2e_print_log "$run_log"
  rm -f "$run_log"
}
