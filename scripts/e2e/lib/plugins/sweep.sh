#!/usr/bin/env bash
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
source scripts/lib/docker-e2e-logs.sh
OPENCLAW_ENTRY="$(openclaw_e2e_resolve_entrypoint)"
export OPENCLAW_ENTRY
PACKAGE_VERSION="$(node -p 'require("./package.json").version')"
OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT="$(node scripts/e2e/lib/package-compat.mjs "$PACKAGE_VERSION")"
export OPENCLAW_PACKAGE_ACCEPTANCE_LEGACY_COMPAT

openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
BUNDLED_PLUGIN_ROOT_DIR="extensions"
OPENCLAW_PLUGIN_HOME="$HOME/.openclaw/$BUNDLED_PLUGIN_ROOT_DIR"

source scripts/e2e/lib/plugins/fixtures.sh
source scripts/e2e/lib/plugins/marketplace.sh
source scripts/e2e/lib/plugins/clawhub.sh
demo_plugin_id="demo-plugin"
demo_plugin_root="$OPENCLAW_PLUGIN_HOME/$demo_plugin_id"
mkdir -p "$demo_plugin_root"

cat >"$demo_plugin_root/index.js" <<'JS'
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
cat >"$demo_plugin_root/openclaw.plugin.json" <<'JSON'
{
  "id": "demo-plugin",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
JSON
record_fixture_plugin_trust "$demo_plugin_id" "$demo_plugin_root" 1

node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin --json >/tmp/plugins-inspect.json

node scripts/e2e/lib/plugins/assertions.mjs demo-plugin

echo "Testing tgz install flow..."
pack_dir="$(mktemp -d "/tmp/openclaw-plugin-pack.XXXXXX")"
mkdir -p "$pack_dir/package"
cat >"$pack_dir/package/package.json" <<'JSON'
{
  "name": "@openclaw/demo-plugin-tgz",
  "version": "0.0.1",
  "openclaw": { "extensions": ["./index.js"] }
}
JSON
cat >"$pack_dir/package/index.js" <<'JS'
module.exports = {
  id: "demo-plugin-tgz",
  name: "Demo Plugin TGZ",
  register(api) {
    api.registerGatewayMethod("demo.tgz", async () => ({ ok: true }));
  },
};
JS
cat >"$pack_dir/package/openclaw.plugin.json" <<'JSON'
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
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins2.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin-tgz --json >/tmp/plugins2-inspect.json

node scripts/e2e/lib/plugins/assertions.mjs plugin-tgz

echo "Testing install from local folder (plugins.load.paths)..."
dir_plugin="$(mktemp -d "/tmp/openclaw-plugin-dir.XXXXXX")"
cat >"$dir_plugin/package.json" <<'JSON'
{
  "name": "@openclaw/demo-plugin-dir",
  "version": "0.0.1",
  "openclaw": { "extensions": ["./index.js"] }
}
JSON
cat >"$dir_plugin/index.js" <<'JS'
module.exports = {
  id: "demo-plugin-dir",
  name: "Demo Plugin DIR",
  register(api) {
    api.registerGatewayMethod("demo.dir", async () => ({ ok: true }));
  },
};
JS
cat >"$dir_plugin/openclaw.plugin.json" <<'JSON'
{
  "id": "demo-plugin-dir",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
JSON

run_logged install-dir node "$OPENCLAW_ENTRY" plugins install "$dir_plugin"
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins3.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin-dir --json >/tmp/plugins3-inspect.json

node scripts/e2e/lib/plugins/assertions.mjs plugin-dir

echo "Testing install from npm spec (file:)..."
file_pack_dir="$(mktemp -d "/tmp/openclaw-plugin-filepack.XXXXXX")"
mkdir -p "$file_pack_dir/package"
cat >"$file_pack_dir/package/package.json" <<'JSON'
{
  "name": "@openclaw/demo-plugin-file",
  "version": "0.0.1",
  "openclaw": { "extensions": ["./index.js"] }
}
JSON
cat >"$file_pack_dir/package/index.js" <<'JS'
module.exports = {
  id: "demo-plugin-file",
  name: "Demo Plugin FILE",
  register(api) {
    api.registerGatewayMethod("demo.file", async () => ({ ok: true }));
  },
};
JS
cat >"$file_pack_dir/package/openclaw.plugin.json" <<'JSON'
{
  "id": "demo-plugin-file",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
JSON

run_logged install-file node "$OPENCLAW_ENTRY" plugins install "file:$file_pack_dir/package"
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins4.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin-file --json >/tmp/plugins4-inspect.json

node scripts/e2e/lib/plugins/assertions.mjs plugin-file

echo "Testing Claude bundle enable and inspect flow..."
bundle_plugin_id="claude-bundle-e2e"
bundle_root="$OPENCLAW_PLUGIN_HOME/$bundle_plugin_id"
mkdir -p "$bundle_root/.claude-plugin" "$bundle_root/commands"
cat >"$bundle_root/.claude-plugin/plugin.json" <<'JSON'
{
  "name": "claude-bundle-e2e"
}
JSON
cat >"$bundle_root/commands/office-hours.md" <<'MD'
---
description: Help with architecture and rollout planning
---
Act as an engineering advisor.

Focus on:
$ARGUMENTS
MD
record_fixture_plugin_trust "$bundle_plugin_id" "$bundle_root" 0

node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins-bundle-disabled.json
node scripts/e2e/lib/plugins/assertions.mjs bundle-disabled

run_logged enable-claude-bundle node "$OPENCLAW_ENTRY" plugins enable claude-bundle-e2e
node "$OPENCLAW_ENTRY" plugins inspect claude-bundle-e2e --json >/tmp/plugins-bundle-inspect.json
node scripts/e2e/lib/plugins/assertions.mjs bundle-inspect

echo "Testing plugin install visible after explicit restart..."
slash_install_dir="$(mktemp -d "/tmp/openclaw-plugin-slash-install.XXXXXX")"
cat >"$slash_install_dir/package.json" <<'JSON'
{
  "name": "@openclaw/slash-install-plugin",
  "version": "0.0.1",
  "openclaw": { "extensions": ["./index.js"] }
}
JSON
cat >"$slash_install_dir/index.js" <<'JS'
module.exports = {
  id: "slash-install-plugin",
  name: "Slash Install Plugin",
  register(api) {
    api.registerGatewayMethod("demo.slash.install", async () => ({ ok: true }));
  },
};
JS
cat >"$slash_install_dir/openclaw.plugin.json" <<'JSON'
{
  "id": "slash-install-plugin",
  "configSchema": {
    "type": "object",
    "properties": {}
  }
}
JSON

run_logged install-slash-plugin node "$OPENCLAW_ENTRY" plugins install "$slash_install_dir"
node "$OPENCLAW_ENTRY" plugins inspect slash-install-plugin --json >/tmp/plugin-command-install-show.json
node scripts/e2e/lib/plugins/assertions.mjs slash-install

run_plugins_marketplace_scenario

run_plugins_clawhub_scenario
