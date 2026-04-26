#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-npm-onboard-channel-agent-e2e" OPENCLAW_NPM_ONBOARD_E2E_IMAGE)"
DOCKER_TARGET="${OPENCLAW_NPM_ONBOARD_DOCKER_TARGET:-e2e-runner}"
HOST_BUILD="${OPENCLAW_NPM_ONBOARD_HOST_BUILD:-1}"
PACKAGE_TGZ="${OPENCLAW_NPM_ONBOARD_PACKAGE_TGZ:-}"
CHANNEL="${OPENCLAW_NPM_ONBOARD_CHANNEL:-telegram}"

case "$CHANNEL" in
  telegram | discord) ;;
  *)
    echo "OPENCLAW_NPM_ONBOARD_CHANNEL must be telegram or discord, got: $CHANNEL" >&2
    exit 1
    ;;
esac

docker_e2e_build_or_reuse "$IMAGE_NAME" npm-onboard-channel-agent "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "$DOCKER_TARGET"

prepare_package_tgz() {
  if [ -n "$PACKAGE_TGZ" ]; then
    if [ ! -f "$PACKAGE_TGZ" ]; then
      echo "OPENCLAW_NPM_ONBOARD_PACKAGE_TGZ does not exist: $PACKAGE_TGZ" >&2
      exit 1
    fi
    PACKAGE_TGZ="$(cd "$(dirname "$PACKAGE_TGZ")" && pwd)/$(basename "$PACKAGE_TGZ")"
    return 0
  fi

  if [ "$HOST_BUILD" != "0" ]; then
    echo "Building host package artifacts..."
    run_logged npm-onboard-channel-agent-host-build pnpm build
  else
    echo "Skipping host build (OPENCLAW_NPM_ONBOARD_HOST_BUILD=0)"
  fi

  echo "Writing package inventory and packing once..."
  run_logged npm-onboard-channel-agent-inventory node --import tsx --input-type=module -e 'const { writePackageDistInventory } = await import("./src/infra/package-dist-inventory.ts"); await writePackageDistInventory(process.cwd());'
  local pack_dir
  pack_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-npm-onboard-pack.XXXXXX")"
  run_logged npm-onboard-channel-agent-pack npm pack --ignore-scripts --pack-destination "$pack_dir"
  PACKAGE_TGZ="$(find "$pack_dir" -maxdepth 1 -name 'openclaw-*.tgz' -print -quit)"
  if [ -z "$PACKAGE_TGZ" ]; then
    echo "missing packed OpenClaw tarball" >&2
    exit 1
  fi
  PACKAGE_TGZ="$(cd "$(dirname "$PACKAGE_TGZ")" && pwd)/$(basename "$PACKAGE_TGZ")"
}

prepare_package_tgz

DOCKER_PACKAGE_TGZ="/tmp/openclaw-current.tgz"
run_log="$(mktemp "${TMPDIR:-/tmp}/openclaw-npm-onboard-channel-agent.XXXXXX")"

echo "Running npm tarball onboard/channel/agent Docker E2E ($CHANNEL)..."
if ! docker run --rm \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENCLAW_NPM_ONBOARD_CHANNEL="$CHANNEL" \
  -e OPENCLAW_CURRENT_PACKAGE_TGZ="$DOCKER_PACKAGE_TGZ" \
  -v "$PACKAGE_TGZ:$DOCKER_PACKAGE_TGZ:ro" \
  -v "$ROOT_DIR/scripts/e2e:/app/scripts/e2e:ro" \
  -i "$IMAGE_NAME" bash -s >"$run_log" 2>&1 <<'EOF'
set -euo pipefail

export HOME="$(mktemp -d "/tmp/openclaw-npm-onboard.XXXXXX")"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENAI_API_KEY="sk-openclaw-npm-onboard-e2e"
export OPENCLAW_GATEWAY_TOKEN="npm-onboard-channel-agent-token"

CHANNEL="${OPENCLAW_NPM_ONBOARD_CHANNEL:?missing OPENCLAW_NPM_ONBOARD_CHANNEL}"
PORT="18789"
MOCK_PORT="44080"
SUCCESS_MARKER="OPENCLAW_AGENT_E2E_OK_ASSISTANT"
MOCK_REQUEST_LOG="/tmp/openclaw-mock-openai-requests.jsonl"
mock_pid=""

