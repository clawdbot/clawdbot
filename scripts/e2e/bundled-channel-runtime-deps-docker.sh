#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"

IMAGE_NAME="${OPENCLAW_BUNDLED_CHANNEL_DEPS_E2E_IMAGE:-openclaw-bundled-channel-deps-e2e}"

echo "Building Docker image..."
run_logged bundled-channel-deps-build docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR"

run_channel_scenario() {
  local channel="$1"
  local dep_sentinel="$2"
  local run_log
  run_log="$(mktemp "${TMPDIR:-/tmp}/openclaw-bundled-channel-deps-$channel.XXXXXX")"

  echo "Running bundled $channel runtime deps Docker E2E..."
  if ! docker run --rm \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e OPENCLAW_CHANNEL_UNDER_TEST="$channel" \
    -e OPENCLAW_DEP_SENTINEL="$dep_sentinel" \
    -i "$IMAGE_NAME" bash -s >"$run_log" 2>&1 <<'EOF'
set -euo pipefail

export HOME="$(mktemp -d "/tmp/openclaw-bundled-channel-deps.XXXXXX")"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENAI_API_KEY="sk-openclaw-bundled-channel-deps-e2e"
export OPENCLAW_NO_ONBOARD=1

TOKEN="bundled-channel-deps-token"
PORT="18789"
CHANNEL="${OPENCLAW_CHANNEL_UNDER_TEST:?missing OPENCLAW_CHANNEL_UNDER_TEST}"
DEP_SENTINEL="${OPENCLAW_DEP_SENTINEL:?missing OPENCLAW_DEP_SENTINEL}"
gateway_pid=""

cleanup() {
  if [ -n "${gateway_pid:-}" ] && kill -0 "$gateway_pid" 2>/dev/null; then
    kill "$gateway_pid" 2>/dev/null || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "Packing and installing current OpenClaw build..."
pack_dir="$(mktemp -d "/tmp/openclaw-pack.XXXXXX")"
npm pack --ignore-scripts --pack-destination "$pack_dir" >/tmp/openclaw-pack.log 2>&1
package_tgz="$(find "$pack_dir" -maxdepth 1 -name 'openclaw-*.tgz' -print -quit)"
if [ -z "$package_tgz" ]; then
  cat /tmp/openclaw-pack.log
  echo "missing packed OpenClaw tarball" >&2
  exit 1
fi
npm install -g "$package_tgz" --no-fund --no-audit >/tmp/openclaw-install.log 2>&1

command -v openclaw >/dev/null
package_root="$(npm root -g)/openclaw"
test -d "$package_root/dist/extensions/telegram"
test -d "$package_root/dist/extensions/discord"

if [ -d "$package_root/dist/extensions/telegram/node_modules" ]; then
  echo "telegram runtime deps should not be preinstalled in package" >&2
  find "$package_root/dist/extensions/telegram/node_modules" -maxdepth 2 -type f | head -20 >&2 || true
  exit 1
fi
if [ -d "$package_root/dist/extensions/discord/node_modules" ]; then
  echo "discord runtime deps should not be preinstalled in package" >&2
  find "$package_root/dist/extensions/discord/node_modules" -maxdepth 2 -type f | head -20 >&2 || true
  exit 1
fi

write_config() {
  local mode="$1"
  node - <<'NODE' "$mode" "$TOKEN" "$PORT"
const fs = require("node:fs");
const path = require("node:path");

const mode = process.argv[2];
const token = process.argv[3];
const port = Number(process.argv[4]);
const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : {};

config.gateway = {
  ...(config.gateway || {}),
  port,
  auth: { mode: "token", token },
  controlUi: { enabled: false },
};
config.agents = {
  ...(config.agents || {}),
  defaults: {
    ...(config.agents?.defaults || {}),
    model: { primary: "openai/gpt-4.1-mini" },
  },
};
config.models = {
  ...(config.models || {}),
  providers: {
    ...(config.models?.providers || {}),
    openai: {
      ...(config.models?.providers?.openai || {}),
      apiKey: process.env.OPENAI_API_KEY,
      baseUrl: "https://api.openai.com/v1",
      models: [],
    },
  },
};
config.plugins = {
  ...(config.plugins || {}),
  enabled: true,
};

if (mode === "telegram") {
  config.channels = {
    ...(config.channels || {}),
    telegram: {
      ...(config.channels?.telegram || {}),
      enabled: true,
      dmPolicy: "disabled",
      groupPolicy: "disabled",
    },
  };
}
if (mode === "discord") {
  config.channels = {
    ...(config.channels || {}),
    discord: {
      ...(config.channels?.discord || {}),
      enabled: true,
      dmPolicy: "disabled",
      groupPolicy: "disabled",
    },
  };
}

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE
}

start_gateway() {
  local log_file="$1"
  : >"$log_file"
  openclaw gateway --port "$PORT" --bind loopback --allow-unconfigured >"$log_file" 2>&1 &
  gateway_pid="$!"

  for _ in $(seq 1 240); do
    if grep -Eq "listening on ws://|\\[gateway\\] ready \\(" "$log_file"; then
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

stop_gateway() {
  if [ -n "${gateway_pid:-}" ] && kill -0 "$gateway_pid" 2>/dev/null; then
    kill "$gateway_pid" 2>/dev/null || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
  gateway_pid=""
}

wait_for_gateway_health() {
  for _ in $(seq 1 120); do
    if openclaw gateway health --url "ws://127.0.0.1:$PORT" --token "$TOKEN" --json >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "timed out waiting for gateway health" >&2
  return 1
}

assert_channel_status() {
  local channel="$1"
  local out="/tmp/openclaw-channel-status-$channel.json"
  openclaw gateway call channels.status \
    --url "ws://127.0.0.1:$PORT" \
    --token "$TOKEN" \
    --timeout 30000 \
    --json \
    --params '{"probe":false}' >"$out"
  node - <<'NODE' "$out" "$channel"
const fs = require("node:fs");
const raw = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const payload = raw.result ?? raw.data ?? raw;
const channel = process.argv[3];
const dump = () => JSON.stringify(raw, null, 2).slice(0, 4000);
const hasChannelMeta = Array.isArray(payload.channelMeta)
  ? payload.channelMeta.some((entry) => entry?.id === channel)
  : Boolean(payload.channelMeta?.[channel]);
if (!hasChannelMeta) {
  throw new Error(`missing channelMeta.${channel}\n${dump()}`);
}
if (!payload.channels || !payload.channels[channel]) {
  throw new Error(`missing channels.${channel}\n${dump()}`);
}
const accounts = payload.channelAccounts?.[channel];
if (!Array.isArray(accounts) || accounts.length === 0) {
  throw new Error(`missing channelAccounts.${channel}\n${dump()}`);
}
console.log(`${channel} channel plugin visible`);
NODE
}

assert_installed_once() {
  local log_file="$1"
  local channel="$2"
  local count
  count="$(grep -c "\\[plugins\\] $channel installed bundled runtime deps:" "$log_file" || true)"
  if [ "$count" -ne 1 ]; then
    echo "expected exactly one runtime deps install for $channel, got $count" >&2
    cat "$log_file" >&2
    exit 1
  fi
}

assert_not_installed() {
  local log_file="$1"
  local channel="$2"
  if grep -q "\\[plugins\\] $channel installed bundled runtime deps:" "$log_file"; then
    echo "expected no runtime deps reinstall for $channel" >&2
    cat "$log_file" >&2
    exit 1
  fi
}

assert_dep_sentinel() {
  local channel="$1"
  local dep_path="$2"
  if [ ! -f "$package_root/dist/extensions/$channel/node_modules/$dep_path/package.json" ]; then
    echo "missing dependency sentinel for $channel: $dep_path" >&2
    find "$package_root/dist/extensions/$channel" -maxdepth 3 -type f | sort | head -80 >&2 || true
    exit 1
  fi
}

echo "Starting baseline gateway with OpenAI configured..."
write_config baseline
start_gateway "/tmp/openclaw-$CHANNEL-baseline.log"
wait_for_gateway_health
stop_gateway

echo "Enabling $CHANNEL by config edit, then restarting gateway..."
write_config "$CHANNEL"
start_gateway "/tmp/openclaw-$CHANNEL-first.log"
wait_for_gateway_health
assert_installed_once "/tmp/openclaw-$CHANNEL-first.log" "$CHANNEL"
assert_dep_sentinel "$CHANNEL" "$DEP_SENTINEL"
assert_channel_status "$CHANNEL"
stop_gateway

echo "Restarting gateway again; $CHANNEL deps must stay installed..."
start_gateway "/tmp/openclaw-$CHANNEL-second.log"
wait_for_gateway_health
assert_not_installed "/tmp/openclaw-$CHANNEL-second.log" "$CHANNEL"
assert_channel_status "$CHANNEL"
stop_gateway

echo "bundled $CHANNEL runtime deps Docker E2E passed"
EOF
  then
    cat "$run_log"
    rm -f "$run_log"
    exit 1
  fi

  cat "$run_log"
  rm -f "$run_log"
}

run_channel_scenario telegram grammy
run_channel_scenario discord discord-api-types
