#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-bundled-channel-deps-e2e" OPENCLAW_BUNDLED_CHANNEL_DEPS_E2E_IMAGE)"
UPDATE_BASELINE_VERSION="${OPENCLAW_BUNDLED_CHANNEL_UPDATE_BASELINE_VERSION:-2026.4.20}"
DOCKER_TARGET="${OPENCLAW_BUNDLED_CHANNEL_DOCKER_TARGET:-e2e-runner}"
HOST_BUILD="${OPENCLAW_BUNDLED_CHANNEL_HOST_BUILD:-1}"
PACKAGE_TGZ="${OPENCLAW_BUNDLED_CHANNEL_PACKAGE_TGZ:-}"
RUN_CHANNEL_SCENARIOS="${OPENCLAW_BUNDLED_CHANNEL_SCENARIOS:-1}"
RUN_UPDATE_SCENARIO="${OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO:-1}"
RUN_ROOT_OWNED_SCENARIO="${OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO:-1}"
RUN_SETUP_ENTRY_SCENARIO="${OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO:-1}"
RUN_LOAD_FAILURE_SCENARIO="${OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO:-1}"

docker_e2e_build_or_reuse "$IMAGE_NAME" bundled-channel-deps "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "$DOCKER_TARGET"

prepare_package_tgz() {
  if [ -n "$PACKAGE_TGZ" ]; then
    if [ ! -f "$PACKAGE_TGZ" ]; then
      echo "OPENCLAW_BUNDLED_CHANNEL_PACKAGE_TGZ does not exist: $PACKAGE_TGZ" >&2
      exit 1
    fi
    PACKAGE_TGZ="$(cd "$(dirname "$PACKAGE_TGZ")" && pwd)/$(basename "$PACKAGE_TGZ")"
    return 0
  fi

  if [ "$HOST_BUILD" != "0" ]; then
    echo "Building host package artifacts..."
    run_logged bundled-channel-deps-host-build pnpm build
  else
    echo "Skipping host build (OPENCLAW_BUNDLED_CHANNEL_HOST_BUILD=0)"
  fi

  echo "Writing package inventory and packing once..."
  run_logged bundled-channel-deps-inventory node --import tsx --input-type=module -e 'const { writePackageDistInventory } = await import("./src/infra/package-dist-inventory.ts"); await writePackageDistInventory(process.cwd());'
  local pack_dir
  pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-bundled-channel-pack.XXXXXX")"
  run_logged bundled-channel-deps-pack npm pack --ignore-scripts --pack-destination "$pack_dir"
  PACKAGE_TGZ="$(find "$pack_dir" -maxdepth 1 -name 'openclaw-*.tgz' -print -quit)"
  if [ -z "$PACKAGE_TGZ" ]; then
    echo "missing packed OpenClaw tarball" >&2
    exit 1
  fi
  PACKAGE_TGZ="$(cd "$(dirname "$PACKAGE_TGZ")" && pwd)/$(basename "$PACKAGE_TGZ")"
}

prepare_package_tgz
DOCKER_PACKAGE_TGZ="/tmp/openclaw-current.tgz"
PACKAGE_DOCKER_ARGS=(-v "$PACKAGE_TGZ:$DOCKER_PACKAGE_TGZ:ro" -e "OPENCLAW_CURRENT_PACKAGE_TGZ=$DOCKER_PACKAGE_TGZ")

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
    "${PACKAGE_DOCKER_ARGS[@]}" \
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

echo "Installing mounted OpenClaw package..."
package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
npm install -g "$package_tgz" --no-fund --no-audit >/tmp/openclaw-install.log 2>&1

command -v openclaw >/dev/null
package_root="$(npm root -g)/openclaw"
test -d "$package_root/dist/extensions/telegram"
test -d "$package_root/dist/extensions/discord"
test -d "$package_root/dist/extensions/slack"
test -d "$package_root/dist/extensions/feishu"
test -d "$package_root/dist/extensions/memory-lancedb"