case "$CHANNEL" in
  telegram)
    CHANNEL_TOKEN="123456:openclaw-npm-onboard-token"
    DEP_SENTINEL="grammy"
    ;;
  discord)
    CHANNEL_TOKEN="openclaw-npm-onboard-discord-token"
    DEP_SENTINEL="discord-api-types"
    ;;
  *)
    echo "unsupported channel: $CHANNEL" >&2
    exit 1
    ;;
esac

cleanup() {
  if [ -n "${mock_pid:-}" ] && kill -0 "$mock_pid" 2>/dev/null; then
    kill "$mock_pid" 2>/dev/null || true
    wait "$mock_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

dump_debug_logs() {
  local status="$1"
  echo "npm onboard/channel/agent scenario failed with exit code $status" >&2
  for file in \
    /tmp/openclaw-install.log \
    /tmp/openclaw-onboard.json \
    /tmp/openclaw-channel-add.log \
    /tmp/openclaw-doctor.log \
    /tmp/openclaw-agent.combined \
    /tmp/openclaw-agent.err \
    /tmp/openclaw-agent.json \
    /tmp/openclaw-mock-openai.log \
    "$MOCK_REQUEST_LOG"; do
    if [ -f "$file" ]; then
      echo "--- $file ---" >&2
      sed -n '1,220p' "$file" >&2 || true
    fi
  done
}
trap 'status=$?; dump_debug_logs "$status"; exit "$status"' ERR

echo "Installing mounted OpenClaw package..."
package_tgz="${OPENCLAW_CURRENT_PACKAGE_TGZ:?missing OPENCLAW_CURRENT_PACKAGE_TGZ}"
npm install -g "$package_tgz" --no-fund --no-audit >/tmp/openclaw-install.log 2>&1

command -v openclaw >/dev/null
package_root="$(npm root -g)/openclaw"
test -d "$package_root/dist/extensions/telegram"
test -d "$package_root/dist/extensions/discord"

assert_dep_absent() {
  local sentinel="$1"
  if find "$package_root" "$HOME/.openclaw" -path "*/node_modules/$sentinel/package.json" -print -quit 2>/dev/null | grep -q .; then
    echo "$sentinel should not be installed before channel activation repair" >&2
    find "$package_root" "$HOME/.openclaw" -path "*/node_modules/$sentinel/package.json" -print 2>/dev/null >&2 || true
    exit 1
  fi
}

assert_dep_present() {
  local sentinel="$1"
  if ! find "$package_root" "$HOME/.openclaw" -path "*/node_modules/$sentinel/package.json" -print -quit 2>/dev/null | grep -q .; then
    echo "$sentinel was not installed on demand" >&2
    find "$package_root" "$HOME/.openclaw" -maxdepth 6 -type d -name node_modules -print 2>/dev/null >&2 || true
    exit 1
  fi
}

MOCK_PORT="$MOCK_PORT" SUCCESS_MARKER="$SUCCESS_MARKER" MOCK_REQUEST_LOG="$MOCK_REQUEST_LOG" node scripts/e2e/mock-openai-server.mjs >/tmp/openclaw-mock-openai.log 2>&1 &
mock_pid="$!"
for _ in $(seq 1 80); do
  if node -e "fetch('http://127.0.0.1:${MOCK_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    break
  fi
  sleep 0.1
done
node -e "fetch('http://127.0.0.1:${MOCK_PORT}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

echo "Running non-interactive onboarding..."
openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice openai-api-key \
  --secret-input-mode ref \
  --gateway-port "$PORT" \
  --gateway-bind loopback \
  --skip-daemon \
  --skip-ui \
  --skip-skills \
  --skip-health \
  --json >/tmp/openclaw-onboard.json

node - "$HOME" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const home = process.argv[2];
const stateDir = path.join(home, ".openclaw");
const configPath = path.join(stateDir, "openclaw.json");
const agentDir = path.join(stateDir, "agents", "main", "agent");
const authPath = path.join(agentDir, "auth-profiles.json");

if (!fs.existsSync(configPath)) {
  throw new Error("onboard did not write openclaw.json");
}
if (!fs.existsSync(agentDir)) {
  throw new Error("onboard did not create main agent dir");
}
if (!fs.existsSync(authPath)) {
  throw new Error("onboard did not create auth-profiles.json");
}
const authRaw = fs.readFileSync(authPath, "utf8");
if (!authRaw.includes("OPENAI_API_KEY")) {
  throw new Error("auth profile did not persist OPENAI_API_KEY env ref");
}
if (authRaw.includes("sk-openclaw-npm-onboard-e2e")) {
  throw new Error("auth profile persisted the raw OpenAI test key");
}
NODE

node - "$MOCK_PORT" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const mockPort = Number(process.argv[2]);
const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
const modelRef = "openai/gpt-5.5";
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

cfg.models = {
  ...(cfg.models || {}),
  mode: "merge",
  providers: {
    ...(cfg.models?.providers || {}),
    openai: {
      ...(cfg.models?.providers?.openai || {}),
      baseUrl: `http://127.0.0.1:${mockPort}/v1`,
      apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      api: "openai-responses",
      request: { ...(cfg.models?.providers?.openai?.request || {}), allowPrivateNetwork: true },
      models: [
        {
          id: "gpt-5.5",
          name: "gpt-5.5",
          api: "openai-responses",
          reasoning: false,
          input: ["text", "image"],
          cost,
          contextWindow: 128000,
          contextTokens: 96000,
          maxTokens: 4096,
        },
      ],
    },
  },
};
cfg.agents = {
  ...(cfg.agents || {}),
  defaults: {
    ...(cfg.agents?.defaults || {}),
    model: { primary: modelRef },
    models: {
      ...(cfg.agents?.defaults?.models || {}),
      [modelRef]: { params: { transport: "sse", openaiWsWarmup: false } },
    },
  },
};
cfg.plugins = {
  ...(cfg.plugins || {}),
  enabled: true,
};
fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
NODE

assert_dep_absent "$DEP_SENTINEL"

echo "Configuring $CHANNEL..."
openclaw channels add --channel "$CHANNEL" --token "$CHANNEL_TOKEN" >/tmp/openclaw-channel-add.log 2>&1
node - "$CHANNEL" "$CHANNEL_TOKEN" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const channel = process.argv[2];
const token = process.argv[3];
const cfg = JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".openclaw", "openclaw.json"), "utf8"));
const entry = cfg.channels?.[channel];
if (!entry || entry.enabled === false) {
  throw new Error(`${channel} was not enabled`);
}
const serialized = JSON.stringify(entry);
if (!serialized.includes(token)) {
  throw new Error(`${channel} token was not persisted`);
}
NODE

