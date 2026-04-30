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
write_demo_fixture_plugin "$demo_plugin_root"
record_fixture_plugin_trust "$demo_plugin_id" "$demo_plugin_root" 1

node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin --json >/tmp/plugins-inspect.json

node scripts/e2e/lib/plugins/assertions.mjs demo-plugin

echo "Testing tgz install flow..."
pack_dir="$(mktemp -d "/tmp/openclaw-plugin-pack.XXXXXX")"
pack_fixture_plugin "$pack_dir" /tmp/demo-plugin-tgz.tgz demo-plugin-tgz 0.0.1 demo.tgz "Demo Plugin TGZ"

run_logged install-tgz node "$OPENCLAW_ENTRY" plugins install /tmp/demo-plugin-tgz.tgz
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins2.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin-tgz --json >/tmp/plugins2-inspect.json

node scripts/e2e/lib/plugins/assertions.mjs plugin-tgz

echo "Testing install from local folder (plugins.load.paths)..."
dir_plugin="$(mktemp -d "/tmp/openclaw-plugin-dir.XXXXXX")"
write_fixture_plugin "$dir_plugin" demo-plugin-dir 0.0.1 demo.dir "Demo Plugin DIR"

run_logged install-dir node "$OPENCLAW_ENTRY" plugins install "$dir_plugin"
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins3.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin-dir --json >/tmp/plugins3-inspect.json

node scripts/e2e/lib/plugins/assertions.mjs plugin-dir

echo "Testing install from npm spec (file:)..."
file_pack_dir="$(mktemp -d "/tmp/openclaw-plugin-filepack.XXXXXX")"
write_fixture_plugin "$file_pack_dir/package" demo-plugin-file 0.0.1 demo.file "Demo Plugin FILE"

run_logged install-file node "$OPENCLAW_ENTRY" plugins install "file:$file_pack_dir/package"
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins4.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin-file --json >/tmp/plugins4-inspect.json

node scripts/e2e/lib/plugins/assertions.mjs plugin-file

echo "Testing Claude bundle enable and inspect flow..."
bundle_plugin_id="claude-bundle-e2e"
bundle_root="$OPENCLAW_PLUGIN_HOME/$bundle_plugin_id"
write_claude_bundle_fixture "$bundle_root"
record_fixture_plugin_trust "$bundle_plugin_id" "$bundle_root" 0

node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins-bundle-disabled.json
node scripts/e2e/lib/plugins/assertions.mjs bundle-disabled

run_logged enable-claude-bundle node "$OPENCLAW_ENTRY" plugins enable claude-bundle-e2e
node "$OPENCLAW_ENTRY" plugins inspect claude-bundle-e2e --json >/tmp/plugins-bundle-inspect.json
node scripts/e2e/lib/plugins/assertions.mjs bundle-inspect

echo "Testing plugin install visible after explicit restart..."
slash_install_dir="$(mktemp -d "/tmp/openclaw-plugin-slash-install.XXXXXX")"
write_fixture_plugin "$slash_install_dir" slash-install-plugin 0.0.1 demo.slash.install "Slash Install Plugin"

run_logged install-slash-plugin node "$OPENCLAW_ENTRY" plugins install "$slash_install_dir"
node "$OPENCLAW_ENTRY" plugins inspect slash-install-plugin --json >/tmp/plugin-command-install-show.json
node scripts/e2e/lib/plugins/assertions.mjs slash-install

run_plugins_marketplace_scenario

run_plugins_clawhub_scenario
