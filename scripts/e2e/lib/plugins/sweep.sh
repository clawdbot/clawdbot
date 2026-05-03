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
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin --runtime --json >/tmp/plugins-inspect.json

node scripts/e2e/lib/plugins/assertions.mjs demo-plugin

echo "Testing tgz install flow..."
pack_dir="$(mktemp -d "/tmp/openclaw-plugin-pack.XXXXXX")"
pack_fixture_plugin "$pack_dir" /tmp/demo-plugin-tgz.tgz demo-plugin-tgz 0.0.1 demo.tgz "Demo Plugin TGZ"

run_logged install-tgz node "$OPENCLAW_ENTRY" plugins install /tmp/demo-plugin-tgz.tgz
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins2.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin-tgz --runtime --json >/tmp/plugins2-inspect.json

node scripts/e2e/lib/plugins/assertions.mjs plugin-tgz

run_logged uninstall-tgz node "$OPENCLAW_ENTRY" plugins uninstall demo-plugin-tgz --force
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins2-uninstalled.json
node scripts/e2e/lib/plugins/assertions.mjs plugin-tgz-removed

echo "Testing install from local folder (plugins.load.paths)..."
dir_plugin="$(mktemp -d "/tmp/openclaw-plugin-dir.XXXXXX")"
write_fixture_plugin "$dir_plugin" demo-plugin-dir 0.0.1 demo.dir "Demo Plugin DIR"

run_logged install-dir node "$OPENCLAW_ENTRY" plugins install "$dir_plugin"
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins3.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin-dir --runtime --json >/tmp/plugins3-inspect.json

node scripts/e2e/lib/plugins/assertions.mjs plugin-dir "$dir_plugin"

node "$OPENCLAW_ENTRY" plugins update demo-plugin-dir >/tmp/plugins-dir-update.log 2>&1
node scripts/e2e/lib/plugins/assertions.mjs plugin-dir-update-skipped

run_logged uninstall-dir node "$OPENCLAW_ENTRY" plugins uninstall demo-plugin-dir --force
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins3-uninstalled.json
node scripts/e2e/lib/plugins/assertions.mjs plugin-dir-removed

echo "Testing install from local folder with preinstalled dependencies..."
dir_deps_plugin="$(mktemp -d "/tmp/openclaw-plugin-dir-deps.XXXXXX")"
write_fixture_plugin_with_vendored_dependency "$dir_deps_plugin" demo-plugin-dir-deps 0.0.1 demo.dir.deps "Demo Plugin DIR Deps"

run_logged install-dir-deps node "$OPENCLAW_ENTRY" plugins install "$dir_deps_plugin"
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins-dir-deps.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin-dir-deps --runtime --json >/tmp/plugins-dir-deps-inspect.json

node scripts/e2e/lib/plugins/assertions.mjs plugin-dir-deps "$dir_deps_plugin"

run_logged uninstall-dir-deps node "$OPENCLAW_ENTRY" plugins uninstall demo-plugin-dir-deps --force
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins-dir-deps-uninstalled.json
node scripts/e2e/lib/plugins/assertions.mjs plugin-dir-deps-removed

echo "Testing install from npm spec (file:)..."
file_pack_dir="$(mktemp -d "/tmp/openclaw-plugin-filepack.XXXXXX")"
write_fixture_plugin "$file_pack_dir/package" demo-plugin-file 0.0.1 demo.file "Demo Plugin FILE"

run_logged install-file node "$OPENCLAW_ENTRY" plugins install "file:$file_pack_dir/package"
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins4.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin-file --runtime --json >/tmp/plugins4-inspect.json

node scripts/e2e/lib/plugins/assertions.mjs plugin-file "$file_pack_dir/package"

run_logged uninstall-file node "$OPENCLAW_ENTRY" plugins uninstall demo-plugin-file --force
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins4-uninstalled.json
node scripts/e2e/lib/plugins/assertions.mjs plugin-file-removed

echo "Testing install and update from npm registry..."
npm_pack_dir="$(mktemp -d "/tmp/openclaw-plugin-npm-pack.XXXXXX")"
npm_dep_pack_dir="$(mktemp -d "/tmp/openclaw-plugin-npm-dep-pack.XXXXXX")"
npm_registry_dir="$(mktemp -d "/tmp/openclaw-plugin-npm-registry.XXXXXX")"
pack_fixture_plugin_with_cli_registry_dependency "$npm_pack_dir" /tmp/demo-plugin-npm.tgz demo-plugin-npm 0.0.1 demo.npm "Demo Plugin NPM" demo-npm "demo-plugin-npm:pong"
pack_fake_is_number_package "$npm_dep_pack_dir" /tmp/is-number-7.0.0.tgz
start_npm_fixture_registry "@openclaw/demo-plugin-npm" "0.0.1" /tmp/demo-plugin-npm.tgz "$npm_registry_dir" "is-number" "7.0.0" /tmp/is-number-7.0.0.tgz