echo "Running doctor after channel activation..."
openclaw doctor --repair --non-interactive >/tmp/openclaw-doctor.log 2>&1
assert_dep_present "$DEP_SENTINEL"

echo "Running local agent turn against mocked OpenAI..."
openclaw agent --local \
  --agent main \
  --session-id npm-onboard-channel-agent \
  --message "Return the success marker from the test server." \
  --thinking off \
  --json >/tmp/openclaw-agent.combined 2>&1

node - "$SUCCESS_MARKER" "$MOCK_REQUEST_LOG" <<'NODE'
const fs = require("node:fs");
const marker = process.argv[2];
const logPath = process.argv[3];
const output = fs.readFileSync("/tmp/openclaw-agent.combined", "utf8");
if (!output.includes(marker)) {
  throw new Error(`agent JSON did not contain success marker. Output: ${output}`);
}
const requestLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
if (!/\/v1\/(responses|chat\/completions)/.test(requestLog)) {
  throw new Error(`mock OpenAI server was not used. Requests: ${requestLog}`);
}
NODE

echo "npm tarball onboard/channel/agent Docker E2E passed for $CHANNEL"
EOF
then
  cat "$run_log"
  rm -f "$run_log"
  exit 1
fi

rm -f "$run_log"
echo "npm tarball onboard/channel/agent Docker E2E passed ($CHANNEL)"
