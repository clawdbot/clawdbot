#!/usr/bin/env bash
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh

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

openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"

probe="scripts/e2e/lib/bundled-plugin-install-uninstall/probe.mjs"
node "$probe" select > /tmp/bundled-plugin-sweep-ids

mapfile -t plugin_entries < /tmp/bundled-plugin-sweep-ids
selected_labels=()
for plugin_entry in "${plugin_entries[@]}"; do
  IFS=$'\t' read -r plugin_id plugin_dir _requires_config <<<"$plugin_entry"
  selected_labels+=("${plugin_id}@${plugin_dir}")
done
echo "Selected ${#plugin_entries[@]} bundled plugins for shard ${OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX:-0}/${OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL:-1}: ${selected_labels[*]}"

plugin_index=0
for plugin_entry in "${plugin_entries[@]}"; do
  IFS=$'\t' read -r plugin_id plugin_dir requires_config <<<"$plugin_entry"
  install_log="/tmp/openclaw-install-${plugin_index}.log"
  uninstall_log="/tmp/openclaw-uninstall-${plugin_index}.log"
  echo "Installing bundled plugin: $plugin_id ($plugin_dir)"
  node "$OPENCLAW_ENTRY" plugins install "$plugin_id" >"$install_log" 2>&1 || {
    cat "$install_log"
    exit 1
  }
  node "$probe" assert-installed "$plugin_id" "$plugin_dir" "$requires_config"

  echo "Uninstalling bundled plugin: $plugin_id ($plugin_dir)"
  node "$OPENCLAW_ENTRY" plugins uninstall "$plugin_id" --force >"$uninstall_log" 2>&1 || {
    cat "$uninstall_log"
    exit 1
  }
  node "$probe" assert-uninstalled "$plugin_id" "$plugin_dir"
  plugin_index=$((plugin_index + 1))
done

echo "bundled plugin install/uninstall sweep passed (${#plugin_entries[@]} plugin(s))"
