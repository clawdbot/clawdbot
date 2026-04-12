#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-logs.sh"
IMAGE_NAME="openclaw-plugins-e2e"

echo "Building Docker image..."
run_logged plugins-build docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR"

DOCKER_ENV_ARGS=(-e COREPACK_ENABLE_DOWNLOAD_PROMPT=0)
if [[ -n "${OPENAI_API_KEY:-}" && "${OPENAI_API_KEY:-}" != "undefined" && "${OPENAI_API_KEY:-}" != "null" ]]; then
  DOCKER_ENV_ARGS+=(-e OPENAI_API_KEY)
fi
if [[ -n "${OPENAI_BASE_URL:-}" && "${OPENAI_BASE_URL:-}" != "undefined" && "${OPENAI_BASE_URL:-}" != "null" ]]; then
  DOCKER_ENV_ARGS+=(-e OPENAI_BASE_URL)
fi

echo "Running plugins Docker E2E..."
RUN_LOG="$(mktemp "${TMPDIR:-/tmp}/openclaw-plugins-run.XXXXXX.log")"
if ! docker run --rm "${DOCKER_ENV_ARGS[@]}" -i "$IMAGE_NAME" bash -s >"$RUN_LOG" 2>&1 <<'EOF'
set -euo pipefail

if [ -f dist/index.mjs ]; then
  OPENCLAW_ENTRY="dist/index.mjs"
elif [ -f dist/index.js ]; then
  OPENCLAW_ENTRY="dist/index.js"
else
  echo "Missing dist/index.(m)js (build output):"
  ls -la dist || true
  exit 1
fi
export OPENCLAW_ENTRY

sanitize_env_string() {
  local value="${1:-}"
  if [[ "$value" == "undefined" || "$value" == "null" ]]; then
    printf ''
    return
  fi
  printf '%s' "$value"
}

export OPENAI_API_KEY="$(sanitize_env_string "${OPENAI_API_KEY:-}")"
export OPENAI_BASE_URL="$(sanitize_env_string "${OPENAI_BASE_URL:-}")"
if [[ -z "$OPENAI_API_KEY" ]]; then
  unset OPENAI_API_KEY || true
fi
if [[ -z "$OPENAI_BASE_URL" ]]; then
  unset OPENAI_BASE_URL || true
fi

home_dir=$(mktemp -d "/tmp/openclaw-plugins-e2e.XXXXXX")
export HOME="$home_dir"
BUNDLED_PLUGIN_ROOT_DIR="extensions"
OPENCLAW_PLUGIN_HOME="$HOME/.openclaw/$BUNDLED_PLUGIN_ROOT_DIR"

gateway_pid=""

record_fixture_plugin_trust() {
  local plugin_id="$1"
  local plugin_root="$2"
  local enabled="$3"
  node - <<'NODE' "$plugin_id" "$plugin_root" "$enabled"
const fs = require("node:fs");
const path = require("node:path");

const pluginId = process.argv[2];
const pluginRoot = process.argv[3];
const enabled = process.argv[4] === "1";
const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : {};
const plugins = (config.plugins ??= {});
const entries = (plugins.entries ??= {});
entries[pluginId] = { ...(entries[pluginId] ?? {}), enabled };
const installs = (plugins.installs ??= {});
installs[pluginId] = {
  ...(installs[pluginId] ?? {}),
  source: "path",
  installPath: pluginRoot,
  sourcePath: pluginRoot,
};
plugins.allow = Array.from(new Set([...(plugins.allow ?? []), pluginId])).sort();
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE
}

run_logged() {
  local label="$1"
  shift
  local log_file="/tmp/openclaw-plugins-e2e-${label}.log"
  if ! "$@" >"$log_file" 2>&1; then
    cat "$log_file"
    exit 1
  fi
}

