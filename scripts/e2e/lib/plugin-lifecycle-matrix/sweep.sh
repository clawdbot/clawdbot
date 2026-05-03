#!/usr/bin/env bash
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh

openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
openclaw_e2e_install_package /tmp/openclaw-plugin-lifecycle-install.log "mounted OpenClaw package" /tmp/npm-prefix

package_root="$(openclaw_e2e_package_root /tmp/npm-prefix)"
entry="$(openclaw_e2e_package_entrypoint "$package_root")"
export PATH="/tmp/npm-prefix/bin:$PATH"
export npm_config_loglevel=error
export npm_config_fund=false
export npm_config_audit=false

source scripts/e2e/lib/plugins/fixtures.sh

plugin_id="lifecycle-claw"
package_name="@openclaw/lifecycle-claw"
probe="scripts/e2e/lib/plugin-lifecycle-matrix/probe.mjs"
measure="scripts/e2e/lib/plugin-lifecycle-matrix/measure.mjs"
resource_dir="/tmp/openclaw-plugin-lifecycle-matrix"
mkdir -p "$resource_dir"
summary_tsv="$resource_dir/resource-summary.tsv"
printf "phase\tmax_rss_kb\tcpu_seconds\twall_ms\tcpu_core_ratio\tsignal\n" >"$summary_tsv"

run_measured() {
  local phase="$1"
  shift

  echo "Running plugin lifecycle phase: $phase"
  node "$measure" "$summary_tsv" "$phase" -- "$@"
}

pack_root="$(mktemp -d "/tmp/openclaw-plugin-lifecycle-pack.XXXXXX")"
registry_root="$(mktemp -d "/tmp/openclaw-plugin-lifecycle-registry.XXXXXX")"
pack_fixture_plugin "$pack_root/v1" /tmp/lifecycle-claw-1.0.0.tgz "$plugin_id" 1.0.0 lifecycle.v1 "Lifecycle Claw"
pack_fixture_plugin "$pack_root/v2" /tmp/lifecycle-claw-2.0.0.tgz "$plugin_id" 2.0.0 lifecycle.v2 "Lifecycle Claw"
start_npm_fixture_registry "$package_name" 1.0.0 /tmp/lifecycle-claw-1.0.0.tgz "$registry_root" "$package_name" 2.0.0 /tmp/lifecycle-claw-2.0.0.tgz

run_measured install-v1 node "$entry" plugins install "npm:$package_name@1.0.0"
node "$probe" assert-version "$plugin_id" 1.0.0

run_measured inspect-v1 bash -c 'node "$1" plugins inspect "$2" --runtime --json >/tmp/plugin-lifecycle-inspect-v1.json' bash "$entry" "$plugin_id"

run_measured disable node "$entry" plugins disable "$plugin_id"
node "$probe" assert-enabled "$plugin_id" false

run_measured enable node "$entry" plugins enable "$plugin_id"
node "$probe" assert-enabled "$plugin_id" true

run_measured upgrade-v2 node "$entry" plugins update "$package_name@2.0.0"
node "$probe" assert-version "$plugin_id" 2.0.0

run_measured downgrade-v1 node "$entry" plugins update "$package_name@1.0.0"
node "$probe" assert-version "$plugin_id" 1.0.0

install_path="$(node "$probe" install-path "$plugin_id")"
rm -rf "$install_path"
if [[ -e "$install_path" ]]; then
  echo "Failed to remove plugin code before missing-code uninstall: $install_path" >&2
  exit 1
fi

run_measured missing-code-uninstall node "$entry" plugins uninstall "$plugin_id" --force
node "$probe" assert-uninstalled "$plugin_id"

echo "Plugin lifecycle resource summary:"
cat "$summary_tsv"
echo "Plugin lifecycle matrix passed."
