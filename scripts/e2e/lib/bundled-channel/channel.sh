#!/usr/bin/env bash
#
# Runs one bundled plugin channel runtime-dependency scenario.
# Sourced by scripts/e2e/bundled-channel-runtime-deps-docker.sh.

run_channel_scenario() {
  local channel="$1"
  local dep_sentinel="$2"
  local run_log
  run_log="$(docker_e2e_run_log "bundled-channel-deps-$channel")"

  echo "Running bundled $channel runtime deps Docker E2E..."
  if ! timeout "$DOCKER_RUN_TIMEOUT" docker run --rm \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e OPENCLAW_CHANNEL_UNDER_TEST="$channel" \
    -e OPENCLAW_DEP_SENTINEL="$dep_sentinel" \
    "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
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

terminate_gateways() {
  if [ -n "${gateway_pid:-}" ] && kill -0 "$gateway_pid" 2>/dev/null; then
    kill "$gateway_pid" 2>/dev/null || true
  fi
  if command -v pkill >/dev/null 2>&1; then
    pkill -TERM -f "[o]penclaw-gateway" 2>/dev/null || true
  fi
  for _ in $(seq 1 100); do
    local alive=0
    if [ -n "${gateway_pid:-}" ] && kill -0 "$gateway_pid" 2>/dev/null; then
      alive=1
    fi
    if command -v pgrep >/dev/null 2>&1 && pgrep -f "[o]penclaw-gateway" >/dev/null 2>&1; then
      alive=1
    fi
    [ "$alive" = "0" ] && break
    sleep 0.1
  done
  if [ -n "${gateway_pid:-}" ] && kill -0 "$gateway_pid" 2>/dev/null; then
    kill -KILL "$gateway_pid" 2>/dev/null || true
  fi
  if command -v pkill >/dev/null 2>&1; then
    pkill -KILL -f "[o]penclaw-gateway" 2>/dev/null || true
  fi
  if [ -n "${gateway_pid:-}" ]; then
    wait "$gateway_pid" 2>/dev/null || true
  fi
}

cleanup() {
  terminate_gateways
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

stage_root() {
  printf "%s/.openclaw/plugin-runtime-deps" "$HOME"
}

find_external_dep_package() {
  local dep_path="$1"
  find "$(stage_root)" -maxdepth 12 -path "*/node_modules/$dep_path/package.json" -type f -print -quit 2>/dev/null || true
}

assert_package_dep_absent() {
  local channel="$1"
  local dep_path="$2"
  for candidate in \
    "$package_root/dist/extensions/$channel/node_modules/$dep_path/package.json" \
    "$package_root/dist/extensions/node_modules/$dep_path/package.json" \
    "$package_root/node_modules/$dep_path/package.json"; do
    if [ -f "$candidate" ]; then
      echo "packaged install should not mutate package tree for $channel: $candidate" >&2
      exit 1
    fi
  done
}

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
  local skip_sidecars="${2:-0}"
  : >"$log_file"
  if [ "$skip_sidecars" = "1" ]; then
    OPENCLAW_SKIP_CHANNELS=1 OPENCLAW_SKIP_PROVIDERS=1 \
      openclaw gateway --port "$PORT" --bind loopback --allow-unconfigured >"$log_file" 2>&1 &
  else
    openclaw gateway --port "$PORT" --bind loopback --allow-unconfigured >"$log_file" 2>&1 &
  fi
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

stop_gateway() {
  terminate_gateways
  gateway_pid=""
}

wait_for_gateway_health() {
  local log_file="${1:-}"
  if [ -n "${gateway_pid:-}" ] && kill -0 "$gateway_pid" 2>/dev/null; then
    return 0
  fi
  echo "gateway process exited after ready marker" >&2
  if [ -n "$log_file" ]; then
    cat "$log_file" >&2
  fi
  return 1
}

parse_channel_status_json() {
  local out="$1"
  local channel="$2"
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

assert_channel_status() {
  local channel="$1"
  if [ "$channel" = "memory-lancedb" ]; then
    echo "memory-lancedb plugin activation verified by dependency sentinel"
    return 0
  fi
  local out="/tmp/openclaw-channel-status-$channel.json"
  local err="/tmp/openclaw-channel-status-$channel.err"
  local parse_err="/tmp/openclaw-channel-status-$channel.parse.err"
  local parse_out="/tmp/openclaw-channel-status-$channel.parse.out"
  for _ in $(seq 1 30); do
    if openclaw gateway call channels.status \
      --url "ws://127.0.0.1:$PORT" \
      --token "$TOKEN" \
      --timeout 10000 \
      --json \
      --params '{"probe":false}' >"$out" 2>"$err"; then
      if parse_channel_status_json "$out" "$channel" >"$parse_out" 2>"$parse_err"; then
        cat "$parse_out"
        return 0
      fi
    fi
    if grep -Eq "\\[gateway\\] ready \\(.*\\b$channel\\b" /tmp/openclaw-"$channel"-*.log 2>/dev/null; then
      echo "$channel channel plugin visible in gateway ready log"
      return 0
    fi
    sleep 2
  done
  if [ ! -s "$out" ]; then
    cat "$err" >&2 || true
  else
    cat "$parse_err" >&2 || true
    cat "$out" >&2 || true
  fi
  cat /tmp/openclaw-"$channel"-*.log >&2 2>/dev/null || true
  return 1
}

assert_installed_once() {
  local log_file="$1"
  local channel="$2"
  local dep_path="$3"
  local count
  count="$(grep -Ec "\\[plugins\\] $channel installed bundled runtime deps( in [0-9]+ms)?:" "$log_file" || true)"
  if [ "$count" -eq 1 ]; then
    return 0
  fi
  if [ "$count" -eq 0 ] && [ -n "$(find_external_dep_package "$dep_path")" ]; then
    return 0
  fi
  echo "expected one runtime deps install log or staged dependency sentinel for $channel, got $count log lines" >&2
  cat "$log_file" >&2
  find "$(stage_root)" -maxdepth 12 -type f | sort | head -120 >&2 || true
  exit 1
}

assert_not_installed() {
  local log_file="$1"
  local channel="$2"
  if grep -Eq "\\[plugins\\] $channel installed bundled runtime deps( in [0-9]+ms)?:" "$log_file"; then
    echo "expected no runtime deps reinstall for $channel" >&2
    cat "$log_file" >&2
    exit 1
  fi
}

assert_dep_sentinel() {
  local channel="$1"
  local dep_path="$2"
  local sentinel
  sentinel="$(find_external_dep_package "$dep_path")"
  if [ -z "$sentinel" ]; then
    echo "missing external dependency sentinel for $channel: $dep_path" >&2
    find "$(stage_root)" -maxdepth 12 -type f | sort | head -120 >&2 || true
    exit 1
  fi
  assert_package_dep_absent "$channel" "$dep_path"
}

assert_no_dep_sentinel() {
  local channel="$1"
  local dep_path="$2"
  assert_package_dep_absent "$channel" "$dep_path"
  if [ -n "$(find_external_dep_package "$dep_path")" ]; then
    echo "external dependency sentinel should be absent before activation for $channel: $dep_path" >&2
    exit 1
  fi
}

assert_no_install_stage() {
  local channel="$1"
  local stage="$package_root/dist/extensions/$channel/.openclaw-install-stage"
  if [ -e "$stage" ]; then
    echo "install stage should be cleaned after activation for $channel" >&2
    find "$stage" -maxdepth 4 -type f | sort | head -80 >&2 || true
    exit 1
  fi
}

echo "Starting baseline gateway with OpenAI configured..."
write_config baseline
start_gateway "/tmp/openclaw-$CHANNEL-baseline.log" 1
wait_for_gateway_health "/tmp/openclaw-$CHANNEL-baseline.log"
stop_gateway
assert_no_dep_sentinel "$CHANNEL" "$DEP_SENTINEL"

echo "Enabling $CHANNEL by config edit, then restarting gateway..."
write_config "$CHANNEL"
start_gateway "/tmp/openclaw-$CHANNEL-first.log"
wait_for_gateway_health "/tmp/openclaw-$CHANNEL-first.log"
assert_installed_once "/tmp/openclaw-$CHANNEL-first.log" "$CHANNEL" "$DEP_SENTINEL"
assert_dep_sentinel "$CHANNEL" "$DEP_SENTINEL"
assert_no_install_stage "$CHANNEL"
assert_channel_status "$CHANNEL"
stop_gateway

echo "Restarting gateway again; $CHANNEL deps must stay installed..."
start_gateway "/tmp/openclaw-$CHANNEL-second.log"
wait_for_gateway_health "/tmp/openclaw-$CHANNEL-second.log"
assert_not_installed "/tmp/openclaw-$CHANNEL-second.log" "$CHANNEL"
assert_no_install_stage "$CHANNEL"
assert_channel_status "$CHANNEL"
stop_gateway

echo "bundled $CHANNEL runtime deps Docker E2E passed"
EOF
  then
    docker_e2e_print_log "$run_log"
    rm -f "$run_log"
    exit 1
  fi

  docker_e2e_print_log "$run_log"
  rm -f "$run_log"
}
