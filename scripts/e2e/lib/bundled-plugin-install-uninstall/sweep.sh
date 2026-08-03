#!/usr/bin/env bash
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
source scripts/lib/docker-e2e-logs.sh

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
runtime_smoke="scripts/e2e/lib/bundled-plugin-install-uninstall/runtime-smoke.mjs"
node "$probe" select > /tmp/bundled-plugin-sweep-ids
sweep_command_timeout="${OPENCLAW_BUNDLED_PLUGIN_SWEEP_COMMAND_TIMEOUT:-300s}"

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

run_logged_sweep_command() {
  local label="$1"
  local log_file="$2"
  shift 2
  if openclaw_e2e_maybe_timeout "$sweep_command_timeout" "$@" >"$log_file" 2>&1; then
    return 0
  else
    local status=$?
    docker_e2e_print_log "$log_file"
    if [ "$status" -eq 124 ]; then
      echo "Bundled plugin sweep command timed out after $sweep_command_timeout: $label" >&2
    else
      echo "Bundled plugin sweep command failed with status $status: $label" >&2
    fi
    return "$status"
  fi
}

lifecycle_trace_enabled() {
  case "${OPENCLAW_PLUGIN_LIFECYCLE_TRACE:-}" in
    1 | true | TRUE | yes | YES)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

plugin_entries=()
while IFS= read -r plugin_entry; do
  plugin_entries+=("$plugin_entry")
done < /tmp/bundled-plugin-sweep-ids
selected_labels=()
for plugin_entry in "${plugin_entries[@]}"; do
  IFS=$'\t' read -r plugin_id plugin_dir _requires_config _plugin_root <<<"$plugin_entry"
  selected_labels+=("${plugin_id}@${plugin_dir}")
done
echo "Selected ${#plugin_entries[@]} bundled plugins for shard ${OPENCLAW_BUNDLED_PLUGIN_SWEEP_INDEX:-0}/${OPENCLAW_BUNDLED_PLUGIN_SWEEP_TOTAL:-1}: ${selected_labels[*]}"

plugin_index=0
for plugin_entry in "${plugin_entries[@]}"; do
  IFS=$'\t' read -r plugin_id plugin_dir requires_config plugin_root <<<"$plugin_entry"
  install_log="/tmp/openclaw-install-${plugin_index}.log"
  uninstall_log="/tmp/openclaw-uninstall-${plugin_index}.log"
  plugin_started_at="$(now_ms)"
  echo "Installing bundled plugin: $plugin_id ($plugin_dir)"
  run_logged_sweep_command "install $plugin_id" "$install_log" \
    node "$OPENCLAW_ENTRY" plugins install "$plugin_id"
  if lifecycle_trace_enabled; then
    docker_e2e_print_log "$install_log"
  fi
  install_finished_at="$(now_ms)"
  node "$probe" assert-installed "$plugin_id" "$plugin_dir" "$requires_config" "$plugin_root"
  installed_asserted_at="$(now_ms)"
  if [[ "${OPENCLAW_BUNDLED_PLUGIN_RUNTIME_SMOKE:-1}" != "0" ]]; then
    echo "Running bundled plugin runtime smoke: $plugin_id ($plugin_dir)"
    node "$runtime_smoke" plugin "$plugin_id" "$plugin_dir" "$requires_config" "$plugin_index" "$plugin_root"
    node "$runtime_smoke" tts-global-disable "$plugin_id" "$plugin_dir" "$requires_config" "$plugin_index" "$plugin_root" ""
    if [[ "$plugin_id" == "${OPENCLAW_BUNDLED_PLUGIN_TTS_LIVE_PROVIDER:-openai}" ]]; then
      node "$runtime_smoke" tts-openai-live "$plugin_id" "$plugin_dir" "$requires_config" "$plugin_index"
    fi
  fi
  runtime_finished_at="$(now_ms)"

  echo "Uninstalling bundled plugin: $plugin_id ($plugin_dir)"
  run_logged_sweep_command "uninstall $plugin_id" "$uninstall_log" \
    node "$OPENCLAW_ENTRY" plugins uninstall "$plugin_id" --force
  if lifecycle_trace_enabled; then
    docker_e2e_print_log "$uninstall_log"
  fi
  uninstall_finished_at="$(now_ms)"
  node "$probe" assert-uninstalled "$plugin_id" "$plugin_dir"
  uninstalled_asserted_at="$(now_ms)"
  echo "Bundled plugin lifecycle timing: $plugin_id install_ms=$((install_finished_at - plugin_started_at)) install_assert_ms=$((installed_asserted_at - install_finished_at)) runtime_ms=$((runtime_finished_at - installed_asserted_at)) uninstall_ms=$((uninstall_finished_at - runtime_finished_at)) uninstall_assert_ms=$((uninstalled_asserted_at - uninstall_finished_at)) total_ms=$((uninstalled_asserted_at - plugin_started_at))"
  plugin_index=$((plugin_index + 1))
done

echo "bundled plugin install/uninstall sweep passed (${#plugin_entries[@]} plugin(s))"