seed_openai_provider_config() {
  local openai_api_key="$1"
  local openai_base_url="${2:-}"
  node - <<'NODE' "$openai_api_key" "$openai_base_url"
const fs = require("node:fs");
const path = require("node:path");

const openaiApiKey = process.argv[2];
const openaiBaseUrl = process.argv[3];
const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : {};
const existingOpenAI = config.models?.providers?.openai ?? {};
config.models = {
  ...(config.models || {}),
  providers: {
    ...(config.models?.providers || {}),
    openai: {
      ...existingOpenAI,
      baseUrl:
        typeof existingOpenAI.baseUrl === "string" && existingOpenAI.baseUrl.trim()
          ? existingOpenAI.baseUrl
          : openaiBaseUrl || "https://api.openai.com/v1",
      apiKey: openaiApiKey,
      models: Array.isArray(existingOpenAI.models) ? existingOpenAI.models : [],
    },
  },
};
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE
}

stop_gateway() {
  if [ -n "${gateway_pid:-}" ] && kill -0 "$gateway_pid" 2>/dev/null; then
    kill "$gateway_pid" 2>/dev/null || true
    wait "$gateway_pid" 2>/dev/null || true
  fi
  gateway_pid=""
}

start_gateway() {
  local log_file="$1"
  : > "$log_file"
  node "$OPENCLAW_ENTRY" gateway --port 18789 --bind loopback --allow-unconfigured \
    >"$log_file" 2>&1 &
  gateway_pid=$!

  for _ in $(seq 1 120); do
    # Gateway startup logs changed; accept both the legacy listener line and the
    # current structured ready line so this smoke stays stable across formats.
    if grep -Eq "listening on ws://|\\[gateway\\] ready \\(" "$log_file"; then
      return 0
    fi
    if ! kill -0 "$gateway_pid" 2>/dev/null; then
      echo "Gateway exited unexpectedly"
      cat "$log_file"
      exit 1
    fi
    sleep 0.25
  done

  echo "Timed out waiting for gateway to start"
  cat "$log_file"
  exit 1
}

wait_for_gateway_health() {
  for _ in $(seq 1 120); do
    if node "$OPENCLAW_ENTRY" gateway health \
      --url ws://127.0.0.1:18789 \
      --token plugin-e2e-token \
      --json >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.25
  done

  echo "Timed out waiting for gateway health"
  return 1
}

