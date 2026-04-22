#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"

IMAGE_NAME="${OPENCLAW_BUNDLED_CHANNEL_DEPS_E2E_IMAGE:-openclaw-bundled-channel-deps-e2e}"
UPDATE_BASELINE_VERSION="${OPENCLAW_BUNDLED_CHANNEL_UPDATE_BASELINE_VERSION:-2026.4.20}"
RUN_CHANNEL_SCENARIOS="${OPENCLAW_BUNDLED_CHANNEL_SCENARIOS:-1}"
RUN_UPDATE_SCENARIO="${OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO:-1}"
RUN_ROOT_OWNED_SCENARIO="${OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO:-1}"
RUN_SETUP_ENTRY_SCENARIO="${OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO:-1}"

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
test -d "$package_root/dist/extensions/slack"

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
if [ -d "$package_root/dist/extensions/slack/node_modules" ]; then
  echo "slack runtime deps should not be preinstalled in package" >&2
  find "$package_root/dist/extensions/slack/node_modules" -maxdepth 2 -type f | head -20 >&2 || true
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
if (mode === "slack") {
  config.channels = {
    ...(config.channels || {}),
    slack: {
      ...(config.channels?.slack || {}),
      enabled: true,
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

run_root_owned_global_scenario() {
  local run_log
  run_log="$(mktemp "${TMPDIR:-/tmp}/openclaw-bundled-channel-root-owned.XXXXXX")"

  echo "Running bundled channel root-owned global install Docker E2E..."
  if ! docker run --rm --user root \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
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

echo "Packing and installing current OpenClaw build into root-owned global npm..."
pack_dir="$(mktemp -d "/tmp/openclaw-root-owned-pack.XXXXXX")"
npm pack --ignore-scripts --pack-destination "$pack_dir" >/tmp/openclaw-root-owned-pack.log 2>&1
package_tgz="$(find "$pack_dir" -maxdepth 1 -name 'openclaw-*.tgz' -print -quit)"
if [ -z "$package_tgz" ]; then
  cat /tmp/openclaw-root-owned-pack.log
  echo "missing packed OpenClaw tarball" >&2
  exit 1
fi
npm install -g "$package_tgz" --no-fund --no-audit >/tmp/openclaw-root-owned-install.log 2>&1

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

wait_for_gateway_health() {
  for _ in $(seq 1 120); do
    if runuser -u appuser -- env HOME=/home/appuser openclaw gateway health --url "ws://127.0.0.1:$PORT" --token "$TOKEN" --json >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done
  echo "timed out waiting for gateway health" >&2
  return 1
}

assert_channel_status() {
  local out="/tmp/openclaw-root-owned-channel-status.json"
  runuser -u appuser -- env HOME=/home/appuser openclaw gateway call channels.status \
    --url "ws://127.0.0.1:$PORT" \
    --token "$TOKEN" \
    --timeout 30000 \
    --json \
    --params '{"probe":false}' >"$out"
  if ! node - <<'NODE' "$out" "$CHANNEL"
const fs = require("node:fs");
const raw = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const payload = raw.result ?? raw.data ?? raw;
const channel = process.argv[3];
if (!payload.channels || !payload.channels[channel]) {
  throw new Error(`missing channels.${channel}\n${JSON.stringify(raw, null, 2).slice(0, 4000)}`);
}
console.log(`${channel} channel plugin visible`);
NODE
  then
    cat /tmp/openclaw-root-owned-gateway.log >&2
    exit 1
  fi
}

start_gateway /tmp/openclaw-root-owned-gateway.log
wait_for_gateway_health
assert_channel_status

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

echo "root-owned global install Docker E2E passed"
EOF
  then
    cat "$run_log"
    rm -f "$run_log"
    exit 1
  fi

  cat "$run_log"
  rm -f "$run_log"
}

run_setup_entry_scenario() {
  local run_log
  run_log="$(mktemp "${TMPDIR:-/tmp}/openclaw-bundled-channel-setup-entry.XXXXXX")"

  echo "Running bundled channel setup-entry runtime deps Docker E2E..."
  if ! docker run --rm \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -i "$IMAGE_NAME" bash -s >"$run_log" 2>&1 <<'EOF'
set -euo pipefail

export HOME="$(mktemp -d "/tmp/openclaw-bundled-channel-setup-entry.XXXXXX")"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_PLUGIN_STAGE_DIR="$HOME/.openclaw/plugin-runtime-deps"

CHANNEL="feishu"
DEP_SENTINEL="@larksuiteoapi/node-sdk"

package_root() {
  printf "%s/openclaw" "$(npm root -g)"
}

echo "Packing and installing current OpenClaw build..."
pack_dir="$(mktemp -d "/tmp/openclaw-setup-entry-pack.XXXXXX")"
npm pack --ignore-scripts --pack-destination "$pack_dir" >/tmp/openclaw-setup-entry-pack.log 2>&1
package_tgz="$(find "$pack_dir" -maxdepth 1 -name 'openclaw-*.tgz' -print -quit)"
if [ -z "$package_tgz" ]; then
  cat /tmp/openclaw-setup-entry-pack.log
  echo "missing packed OpenClaw tarball" >&2
  exit 1
fi
npm install -g "$package_tgz" --no-fund --no-audit >/tmp/openclaw-setup-entry-install.log 2>&1

root="$(package_root)"
test -d "$root/dist/extensions/$CHANNEL"
if [ -d "$root/dist/extensions/$CHANNEL/node_modules" ]; then
  echo "$CHANNEL runtime deps should not be preinstalled in package" >&2
  find "$root/dist/extensions/$CHANNEL/node_modules" -maxdepth 3 -type f | head -40 >&2 || true
  exit 1
fi
if [ -f "$root/node_modules/$DEP_SENTINEL/package.json" ]; then
  echo "$DEP_SENTINEL should not be installed at package root before setup-entry load" >&2
  exit 1
fi

echo "Loading real Feishu bundled setup entry from installed package..."
(
  cd "$root"
  node --input-type=module - <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const distDir = path.join(root, "dist");
const bundledPath = fs
  .readdirSync(distDir)
  .filter((entry) => /^bundled-[A-Za-z0-9_-]+\.js$/.test(entry))
  .map((entry) => path.join(distDir, entry))
  .find((entry) => fs.readFileSync(entry, "utf8").includes("src/channels/plugins/bundled.ts"));
if (!bundledPath) {
  throw new Error("missing packaged bundled channel loader artifact");
}
const bundled = await import(pathToFileURL(bundledPath));
let plugin = null;
for (const value of Object.values(bundled)) {
  if (typeof value !== "function" || value.length !== 1) {
    continue;
  }
  try {
    const candidate = value("feishu");
    if (candidate?.id === "feishu" && candidate?.setupWizard) {
      plugin = candidate;
      break;
    }
  } catch {
    // Ignore unrelated one-argument helper exports from the bundled chunk.
  }
}
if (!plugin) {
  throw new Error("missing Feishu setup plugin");
}
console.log("Feishu setup plugin loaded");
NODE
)

if [ -e "$root/dist/extensions/$CHANNEL/node_modules/$DEP_SENTINEL/package.json" ]; then
  echo "expected setup-entry deps to be installed externally, not into bundled plugin tree" >&2
  exit 1
fi
if ! find "$OPENCLAW_PLUGIN_STAGE_DIR" -maxdepth 12 -path "*/node_modules/$DEP_SENTINEL/package.json" -type f | grep -q .; then
  echo "missing external staged setup-entry dependency sentinel for $DEP_SENTINEL" >&2
  find "$OPENCLAW_PLUGIN_STAGE_DIR" -maxdepth 12 -type f | sort | head -160 >&2 || true
  exit 1
fi

echo "bundled channel setup-entry runtime deps Docker E2E passed"
EOF
  then
    cat "$run_log"
    rm -f "$run_log"
    exit 1
  fi

  cat "$run_log"
  rm -f "$run_log"
}

run_update_scenario() {
  local run_log
  run_log="$(mktemp "${TMPDIR:-/tmp}/openclaw-bundled-channel-update.XXXXXX")"

  echo "Running bundled channel runtime deps Docker update E2E..."
  if ! docker run --rm \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e OPENCLAW_BUNDLED_CHANNEL_UPDATE_BASELINE_VERSION="$UPDATE_BASELINE_VERSION" \
    -i "$IMAGE_NAME" bash -s >"$run_log" 2>&1 <<'EOF'
set -euo pipefail

export HOME="$(mktemp -d "/tmp/openclaw-bundled-channel-update.XXXXXX")"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENAI_API_KEY="sk-openclaw-bundled-channel-update-e2e"
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_UPDATE_PACKAGE_SPEC=""

BASELINE_VERSION="${OPENCLAW_BUNDLED_CHANNEL_UPDATE_BASELINE_VERSION:?missing baseline version}"
TOKEN="bundled-channel-update-token"
PORT="18790"

package_root() {
  printf "%s/openclaw" "$(npm root -g)"
}

pack_current_candidate() {
  local pack_dir
  pack_dir="$(mktemp -d "/tmp/openclaw-update-pack.XXXXXX")"
  node --import tsx --input-type=module -e 'const { writePackageDistInventory } = await import("./src/infra/package-dist-inventory.ts"); await writePackageDistInventory(process.cwd());' >/tmp/openclaw-update-inventory.log 2>&1
  npm pack --ignore-scripts --pack-destination "$pack_dir" >/tmp/openclaw-update-pack.log 2>&1
  find "$pack_dir" -maxdepth 1 -name 'openclaw-*.tgz' -print -quit
}

package_tgz="$(pack_current_candidate)"
if [ -z "$package_tgz" ]; then
  cat /tmp/openclaw-update-pack.log
  echo "missing packed OpenClaw candidate tarball" >&2
  exit 1
fi
update_target="file:$package_tgz"
candidate_version="$(node - <<'NODE' "$package_tgz"
const { execFileSync } = require("node:child_process");
const raw = execFileSync("tar", ["-xOf", process.argv[2], "package/package.json"], {
  encoding: "utf8",
});
process.stdout.write(String(JSON.parse(raw).version));
NODE
)"

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
config.channels = {
  ...(config.channels || {}),
  telegram: {
    ...(config.channels?.telegram || {}),
    enabled: mode === "telegram",
    botToken: "123456:bundled-channel-update-token",
    dmPolicy: "disabled",
    groupPolicy: "disabled",
  },
  discord: {
    ...(config.channels?.discord || {}),
    enabled: mode === "discord",
    dmPolicy: "disabled",
    groupPolicy: "disabled",
  },
  slack: {
    ...(config.channels?.slack || {}),
    enabled: mode === "slack",
    botToken: "xoxb-bundled-channel-update-token",
    appToken: "xapp-bundled-channel-update-token",
  },
};

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE
}

assert_dep_sentinel() {
  local channel="$1"
  local dep_path="$2"
  local root
  root="$(package_root)"
  if [ ! -f "$root/dist/extensions/$channel/node_modules/$dep_path/package.json" ]; then
    echo "missing dependency sentinel for $channel: $dep_path" >&2
    find "$root/dist/extensions/$channel" -maxdepth 3 -type f | sort | head -80 >&2 || true
    exit 1
  fi
}

assert_no_dep_sentinel() {
  local channel="$1"
  local dep_path="$2"
  local root
  root="$(package_root)"
  if [ -f "$root/dist/extensions/$channel/node_modules/$dep_path/package.json" ]; then
    echo "dependency sentinel should be absent before repair for $channel: $dep_path" >&2
    exit 1
  fi
}

assert_dep_available() {
  local channel="$1"
  local dep_path="$2"
  local root
  root="$(package_root)"
  for candidate in \
    "$root/dist/extensions/$channel/node_modules/$dep_path/package.json" \
    "$root/dist/extensions/node_modules/$dep_path/package.json" \
    "$root/node_modules/$dep_path/package.json"; do
    if [ -f "$candidate" ]; then
      return 0
    fi
  done
  echo "missing dependency sentinel for $channel: $dep_path" >&2
  find "$root/dist/extensions/$channel" -maxdepth 3 -type f | sort | head -80 >&2 || true
  find "$root/node_modules" -maxdepth 3 -path "*/$dep_path/package.json" -type f -print >&2 || true
  exit 1
}

assert_no_dep_available() {
  local channel="$1"
  local dep_path="$2"
  local root
  root="$(package_root)"
  for candidate in \
    "$root/dist/extensions/$channel/node_modules/$dep_path/package.json" \
    "$root/dist/extensions/node_modules/$dep_path/package.json" \
    "$root/node_modules/$dep_path/package.json"; do
    if [ -f "$candidate" ]; then
      echo "dependency sentinel should be absent before repair for $channel: $dep_path ($candidate)" >&2
      exit 1
    fi
  done
}

remove_runtime_dep() {
  local channel="$1"
  local dep_path="$2"
  local root
  root="$(package_root)"
  rm -rf "$root/dist/extensions/$channel/node_modules"
  rm -rf "$root/dist/extensions/node_modules/$dep_path"
  rm -rf "$root/node_modules/$dep_path"
}

assert_update_ok() {
  local json_file="$1"
  local expected_before="$2"
  node - <<'NODE' "$json_file" "$expected_before" "$candidate_version"
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const expectedBefore = process.argv[3];
const expectedAfter = process.argv[4];
if (payload.status !== "ok") {
  throw new Error(`expected update status ok, got ${JSON.stringify(payload.status)}`);
}
if (expectedBefore && (payload.before?.version ?? null) !== expectedBefore) {
  throw new Error(
    `expected before.version ${expectedBefore}, got ${JSON.stringify(payload.before?.version)}`,
  );
}
if ((payload.after?.version ?? null) !== expectedAfter) {
  throw new Error(
    `expected after.version ${expectedAfter}, got ${JSON.stringify(payload.after?.version)}`,
  );
}
const steps = Array.isArray(payload.steps) ? payload.steps : [];
const doctor = steps.find((step) => step?.name === "openclaw doctor");
if (!doctor) {
  throw new Error("missing openclaw doctor step");
}
if (Number(doctor.exitCode ?? 1) !== 0) {
  throw new Error(`openclaw doctor step failed: ${JSON.stringify(doctor)}`);
}
NODE
}

run_update_and_capture() {
  local label="$1"
  local out_file="$2"
  set +e
  openclaw update --tag "$update_target" --yes --json >"$out_file" 2>"/tmp/openclaw-$label-update.stderr"
  local status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    echo "openclaw update failed for $label with exit code $status" >&2
    cat "$out_file" >&2 || true
    cat "/tmp/openclaw-$label-update.stderr" >&2 || true
    exit "$status"
  fi
}

echo "Installing known-bad baseline $BASELINE_VERSION..."
npm install -g "openclaw@$BASELINE_VERSION" --omit=optional --no-fund --no-audit >/tmp/openclaw-update-baseline-install.log 2>&1
command -v openclaw >/dev/null
baseline_root="$(package_root)"
test -d "$baseline_root/dist/extensions/telegram"

echo "Replicating configured Telegram missing-runtime state..."
write_config telegram
assert_no_dep_available telegram grammy
set +e
openclaw doctor --non-interactive >/tmp/openclaw-baseline-doctor.log 2>&1
baseline_doctor_status=$?
set -e
if [ "$baseline_doctor_status" -eq 0 ] || ! grep -Eq "grammy|ERR_MODULE_NOT_FOUND|Cannot find module" /tmp/openclaw-baseline-doctor.log; then
  echo "expected baseline doctor to fail on missing Telegram runtime deps" >&2
  cat /tmp/openclaw-baseline-doctor.log >&2
  exit 1
fi

echo "Updating from baseline to current candidate; candidate doctor must repair Telegram deps..."
run_update_and_capture telegram /tmp/openclaw-update-telegram.json
cat /tmp/openclaw-update-telegram.json
assert_update_ok /tmp/openclaw-update-telegram.json "$BASELINE_VERSION"
assert_dep_available telegram grammy

echo "Mutating installed package: remove Telegram deps, then update-mode doctor repairs them..."
remove_runtime_dep telegram grammy
assert_no_dep_available telegram grammy
if ! OPENCLAW_UPDATE_IN_PROGRESS=1 openclaw doctor --non-interactive >/tmp/openclaw-update-mode-doctor.log 2>&1; then
  echo "update-mode doctor failed while repairing Telegram deps" >&2
  cat /tmp/openclaw-update-mode-doctor.log >&2
  exit 1
fi
assert_dep_available telegram grammy

echo "Mutating config to Discord and rerunning same-version update path..."
write_config discord
remove_runtime_dep discord discord-api-types
assert_no_dep_available discord discord-api-types
run_update_and_capture discord /tmp/openclaw-update-discord.json
cat /tmp/openclaw-update-discord.json
assert_update_ok /tmp/openclaw-update-discord.json "$candidate_version"
assert_dep_available discord discord-api-types

echo "Mutating config to Slack and rerunning same-version update path..."
write_config slack
remove_runtime_dep slack @slack/web-api
assert_no_dep_available slack @slack/web-api
run_update_and_capture slack /tmp/openclaw-update-slack.json
cat /tmp/openclaw-update-slack.json
assert_update_ok /tmp/openclaw-update-slack.json "$candidate_version"
assert_dep_available slack @slack/web-api

echo "bundled channel runtime deps Docker update E2E passed"
EOF
  then
    cat "$run_log"
    rm -f "$run_log"
    exit 1
  fi

  cat "$run_log"
  rm -f "$run_log"
}

if [ "$RUN_CHANNEL_SCENARIOS" != "0" ]; then
  run_channel_scenario telegram grammy
  run_channel_scenario discord discord-api-types
  run_channel_scenario slack @slack/web-api
fi
if [ "$RUN_UPDATE_SCENARIO" != "0" ]; then
  run_update_scenario
fi
if [ "$RUN_ROOT_OWNED_SCENARIO" != "0" ]; then
  run_root_owned_global_scenario
fi
if [ "$RUN_SETUP_ENTRY_SCENARIO" != "0" ]; then
  run_setup_entry_scenario
fi
