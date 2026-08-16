run_plugins_marketplace_scenario() {
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
  node scripts/e2e/lib/fixture.mjs marketplace "$marketplace_root"

  run_plugins_openclaw_capture "$OPENCLAW_PLUGINS_TMP_DIR/marketplace-list.json" plugins marketplace list claude-fixtures --json

  node scripts/e2e/lib/plugins/assertions.mjs marketplace-list

  run_plugins_openclaw_logged install-marketplace-shortcut plugins install marketplace-shortcut@claude-fixtures --force
  run_plugins_openclaw_logged install-marketplace-direct plugins install marketplace-direct --marketplace claude-fixtures --force
  run_plugins_openclaw_capture "$OPENCLAW_PLUGINS_TMP_DIR/plugins-marketplace.json" plugins list --json
  run_plugins_openclaw_capture "$OPENCLAW_PLUGINS_TMP_DIR/plugins-marketplace-shortcut-inspect.json" plugins inspect marketplace-shortcut --runtime --json
  run_plugins_openclaw_capture "$OPENCLAW_PLUGINS_TMP_DIR/plugins-marketplace-direct-inspect.json" plugins inspect marketplace-direct --runtime --json

  node scripts/e2e/lib/plugins/assertions.mjs marketplace-installed

  node scripts/e2e/lib/plugins/assertions.mjs marketplace-records

  write_fixture_plugin \
    "$marketplace_root/plugins/marketplace-shortcut" \
    "marketplace-shortcut" \
    "0.0.2" \
    "demo.marketplace.shortcut.v2" \
    "Marketplace Shortcut"
  run_plugins_openclaw_logged update-marketplace-shortcut-dry-run plugins update marketplace-shortcut --dry-run
  run_plugins_openclaw_logged update-marketplace-shortcut plugins update marketplace-shortcut
  run_plugins_openclaw_capture "$OPENCLAW_PLUGINS_TMP_DIR/plugins-marketplace-updated.json" plugins list --json
  run_plugins_openclaw_capture "$OPENCLAW_PLUGINS_TMP_DIR/plugins-marketplace-updated-inspect.json" plugins inspect marketplace-shortcut --runtime --json

  node scripts/e2e/lib/plugins/assertions.mjs marketplace-updated
}
