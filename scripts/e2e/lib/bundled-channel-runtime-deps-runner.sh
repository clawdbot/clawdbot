#!/usr/bin/env bash
#
# Scenario selection for bundled plugin runtime-dependency Docker tests.
# The large scenario bodies stay in the owning test script; this helper keeps
# env flag parsing and dispatch in one small, reviewable place.

bundled_channel_state_script_b64() {
  docker_e2e_test_state_shell_b64 "$1" empty
}

run_bundled_channel_container() {
  local label="$1"
  local timeout_value="$2"
  shift 2
  run_logged_print "$label" timeout "$timeout_value" docker run --rm \
    "${DOCKER_E2E_HARNESS_ARGS[@]}" \
    "$@"
}

run_bundled_channel_container_with_state() {
  local label="$1"
  local timeout_value="$2"
  local state_label="$3"
  shift 3
  local state_script_b64
  state_script_b64="$(bundled_channel_state_script_b64 "$state_label")"
  run_bundled_channel_container "$label" "$timeout_value" \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$state_script_b64" \
    "$@"
}

run_bundled_channel_container_with_state_heartbeat() {
  local label="$1"
  local heartbeat="$2"
  local timeout_value="$3"
  local state_label="$4"
  shift 4
  local state_script_b64
  state_script_b64="$(bundled_channel_state_script_b64 "$state_label")"
  run_logged_print_heartbeat "$label" "$heartbeat" timeout "$timeout_value" docker run --rm \
    "${DOCKER_E2E_HARNESS_ARGS[@]}" \
    -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$state_script_b64" \
    "$@"
}

run_bundled_channel_runtime_dep_scenarios() {
  if [ "$RUN_CHANNEL_SCENARIOS" != "0" ]; then
    IFS=',' read -r -a CHANNEL_SCENARIOS <<<"${OPENCLAW_BUNDLED_CHANNELS:-${CHANNEL_ONLY:-telegram,discord,slack,feishu,memory-lancedb}}"
    for channel_scenario in "${CHANNEL_SCENARIOS[@]}"; do
      channel_scenario="${channel_scenario//[[:space:]]/}"
      [ -n "$channel_scenario" ] || continue
      case "$channel_scenario" in
      telegram) run_channel_scenario telegram grammy ;;
      discord) run_channel_scenario discord discord-api-types ;;
      slack) run_channel_scenario slack @slack/web-api ;;
      feishu) run_channel_scenario feishu @larksuiteoapi/node-sdk ;;
      memory-lancedb) run_channel_scenario memory-lancedb @lancedb/lancedb ;;
      *)
        echo "Unsupported OPENCLAW_BUNDLED_CHANNELS entry: $channel_scenario" >&2
        exit 1
        ;;
      esac
    done
  fi

  if [ "$RUN_UPDATE_SCENARIO" != "0" ]; then
    run_update_scenario
  fi
  if [ "$RUN_ROOT_OWNED_SCENARIO" != "0" ]; then
    run_root_owned_global_scenario
  fi
  if [ "$RUN_SETUP_ENTRY_SCENARIO" != "0" ]; then
    run_setup_entry_scenario
  fi
  if [ "$RUN_DISABLED_CONFIG_SCENARIO" != "0" ]; then
    run_disabled_config_scenario
  fi
  if [ "$RUN_LOAD_FAILURE_SCENARIO" != "0" ]; then
    run_load_failure_scenario
  fi
}