if [ -d "$package_root/dist/extensions/$CHANNEL/node_modules" ]; then
  echo "$CHANNEL runtime deps should not be preinstalled in package" >&2
  find "$package_root/dist/extensions/$CHANNEL/node_modules" -maxdepth 2 -type f | head -20 >&2 || true
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
if (mode === "feishu") {
  config.channels = {
    ...(config.channels || {}),
    feishu: {
      ...(config.channels?.feishu || {}),
      enabled: true,
    },
  };
}
if (mode === "memory-lancedb") {
  config.plugins = {
    ...(config.plugins || {}),
    enabled: true,
    allow: [...new Set([...(config.plugins?.allow || []), "memory-lancedb"])],
    slots: {
      ...(config.plugins?.slots || {}),
      memory: "memory-lancedb",
    },
    entries: {
      ...(config.plugins?.entries || {}),
      "memory-lancedb": {
        ...(config.plugins?.entries?.["memory-lancedb"] || {}),
        enabled: true,
        config: {
          ...(config.plugins?.entries?.["memory-lancedb"]?.config || {}),
          embedding: {
            ...(config.plugins?.entries?.["memory-lancedb"]?.config?.embedding || {}),
            apiKey: process.env.OPENAI_API_KEY,
            model: "text-embedding-3-small",
          },
          dbPath: "~/.openclaw/memory/lancedb-e2e",
          autoCapture: false,
          autoRecall: false,
        },
      },
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
  if [ "$channel" = "memory-lancedb" ]; then
    echo "memory-lancedb plugin activation verified by dependency sentinel"
    return 0
  fi
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
  local dep_path="$3"
  local count
  count="$(grep -c "\\[plugins\\] $channel installed bundled runtime deps:" "$log_file" || true)"
  if [ "$count" -eq 1 ]; then
    return 0
  fi
  if [ "$count" -eq 0 ] && [ -f "$package_root/dist/extensions/$channel/node_modules/$dep_path/package.json" ]; then
    return 0
  fi
  if [ "$count" -ne 1 ]; then
    echo "expected exactly one runtime deps install log or installed sentinel for $channel, got $count log lines" >&2
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

assert_no_dep_sentinel() {
  local channel="$1"
  local dep_path="$2"
  if [ -f "$package_root/dist/extensions/$channel/node_modules/$dep_path/package.json" ]; then
    echo "dependency sentinel should be absent before activation for $channel: $dep_path" >&2
    exit 1
  fi
}

echo "Starting baseline gateway with OpenAI configured..."
write_config baseline
start_gateway "/tmp/openclaw-$CHANNEL-baseline.log"
wait_for_gateway_health
stop_gateway
assert_no_dep_sentinel "$CHANNEL" "$DEP_SENTINEL"

echo "Enabling $CHANNEL by config edit, then restarting gateway..."
write_config "$CHANNEL"
start_gateway "/tmp/openclaw-$CHANNEL-first.log"
wait_for_gateway_health
assert_installed_once "/tmp/openclaw-$CHANNEL-first.log" "$CHANNEL" "$DEP_SENTINEL"
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
    "${PACKAGE_DOCKER_ARGS[@]}" \
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
    "${PACKAGE_DOCKER_ARGS[@]}" \
    -i "$IMAGE_NAME" bash -s >"$run_log" 2>&1 <<'EOF'
set -euo pipefail

export HOME="$(mktemp -d "/tmp/openclaw-bundled-channel-setup-entry.XXXXXX")"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_PLUGIN_STAGE_DIR="$HOME/.openclaw/plugin-runtime-deps"
mkdir -p "$OPENCLAW_PLUGIN_STAGE_DIR"

CHANNEL="feishu"
DEP_SENTINEL="@larksuiteoapi/node-sdk"

package_root() {
  printf "%s/openclaw" "$(npm root -g)"
}

echo "Installing mounted OpenClaw package..."
package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
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

echo "Probing real Feishu bundled setup entry before channel configuration..."
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
const setupPluginLoader = Object.values(bundled).find(
  (value) => typeof value === "function" && value.name === "getBundledChannelSetupPlugin",
);
if (!setupPluginLoader) {
  throw new Error("missing packaged getBundledChannelSetupPlugin export");
}
const plugin = setupPluginLoader("feishu");
console.log(plugin ? "Feishu setup plugin loaded pre-config" : "Feishu setup plugin deferred pre-config");
NODE
)

if [ -e "$root/dist/extensions/$CHANNEL/node_modules/$DEP_SENTINEL/package.json" ]; then
  echo "setup-entry discovery installed deps into bundled plugin tree before channel configuration" >&2
  exit 1
fi
if find "$OPENCLAW_PLUGIN_STAGE_DIR" -maxdepth 12 -path "*/node_modules/$DEP_SENTINEL/package.json" -type f | grep -q .; then
  echo "setup-entry discovery installed external staged deps before channel configuration" >&2
  find "$OPENCLAW_PLUGIN_STAGE_DIR" -maxdepth 12 -type f | sort | head -160 >&2 || true
  exit 1
fi

echo "Configuring Feishu; doctor should now install bundled runtime deps externally..."
node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
fs.mkdirSync(path.dirname(configPath), { recursive: true });
const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : {};

config.plugins = {
  ...(config.plugins || {}),
  enabled: true,
};
config.channels = {
  ...(config.channels || {}),
  feishu: {
    ...(config.channels?.feishu || {}),
    enabled: true,
  },
};

fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE

openclaw doctor --non-interactive >/tmp/openclaw-setup-entry-doctor.log 2>&1

if [ -e "$root/dist/extensions/$CHANNEL/node_modules/$DEP_SENTINEL/package.json" ]; then
  echo "expected configured Feishu deps to be installed externally, not into bundled plugin tree" >&2
  exit 1
fi
if ! find "$OPENCLAW_PLUGIN_STAGE_DIR" -maxdepth 12 -path "*/node_modules/$DEP_SENTINEL/package.json" -type f | grep -q .; then
  echo "missing external staged dependency sentinel for configured $CHANNEL: $DEP_SENTINEL" >&2
  cat /tmp/openclaw-setup-entry-doctor.log >&2
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
    "${PACKAGE_DOCKER_ARGS[@]}" \
    -i "$IMAGE_NAME" bash -s >"$run_log" 2>&1 <<'EOF'
set -euo pipefail

export HOME="$(mktemp -d "/tmp/openclaw-bundled-channel-update.XXXXXX")"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENAI_API_KEY="sk-openclaw-bundled-channel-update-e2e"
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_UPDATE_PACKAGE_SPEC=""

TOKEN="bundled-channel-update-token"
PORT="18790"

package_root() {
  printf "%s/openclaw" "$(npm root -g)"
}

package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
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
  feishu: {
    ...(config.channels?.feishu || {}),
    enabled: mode === "feishu",
  },
};
if (mode === "memory-lancedb") {
  config.plugins = {
    ...(config.plugins || {}),
    enabled: true,
    allow: [...new Set([...(config.plugins?.allow || []), "memory-lancedb"])],
    slots: {
      ...(config.plugins?.slots || {}),
      memory: "memory-lancedb",
    },
    entries: {
      ...(config.plugins?.entries || {}),
      "memory-lancedb": {
        ...(config.plugins?.entries?.["memory-lancedb"] || {}),
        enabled: true,
        config: {
          ...(config.plugins?.entries?.["memory-lancedb"]?.config || {}),
          embedding: {
            ...(config.plugins?.entries?.["memory-lancedb"]?.config?.embedding || {}),
            apiKey: process.env.OPENAI_API_KEY,
            model: "text-embedding-3-small",
          },
          dbPath: "~/.openclaw/memory/lancedb-update-e2e",
          autoCapture: false,
          autoRecall: false,
        },
      },
    },
  };
}

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

echo "Installing current candidate as update baseline..."
npm install -g "$package_tgz" --no-fund --no-audit >/tmp/openclaw-update-baseline-install.log 2>&1
command -v openclaw >/dev/null
baseline_root="$(package_root)"
test -d "$baseline_root/dist/extensions/telegram"
test -d "$baseline_root/dist/extensions/feishu"

echo "Replicating configured Telegram missing-runtime state..."
write_config telegram
assert_no_dep_available telegram grammy
set +e
openclaw doctor --non-interactive >/tmp/openclaw-baseline-doctor.log 2>&1
baseline_doctor_status=$?
set -e
echo "baseline doctor exited with $baseline_doctor_status"
remove_runtime_dep telegram grammy
assert_no_dep_available telegram grammy

echo "Updating from baseline to current candidate; candidate doctor must repair Telegram deps..."
run_update_and_capture telegram /tmp/openclaw-update-telegram.json
cat /tmp/openclaw-update-telegram.json
assert_update_ok /tmp/openclaw-update-telegram.json "$candidate_version"
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

echo "Mutating config to Feishu and rerunning same-version update path..."
write_config feishu
remove_runtime_dep feishu @larksuiteoapi/node-sdk
assert_no_dep_available feishu @larksuiteoapi/node-sdk
run_update_and_capture feishu /tmp/openclaw-update-feishu.json
cat /tmp/openclaw-update-feishu.json
assert_update_ok /tmp/openclaw-update-feishu.json "$candidate_version"
assert_dep_available feishu @larksuiteoapi/node-sdk

echo "Mutating config to memory-lancedb and rerunning same-version update path..."
write_config memory-lancedb
remove_runtime_dep memory-lancedb @lancedb/lancedb
assert_no_dep_available memory-lancedb @lancedb/lancedb
run_update_and_capture memory-lancedb /tmp/openclaw-update-memory-lancedb.json
cat /tmp/openclaw-update-memory-lancedb.json
assert_update_ok /tmp/openclaw-update-memory-lancedb.json "$candidate_version"
assert_dep_available memory-lancedb @lancedb/lancedb

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

run_load_failure_scenario() {
  local run_log
  run_log="$(mktemp "${TMPDIR:-/tmp}/openclaw-bundled-channel-load-failure.XXXXXX")"

  echo "Running bundled channel load-failure isolation Docker E2E..."
  if ! docker run --rm \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    "${PACKAGE_DOCKER_ARGS[@]}" \
    -i "$IMAGE_NAME" bash -s >"$run_log" 2>&1 <<'EOF'
set -euo pipefail

export HOME="$(mktemp -d "/tmp/openclaw-bundled-channel-load-failure.XXXXXX")"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENCLAW_NO_ONBOARD=1

package_root() {
  printf "%s/openclaw" "$(npm root -g)"
}

echo "Installing mounted OpenClaw package..."
package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
npm install -g "$package_tgz" --no-fund --no-audit >/tmp/openclaw-load-failure-install.log 2>&1

root="$(package_root)"
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
(
  cd "$root"
  OPENCLAW_BUNDLED_PLUGINS_DIR="$root/dist/extensions" node --input-type=module - <<'NODE'
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
const oneArgExports = Object.entries(bundled).filter(
  ([, value]) => typeof value === "function" && value.length === 1,
);
if (oneArgExports.length === 0) {
  throw new Error(`missing one-argument bundled loader exports; exports=${Object.keys(bundled).join(",")}`);
}

const id = "load-failure-alpha";
for (let i = 0; i < 2; i += 1) {
  for (const [name, fn] of oneArgExports) {
    try {
      fn(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("synthetic")) {
        throw new Error(`bundled export ${name} leaked synthetic load failure: ${message}`);
      }
    }
  }
}

const counts = {
  plugin: globalThis.__loadFailurePlugin,
  setup: globalThis.__loadFailureSetup,
  secrets: globalThis.__loadFailureSecrets,
  setupSecrets: globalThis.__loadFailureSetupSecrets,
};
for (const [key, value] of Object.entries({
  plugin: counts.plugin,
  setup: counts.setup,
  setupSecrets: counts.setupSecrets,
})) {
  if (value !== 1) {
    throw new Error(`expected ${key} failure to be cached after one load, got ${value}`);
  }
}
if (counts.secrets !== undefined && counts.secrets !== 1) {
  throw new Error(`expected secrets failure to be cached after one load when exercised, got ${counts.secrets}`);
}
console.log("synthetic bundled channel load failures were isolated and cached");
NODE
)

echo "bundled channel load-failure isolation Docker E2E passed"
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
  run_channel_scenario feishu @larksuiteoapi/node-sdk
  run_channel_scenario memory-lancedb @lancedb/lancedb
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
if [ "$RUN_LOAD_FAILURE_SCENARIO" != "0" ]; then
  run_load_failure_scenario
fi