run_logged install-npm node "$OPENCLAW_ENTRY" plugins install "npm:@openclaw/demo-plugin-npm@0.0.1"
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins-npm.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin-npm --runtime --json >/tmp/plugins-npm-inspect.json
run_logged exec-npm-plugin-cli bash -c 'node "$OPENCLAW_ENTRY" demo-npm ping >/tmp/plugins-npm-cli.txt'

node scripts/e2e/lib/plugins/assertions.mjs plugin-npm

node "$OPENCLAW_ENTRY" plugins update demo-plugin-npm >/tmp/plugins-npm-update.log 2>&1
node scripts/e2e/lib/plugins/assertions.mjs plugin-npm-update

run_logged uninstall-npm node "$OPENCLAW_ENTRY" plugins uninstall demo-plugin-npm --force
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins-npm-uninstalled.json
node scripts/e2e/lib/plugins/assertions.mjs plugin-npm-removed

echo "Testing install from git repo and plugin CLI execution..."
git_fixture_root="$(mktemp -d "/tmp/openclaw-plugin-git.XXXXXX")"
git_repo="$git_fixture_root/repo"
git_repo_url="file://$git_repo"
write_fixture_plugin_with_cli "$git_repo" demo-plugin-git 0.0.1 demo.git "Demo Plugin Git" demo-git "demo-plugin-git:pong"
git -C "$git_repo" init -q
git -C "$git_repo" config user.email "docker-e2e@openclaw.local"
git -C "$git_repo" config user.name "OpenClaw Docker E2E"
git -C "$git_repo" add -A
git -C "$git_repo" commit -qm "test fixture"
git_ref="$(git -C "$git_repo" rev-parse HEAD)"

run_logged install-git node "$OPENCLAW_ENTRY" plugins install "git:$git_repo_url@$git_ref"
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins-git.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin-git --runtime --json >/tmp/plugins-git-inspect.json
run_logged exec-git-plugin-cli bash -c 'node "$OPENCLAW_ENTRY" demo-git ping >/tmp/plugins-git-cli.txt'

node scripts/e2e/lib/plugins/assertions.mjs plugin-git "$git_repo_url" "$git_ref"

run_logged uninstall-git node "$OPENCLAW_ENTRY" plugins uninstall demo-plugin-git --force
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins-git-uninstalled.json
node scripts/e2e/lib/plugins/assertions.mjs plugin-git-removed

echo "Testing git plugin update from moving ref..."
git_update_fixture_root="$(mktemp -d "/tmp/openclaw-plugin-git-update.XXXXXX")"
git_update_repo="$git_update_fixture_root/repo"
git_update_repo_url="file://$git_update_repo"
write_fixture_plugin_with_cli "$git_update_repo" demo-plugin-git-update 0.0.1 demo.git.update.v1 "Demo Plugin Git Update" demo-git-update "demo-plugin-git-update:pong-v1"
git -C "$git_update_repo" init -q
git -C "$git_update_repo" config user.email "docker-e2e@openclaw.local"
git -C "$git_update_repo" config user.name "OpenClaw Docker E2E"
git -C "$git_update_repo" checkout -qb main
git -C "$git_update_repo" add -A
git -C "$git_update_repo" commit -qm "test fixture v1"
git_update_ref_v1="$(git -C "$git_update_repo" rev-parse HEAD)"

run_logged install-git-update node "$OPENCLAW_ENTRY" plugins install "git:$git_update_repo_url@main"
write_fixture_plugin_with_cli "$git_update_repo" demo-plugin-git-update 0.0.2 demo.git.update.v2 "Demo Plugin Git Update" demo-git-update "demo-plugin-git-update:pong-v2"
git -C "$git_update_repo" add -A
git -C "$git_update_repo" commit -qm "test fixture v2"

node "$OPENCLAW_ENTRY" plugins update demo-plugin-git-update >/tmp/plugins-git-update.log 2>&1
node "$OPENCLAW_ENTRY" plugins list --json >/tmp/plugins-git-update.json
node "$OPENCLAW_ENTRY" plugins inspect demo-plugin-git-update --runtime --json >/tmp/plugins-git-update-inspect.json
run_logged exec-updated-git-plugin-cli bash -c 'node "$OPENCLAW_ENTRY" demo-git-update ping >/tmp/plugins-git-update-cli.txt'

node scripts/e2e/lib/plugins/assertions.mjs plugin-git-updated "$git_update_ref_v1"

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
node "$OPENCLAW_ENTRY" plugins inspect slash-install-plugin --runtime --json >/tmp/plugin-command-install-show.json
node scripts/e2e/lib/plugins/assertions.mjs slash-install

run_plugins_marketplace_scenario

run_plugins_clawhub_scenario
