#!/usr/bin/env bash
#
# Scenario selection for bundled plugin runtime-dependency Docker tests.
# The large scenario bodies stay in the owning test script; this helper keeps
# env flag parsing and dispatch in one small, reviewable place.

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
