#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE_NAME="moltbot-plugins-e2e"

echo "Building Docker image..."
docker build -t "$IMAGE_NAME" -f "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR"

echo "Running plugins Docker E2E..."
docker run --rm -t "$IMAGE_NAME" bash -lc '
  set -euo pipefail

  home_dir=$(mktemp -d "/tmp/moltbot-plugins-e2e.XXXXXX")
  export HOME="$home_dir"
  mkdir -p "$HOME/.clawdbot/extensions"

  cat > "$HOME/.clawdbot/extensions/demo-plugin.js" <<'"'"'JS'"'"'
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

  node dist/index.js plugins list --json > /tmp/plugins.json

  node - <<'"'"'NODE'"'"'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins.json", "utf8"));
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

assertIncludes(plugin.toolNames, "demo_tool", "tool");
assertIncludes(plugin.gatewayMethods, "demo.ping", "gateway method");
assertIncludes(plugin.cliCommands, "demo", "cli command");
assertIncludes(plugin.services, "demo-service", "service");

const diagErrors = (data.diagnostics || []).filter((diag) => diag.level === "error");
if (diagErrors.length > 0) {
  throw new Error(`diagnostics errors: ${diagErrors.map((diag) => diag.message).join("; ")}`);
}

console.log("ok");
NODE

  echo "Testing tgz install flow..."
  pack_dir="$(mktemp -d "/tmp/moltbot-plugin-pack.XXXXXX")"
  mkdir -p "$pack_dir/package"
  cat > "$pack_dir/package/package.json" <<'"'"'JSON'"'"'
{
  "name": "@moltbot/demo-plugin-tgz",
  "version": "0.0.1",
  "moltbot": { "extensions": ["./index.js"] }
}
JSON
  cat > "$pack_dir/package/index.js" <<'"'"'JS'"'"'
module.exports = {
  id: "demo-plugin-tgz",
  name: "Demo Plugin TGZ",
  register(api) {
    api.registerGatewayMethod("demo.tgz", async () => ({ ok: true }));
  },
};
JS
  tar -czf /tmp/demo-plugin-tgz.tgz -C "$pack_dir" package

  node dist/index.js plugins install /tmp/demo-plugin-tgz.tgz
  node dist/index.js plugins list --json > /tmp/plugins2.json

  node - <<'"'"'NODE'"'"'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins2.json", "utf8"));
const plugin = (data.plugins || []).find((entry) => entry.id === "demo-plugin-tgz");
if (!plugin) throw new Error("tgz plugin not found");
if (plugin.status !== "loaded") {
  throw new Error(`unexpected status: ${plugin.status}`);
}
if (!Array.isArray(plugin.gatewayMethods) || !plugin.gatewayMethods.includes("demo.tgz")) {
  throw new Error("expected gateway method demo.tgz");
}
console.log("ok");
NODE

  echo "Testing install from local folder (plugins.load.paths)..."
  dir_plugin="$(mktemp -d "/tmp/moltbot-plugin-dir.XXXXXX")"
  cat > "$dir_plugin/package.json" <<'"'"'JSON'"'"'
{
  "name": "@moltbot/demo-plugin-dir",
  "version": "0.0.1",
  "moltbot": { "extensions": ["./index.js"] }
}
JSON
  cat > "$dir_plugin/index.js" <<'"'"'JS'"'"'
module.exports = {
  id: "demo-plugin-dir",
  name: "Demo Plugin DIR",
  register(api) {
    api.registerGatewayMethod("demo.dir", async () => ({ ok: true }));
  },
};
JS

  node dist/index.js plugins install "$dir_plugin"
  node dist/index.js plugins list --json > /tmp/plugins3.json

  node - <<'"'"'NODE'"'"'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins3.json", "utf8"));
const plugin = (data.plugins || []).find((entry) => entry.id === "demo-plugin-dir");
if (!plugin) throw new Error("dir plugin not found");
if (plugin.status !== "loaded") {
  throw new Error(`unexpected status: ${plugin.status}`);
}
if (!Array.isArray(plugin.gatewayMethods) || !plugin.gatewayMethods.includes("demo.dir")) {
  throw new Error("expected gateway method demo.dir");
}
console.log("ok");
NODE

  echo "Testing install from npm spec (file:)..."
  file_pack_dir="$(mktemp -d "/tmp/moltbot-plugin-filepack.XXXXXX")"
  mkdir -p "$file_pack_dir/package"
  cat > "$file_pack_dir/package/package.json" <<'"'"'JSON'"'"'
{
  "name": "@moltbot/demo-plugin-file",
  "version": "0.0.1",
  "moltbot": { "extensions": ["./index.js"] }
}
JSON
  cat > "$file_pack_dir/package/index.js" <<'"'"'JS'"'"'
module.exports = {
  id: "demo-plugin-file",
  name: "Demo Plugin FILE",
  register(api) {
    api.registerGatewayMethod("demo.file", async () => ({ ok: true }));
  },
};
JS

  node dist/index.js plugins install "file:$file_pack_dir/package"
  node dist/index.js plugins list --json > /tmp/plugins4.json

  node - <<'"'"'NODE'"'"'
const fs = require("node:fs");

const data = JSON.parse(fs.readFileSync("/tmp/plugins4.json", "utf8"));
const plugin = (data.plugins || []).find((entry) => entry.id === "demo-plugin-file");
if (!plugin) throw new Error("file plugin not found");
if (plugin.status !== "loaded") {
  throw new Error(`unexpected status: ${plugin.status}`);
}
if (!Array.isArray(plugin.gatewayMethods) || !plugin.gatewayMethods.includes("demo.file")) {
  throw new Error("expected gateway method demo.file");
}
console.log("ok");
NODE
'

echo "OK"