run_gateway_chat_json() {
  local session_key="$1"
  local message="$2"
  local output_file="$3"
  local timeout_ms="${4:-45000}"
  node - <<'NODE' "$OPENCLAW_ENTRY" "$session_key" "$message" "$output_file" "$timeout_ms"
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");

const [, , entry, sessionKey, message, outputFile, timeoutRaw] = process.argv;
const timeoutMs = Number(timeoutRaw) > 0 ? Number(timeoutRaw) : 45000;
// Plugin install/enable can intentionally restart the gateway mid-request.
// Keep the underlying gateway call budget aligned with the scenario timeout
// instead of clamping too aggressively, or normal restarts look like failures.
const gatewayCallTimeoutMs = Math.max(15000, Math.min(timeoutMs, 90000));
const retryableGatewayErrorPattern =
  /gateway ws open timeout|gateway connect timeout|gateway closed|ECONNREFUSED|socket hang up|gateway timeout after/i;
const formatErrorMessage = (error) =>
  error instanceof Error ? error.message || error.name || "Error" : String(error);
const gatewayArgs = [
  entry,
  "gateway",
  "call",
  "--url",
  "ws://127.0.0.1:18789",
  "--token",
  "plugin-e2e-token",
  "--timeout",
  String(gatewayCallTimeoutMs),
  "--json",
];

const callGatewayOnce = (method, params) => {
  try {
    return {
      ok: true,
      value: JSON.parse(
        execFileSync("node", [...gatewayArgs, method, "--params", JSON.stringify(params)], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      ),
    };
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr : "";
    const stdout = typeof error?.stdout === "string" ? error.stdout : "";
    const message = [String(error), stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
    return { ok: false, error: new Error(message) };
  }
};

const isRetryableGatewayError = (error) =>
  retryableGatewayErrorPattern.test(formatErrorMessage(error));

const extractText = (messageLike) => {
  if (!messageLike || typeof messageLike !== "object") {
    return "";
  }
  if (typeof messageLike.text === "string" && messageLike.text.trim()) {
    return messageLike.text.trim();
  }
  const content = Array.isArray(messageLike.content) ? messageLike.content : [];
  return content
    .map((part) =>
      part &&
      typeof part === "object" &&
      part.type === "text" &&
      typeof part.text === "string"
        ? part.text.trim()
        : "",
    )
    .filter(Boolean)
    .join("\n\n")
    .trim();
};

const findLatestAssistantText = (history) => {
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (!candidate || typeof candidate !== "object" || candidate.role !== "assistant") {
      continue;
    }
    const text = extractText(candidate);
    if (text) {
      return { text, message: candidate };
    }
  }
  return null;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const callGateway = async (method, params, deadline = Date.now() + gatewayCallTimeoutMs) => {
  let lastFailure = null;
  while (Date.now() < deadline) {
    const result = callGatewayOnce(method, params);
    if (result.ok) {
      return result;
    }
    lastFailure = result;
    if (!isRetryableGatewayError(result.error)) {
      return result;
    }
    await sleep(250);
  }
  return lastFailure ?? callGatewayOnce(method, params);
};

async function main() {
  const runId = `plugin-e2e-${randomUUID()}`;
  const sendParams = {
    sessionKey,
    message,
    idempotencyKey: runId,
  };
  let lastGatewayError = null;
  const sendResult = await callGateway(
    "chat.send",
    sendParams,
    Date.now() + gatewayCallTimeoutMs,
  );
  if (!sendResult.ok) {
    throw sendResult.error;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const historyResult = await callGateway("chat.history", { sessionKey }, Date.now() + 5000);
    if (!historyResult.ok) {
      lastGatewayError = String(historyResult.error);
      await sleep(150);
      continue;
    }
    lastGatewayError = null;
    const history = historyResult.value;
    const latestAssistant = findLatestAssistantText(history);
    if (latestAssistant) {
      fs.writeFileSync(
        outputFile,
        `${JSON.stringify(
          {
            sessionKey,
            runId,
            text: latestAssistant.text,
            message: latestAssistant.message,
            history,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      return;
    }
    await sleep(100);
  }

  const finalHistory = await callGateway("chat.history", { sessionKey }, Date.now() + 3000);
  fs.writeFileSync(
    outputFile,
    `${JSON.stringify(
      {
        sessionKey,
        runId,
        error: "timeout",
        history: finalHistory.ok ? finalHistory.value : null,
        historyError: finalHistory.ok ? null : String(finalHistory.error),
        lastGatewayError,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const retrySummary = lastGatewayError ? `; last gateway error: ${lastGatewayError}` : "";
  throw new Error(`timed out waiting for assistant reply for ${sessionKey}${retrySummary}`);
}

main().catch((error) => {
  console.error(formatErrorMessage(error));
  process.exit(1);
});
NODE
}

trap 'stop_gateway' EXIT

write_fixture_plugin() {
  local dir="$1"
  local id="$2"
  local version="$3"
  local method="$4"
  local name="$5"

  mkdir -p "$dir"
  cat > "$dir/package.json" <<JSON
{
  "name": "@openclaw/$id",
  "version": "$version",
  "openclaw": { "extensions": ["./index.js"] }
}
JSON
  cat > "$dir/index.js" <<JS
module.exports = {
  id: "$id",
  name: "$name",
  register(api) {
    api.registerGatewayMethod("$method", async () => ({ ok: true }));
  },
};
JS
  cat > "$dir/openclaw.plugin.json" <<'JSON'
{
  "id": "placeholder",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
JSON
  node - <<'NODE' "$dir/openclaw.plugin.json" "$id"
const fs = require("node:fs");
const file = process.argv[2];
const id = process.argv[3];
const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
parsed.id = id;
fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
NODE
}

demo_plugin_id="demo-plugin"
demo_plugin_root="$OPENCLAW_PLUGIN_HOME/$demo_plugin_id"
mkdir -p "$demo_plugin_root"

cat > "$demo_plugin_root/index.js" <<'JS'
module.exports = {
  id: "demo-plugin",
  name: "Demo Plugin",
  description: "Docker E2E demo plugin",
  register(api) {
    api.registerTool(() => null, { name: "demo_tool" });
    api.registerGatewayMethod("demo.ping", async () => ({ ok: true }));
    api.registerCli(() => {}, { commands: ["demo"] });
    api.registerService({ id: "demo-service", start: () => {} });
  },
};
JS
cat > "$demo_plugin_root/openclaw.plugin.json" <<'JSON'
{
  "id": "demo-plugin",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
JSON
record_fixture_plugin_trust "$demo_plugin_id" "$demo_plugin_root" 1

node "$OPENCLAW_ENTRY" plugins list --json > /tmp/plugins.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin --json > /tmp/plugins-inspect.json

node - <<'NODE'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins.json", "utf8"));
const inspect = JSON.parse(fs.readFileSync("/tmp/plugins-inspect.json", "utf8"));
const plugin = (data.plugins || []).find((entry) => entry.id === "demo-plugin");
if (!plugin) throw new Error("plugin not found");
if (plugin.status !== "loaded") {
  throw new Error(`unexpected status: ${plugin.status}`);
}

const assertIncludes = (list, value, label) => {
  if (!Array.isArray(list) || !list.includes(value)) {
    throw new Error(`${label} missing: ${value}`);
  }
};

const inspectToolNames = Array.isArray(inspect.tools)
  ? inspect.tools.flatMap((entry) => (Array.isArray(entry?.names) ? entry.names : []))
  : [];
assertIncludes(inspectToolNames, "demo_tool", "tool");
assertIncludes(inspect.gatewayMethods, "demo.ping", "gateway method");
assertIncludes(inspect.cliCommands, "demo", "cli command");
assertIncludes(inspect.services, "demo-service", "service");

const diagErrors = (data.diagnostics || []).filter((diag) => diag.level === "error");
if (diagErrors.length > 0) {
  throw new Error(`diagnostics errors: ${diagErrors.map((diag) => diag.message).join("; ")}`);
}

console.log("ok");
NODE

echo "Testing tgz install flow..."
pack_dir="$(mktemp -d "/tmp/openclaw-plugin-pack.XXXXXX")"
mkdir -p "$pack_dir/package"
cat > "$pack_dir/package/package.json" <<'JSON'
{
  "name": "@openclaw/demo-plugin-tgz",
  "version": "0.0.1",
  "openclaw": { "extensions": ["./index.js"] }
}
JSON
cat > "$pack_dir/package/index.js" <<'JS'
module.exports = {
  id: "demo-plugin-tgz",
  name: "Demo Plugin TGZ",
  register(api) {
    api.registerGatewayMethod("demo.tgz", async () => ({ ok: true }));
  },
};
JS
cat > "$pack_dir/package/openclaw.plugin.json" <<'JSON'
{
  "id": "demo-plugin-tgz",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
JSON
tar -czf /tmp/demo-plugin-tgz.tgz -C "$pack_dir" package

run_logged install-tgz node "$OPENCLAW_ENTRY" plugins install /tmp/demo-plugin-tgz.tgz
node "$OPENCLAW_ENTRY" plugins list --json > /tmp/plugins2.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin-tgz --json > /tmp/plugins2-inspect.json

node - <<'NODE'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins2.json", "utf8"));
const inspect = JSON.parse(fs.readFileSync("/tmp/plugins2-inspect.json", "utf8"));
const plugin = (data.plugins || []).find((entry) => entry.id === "demo-plugin-tgz");
if (!plugin) throw new Error("tgz plugin not found");
if (plugin.status !== "loaded") {
  throw new Error(`unexpected status: ${plugin.status}`);
}
if (!Array.isArray(inspect.gatewayMethods) || !inspect.gatewayMethods.includes("demo.tgz")) {
  throw new Error("expected gateway method demo.tgz");
}
console.log("ok");
NODE

echo "Testing install from local folder (plugins.load.paths)..."
dir_plugin="$(mktemp -d "/tmp/openclaw-plugin-dir.XXXXXX")"
cat > "$dir_plugin/package.json" <<'JSON'
{
  "name": "@openclaw/demo-plugin-dir",
  "version": "0.0.1",
  "openclaw": { "extensions": ["./index.js"] }
}
JSON
cat > "$dir_plugin/index.js" <<'JS'
module.exports = {
  id: "demo-plugin-dir",
  name: "Demo Plugin DIR",
  register(api) {
    api.registerGatewayMethod("demo.dir", async () => ({ ok: true }));
  },
};
JS
cat > "$dir_plugin/openclaw.plugin.json" <<'JSON'
{
  "id": "demo-plugin-dir",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
JSON

run_logged install-dir node "$OPENCLAW_ENTRY" plugins install "$dir_plugin"
node "$OPENCLAW_ENTRY" plugins list --json > /tmp/plugins3.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin-dir --json > /tmp/plugins3-inspect.json

node - <<'NODE'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins3.json", "utf8"));
const inspect = JSON.parse(fs.readFileSync("/tmp/plugins3-inspect.json", "utf8"));
const plugin = (data.plugins || []).find((entry) => entry.id === "demo-plugin-dir");
if (!plugin) throw new Error("dir plugin not found");
if (plugin.status !== "loaded") {
  throw new Error(`unexpected status: ${plugin.status}`);
}
if (!Array.isArray(inspect.gatewayMethods) || !inspect.gatewayMethods.includes("demo.dir")) {
  throw new Error("expected gateway method demo.dir");
}
console.log("ok");
NODE

echo "Testing install from npm spec (file:)..."
file_pack_dir="$(mktemp -d "/tmp/openclaw-plugin-filepack.XXXXXX")"
mkdir -p "$file_pack_dir/package"
cat > "$file_pack_dir/package/package.json" <<'JSON'
{
  "name": "@openclaw/demo-plugin-file",
  "version": "0.0.1",
  "openclaw": { "extensions": ["./index.js"] }
}
JSON
cat > "$file_pack_dir/package/index.js" <<'JS'
module.exports = {
  id: "demo-plugin-file",
  name: "Demo Plugin FILE",
  register(api) {
    api.registerGatewayMethod("demo.file", async () => ({ ok: true }));
  },
};
JS
cat > "$file_pack_dir/package/openclaw.plugin.json" <<'JSON'
{
  "id": "demo-plugin-file",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
JSON

run_logged install-file node "$OPENCLAW_ENTRY" plugins install "file:$file_pack_dir/package"
node "$OPENCLAW_ENTRY" plugins list --json > /tmp/plugins4.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin-file --json > /tmp/plugins4-inspect.json

node - <<'NODE'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins4.json", "utf8"));
const inspect = JSON.parse(fs.readFileSync("/tmp/plugins4-inspect.json", "utf8"));
const plugin = (data.plugins || []).find((entry) => entry.id === "demo-plugin-file");
if (!plugin) throw new Error("file plugin not found");
if (plugin.status !== "loaded") {
  throw new Error(`unexpected status: ${plugin.status}`);
}
if (!Array.isArray(inspect.gatewayMethods) || !inspect.gatewayMethods.includes("demo.file")) {
  throw new Error("expected gateway method demo.file");
}
console.log("ok");
NODE

echo "Testing /plugin alias with Claude bundle restart semantics..."
bundle_plugin_id="claude-bundle-e2e"
bundle_root="$OPENCLAW_PLUGIN_HOME/$bundle_plugin_id"
mkdir -p "$bundle_root/.claude-plugin" "$bundle_root/commands"
cat > "$bundle_root/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "claude-bundle-e2e"
}
JSON
cat > "$bundle_root/commands/office-hours.md" <<'MD'
---
description: Help with architecture and rollout planning
---
Act as an engineering advisor.

Focus on:
$ARGUMENTS
MD
record_fixture_plugin_trust "$bundle_plugin_id" "$bundle_root" 0

node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : {};
config.gateway = {
  ...(config.gateway || {}),
  port: 18789,
  auth: { mode: "token", token: "plugin-e2e-token" },
  controlUi: { enabled: false },
};
if (process.env.OPENAI_API_KEY) {
  config.agents = {
    ...(config.agents || {}),
    defaults: {
      ...(config.agents?.defaults || {}),
      // Use the same stable OpenAI family as the installer E2E to avoid
      // long or reasoning-heavy live turns in this bundle-command smoke.
      model: { primary: "openai/gpt-4.1-mini" },
    },
  };
}
config.commands = {
  ...(config.commands || {}),
  text: true,
  plugins: true,
};
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
NODE

if [ -n "${OPENAI_API_KEY:-}" ]; then
  seed_openai_provider_config "$OPENAI_API_KEY" "${OPENAI_BASE_URL:-}"
fi

gateway_log="/tmp/openclaw-plugin-command-e2e.log"
start_gateway "$gateway_log"
wait_for_gateway_health

echo "Testing /plugin install with auto-restart..."
slash_install_dir="$(mktemp -d "/tmp/openclaw-plugin-slash-install.XXXXXX")"
cat > "$slash_install_dir/package.json" <<'JSON'
{
  "name": "@openclaw/slash-install-plugin",
  "version": "0.0.1",
  "openclaw": { "extensions": ["./index.js"] }
}
JSON
cat > "$slash_install_dir/index.js" <<'JS'
module.exports = {
  id: "slash-install-plugin",
  name: "Slash Install Plugin",
  register(api) {
    api.registerGatewayMethod("demo.slash.install", async () => ({ ok: true }));
  },
};
JS
cat > "$slash_install_dir/openclaw.plugin.json" <<'JSON'
{
  "id": "slash-install-plugin",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
JSON

run_gateway_chat_json \
  "plugin-e2e-install" \
  "/plugin install $slash_install_dir" \
  /tmp/plugin-command-install.json \
  30000
node - <<'NODE'
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync("/tmp/plugin-command-install.json", "utf8"));
const text = payload.text || "";
if (!text.includes('Installed plugin "slash-install-plugin"')) {
  throw new Error(`expected install confirmation, got:\n${text}`);
}
if (!text.includes("Restart the gateway to load plugins.")) {
  throw new Error(`expected restart hint, got:\n${text}`);
}
console.log("ok");
NODE

wait_for_gateway_health
run_gateway_chat_json "plugin-e2e-install-show" "/plugin show slash-install-plugin" /tmp/plugin-command-install-show.json
node - <<'NODE'
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync("/tmp/plugin-command-install-show.json", "utf8"));
const text = payload.text || "";
if (!text.includes('"status": "loaded"')) {
  throw new Error(`expected loaded status after slash install, got:\n${text}`);
}
if (!text.includes('"enabled": true')) {
  throw new Error(`expected enabled status after slash install, got:\n${text}`);
}
if (!text.includes('"demo.slash.install"')) {
  throw new Error(`expected installed gateway method, got:\n${text}`);
}
console.log("ok");
NODE

run_gateway_chat_json "plugin-e2e-list" "/plugin list" /tmp/plugin-command-list.json
node - <<'NODE'
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync("/tmp/plugin-command-list.json", "utf8"));
const text = payload.text || "";
if (!text.includes("claude-bundle-e2e")) {
  throw new Error(`expected plugin in /plugin list output, got:\n${text}`);
}
if (!text.includes("[disabled]")) {
  throw new Error(`expected disabled status before enable, got:\n${text}`);
}
console.log("ok");
NODE

run_gateway_chat_json \
  "plugin-e2e-enable" \
  "/plugin enable claude-bundle-e2e" \
  /tmp/plugin-command-enable.json \
  60000
node - <<'NODE'
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync("/tmp/plugin-command-enable.json", "utf8"));
const text = payload.text || "";
if (!text.includes('Plugin "claude-bundle-e2e" enabled')) {
  throw new Error(`expected enable confirmation, got:\n${text}`);
}
if (!text.includes("Restart the gateway to apply.")) {
  throw new Error(`expected restart hint, got:\n${text}`);
}
console.log("ok");
NODE

wait_for_gateway_health
run_gateway_chat_json "plugin-e2e-show" "/plugin show claude-bundle-e2e" /tmp/plugin-command-show.json
node - <<'NODE'
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync("/tmp/plugin-command-show.json", "utf8"));
const text = payload.text || "";
if (!text.includes('"bundleFormat": "claude"')) {
  throw new Error(`expected Claude bundle inspect payload, got:\n${text}`);
}
if (!text.includes('"enabled": true')) {
  throw new Error(`expected enabled inspect payload, got:\n${text}`);
}
console.log("ok");
NODE

if [ -n "${OPENAI_API_KEY:-}" ]; then
  echo "Testing Claude bundle command invocation..."
  if ! run_gateway_chat_json \
    "plugin-e2e-live" \
    "/office_hours Reply with exactly BUNDLE_OK and nothing else." \
    /tmp/plugin-command-live.json \
    120000; then
    echo "Claude bundle command invocation failed; payload dump:"
    cat /tmp/plugin-command-live.json 2>/dev/null || true
    echo "Gateway log tail:"
    tail -n 200 "$gateway_log" || true
    exit 1
  fi
  node - <<'NODE'
const fs = require("node:fs");
const payload = JSON.parse(fs.readFileSync("/tmp/plugin-command-live.json", "utf8"));
const text = payload.text || "";
if (!text.includes("BUNDLE_OK")) {
  throw new Error(`expected Claude bundle command reply, got:\n${text}`);
}
console.log("ok");
NODE
else
  echo "Skipping live Claude bundle command invocation (OPENAI_API_KEY not set)."
fi

echo "Testing marketplace install and update flows..."
marketplace_root="$HOME/.claude/plugins/marketplaces/fixture-marketplace"
mkdir -p "$HOME/.claude/plugins" "$marketplace_root/.claude-plugin"
write_fixture_plugin \
  "$marketplace_root/plugins/marketplace-shortcut" \
  "marketplace-shortcut" \
  "0.0.1" \
  "demo.marketplace.shortcut.v1" \
  "Marketplace Shortcut"
write_fixture_plugin \
  "$marketplace_root/plugins/marketplace-direct" \
  "marketplace-direct" \
  "0.0.1" \
  "demo.marketplace.direct.v1" \
  "Marketplace Direct"
cat > "$marketplace_root/.claude-plugin/marketplace.json" <<'JSON'
{
  "name": "Fixture Marketplace",
  "version": "1.0.0",
  "plugins": [
    {
      "name": "marketplace-shortcut",
      "version": "0.0.1",
      "description": "Shortcut install fixture",
      "source": "./plugins/marketplace-shortcut"
    },
    {
      "name": "marketplace-direct",
      "version": "0.0.1",
      "description": "Explicit marketplace fixture",
      "source": {
        "type": "path",
        "path": "./plugins/marketplace-direct"
      }
    }
  ]
}
JSON
cat > "$HOME/.claude/plugins/known_marketplaces.json" <<JSON
{
  "claude-fixtures": {
    "installLocation": "$marketplace_root",
    "source": {
      "type": "github",
      "repo": "openclaw/fixture-marketplace"
    }
  }
}
JSON

node "$OPENCLAW_ENTRY" plugins marketplace list claude-fixtures --json > /tmp/marketplace-list.json

node - <<'NODE'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/marketplace-list.json", "utf8"));
const names = (data.plugins || []).map((entry) => entry.name).sort();
if (data.name !== "Fixture Marketplace") {
  throw new Error(`unexpected marketplace name: ${data.name}`);
}
if (!names.includes("marketplace-shortcut") || !names.includes("marketplace-direct")) {
  throw new Error(`unexpected marketplace plugins: ${names.join(", ")}`);
}
console.log("ok");
NODE

run_logged install-marketplace-shortcut node "$OPENCLAW_ENTRY" plugins install marketplace-shortcut@claude-fixtures
run_logged install-marketplace-direct node "$OPENCLAW_ENTRY" plugins install marketplace-direct --marketplace claude-fixtures
node "$OPENCLAW_ENTRY" plugins list --json > /tmp/plugins-marketplace.json
node "$OPENCLAW_ENTRY" plugins inspect marketplace-shortcut --json > /tmp/plugins-marketplace-shortcut-inspect.json
node "$OPENCLAW_ENTRY" plugins inspect marketplace-direct --json > /tmp/plugins-marketplace-direct-inspect.json

node - <<'NODE'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins-marketplace.json", "utf8"));
const shortcutInspect = JSON.parse(
  fs.readFileSync("/tmp/plugins-marketplace-shortcut-inspect.json", "utf8"),
);
const directInspect = JSON.parse(
  fs.readFileSync("/tmp/plugins-marketplace-direct-inspect.json", "utf8"),
);
const getPlugin = (id) => {
  const plugin = (data.plugins || []).find((entry) => entry.id === id);
  if (!plugin) throw new Error(`plugin not found: ${id}`);
  if (plugin.status !== "loaded") {
    throw new Error(`unexpected status for ${id}: ${plugin.status}`);
  }
  return plugin;
};

const shortcut = getPlugin("marketplace-shortcut");
const direct = getPlugin("marketplace-direct");
if (shortcut.version !== "0.0.1") {
  throw new Error(`unexpected shortcut version: ${shortcut.version}`);
}
if (direct.version !== "0.0.1") {
  throw new Error(`unexpected direct version: ${direct.version}`);
}
if (!shortcutInspect.gatewayMethods.includes("demo.marketplace.shortcut.v1")) {
  throw new Error("expected marketplace shortcut gateway method");
}
if (!directInspect.gatewayMethods.includes("demo.marketplace.direct.v1")) {
  throw new Error("expected marketplace direct gateway method");
}
console.log("ok");
NODE

node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
for (const id of ["marketplace-shortcut", "marketplace-direct"]) {
  const record = config.plugins?.installs?.[id];
  if (!record) throw new Error(`missing install record for ${id}`);
  if (record.source !== "marketplace") {
    throw new Error(`unexpected source for ${id}: ${record.source}`);
  }
  if (record.marketplaceSource !== "claude-fixtures") {
    throw new Error(`unexpected marketplace source for ${id}: ${record.marketplaceSource}`);
  }
  if (record.marketplacePlugin !== id) {
    throw new Error(`unexpected marketplace plugin for ${id}: ${record.marketplacePlugin}`);
  }
}
console.log("ok");
NODE

write_fixture_plugin \
  "$marketplace_root/plugins/marketplace-shortcut" \
  "marketplace-shortcut" \
  "0.0.2" \
  "demo.marketplace.shortcut.v2" \
  "Marketplace Shortcut"
run_logged update-marketplace-shortcut-dry-run node "$OPENCLAW_ENTRY" plugins update marketplace-shortcut --dry-run
run_logged update-marketplace-shortcut node "$OPENCLAW_ENTRY" plugins update marketplace-shortcut
node "$OPENCLAW_ENTRY" plugins list --json > /tmp/plugins-marketplace-updated.json
node "$OPENCLAW_ENTRY" plugins inspect marketplace-shortcut --json > /tmp/plugins-marketplace-updated-inspect.json

node - <<'NODE'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins-marketplace-updated.json", "utf8"));
const inspect = JSON.parse(fs.readFileSync("/tmp/plugins-marketplace-updated-inspect.json", "utf8"));
const plugin = (data.plugins || []).find((entry) => entry.id === "marketplace-shortcut");
if (!plugin) throw new Error("updated marketplace plugin not found");
if (plugin.version !== "0.0.2") {
  throw new Error(`unexpected updated version: ${plugin.version}`);
}
if (!inspect.gatewayMethods.includes("demo.marketplace.shortcut.v2")) {
  throw new Error(`expected updated gateway method, got ${inspect.gatewayMethods.join(", ")}`);
}
console.log("ok");
NODE

echo "Running bundle MCP CLI-agent e2e..."
node scripts/run-vitest.mjs run --config test/vitest/vitest.e2e.config.ts src/agents/cli-runner.bundle-mcp.e2e.test.ts
EOF
then
  cat "$RUN_LOG"
  rm -f "$RUN_LOG"
  exit 1
fi
rm -f "$RUN_LOG"

echo "OK"
