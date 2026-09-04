#!/usr/bin/env bash
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
source scripts/e2e/lib/prepublish-plugin-registry.sh

mode="${1:?missing provider mode}"
port="${2:?missing gateway port}"
mock_port="${3:-}"
log_prefix="/tmp/mcp-code-mode"
case "$mode" in
  live)
    log_prefix="$log_prefix-live"
    unset OPENCLAW_TESTBOX
    if [ -z "${OPENAI_API_KEY:-}" ]; then
      echo "ERROR: OPENAI_API_KEY was not available inside the container." >&2
      exit 1
    fi
    ;;
  mock)
    : "${mock_port:?missing mock provider port}"
    export OPENCLAW_DOCKER_OPENAI_BASE_URL="http://127.0.0.1:$mock_port/v1"
    ;;
  *) echo "Unknown MCP code-mode provider mode: $mode" >&2; exit 2 ;;
esac

openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
entry="$(openclaw_e2e_resolve_entrypoint)"
gateway_pid=""
mock_pid=""
plugin_registry_pid=""
cleanup() {
  openclaw_e2e_stop_process "$gateway_pid"
  openclaw_e2e_stop_process "$mock_pid"
  openclaw_e2e_stop_process "$plugin_registry_pid"
}
trap cleanup EXIT
dump_debug_logs() {
  echo "MCP code-mode $mode scenario failed with exit code $1" >&2
  openclaw_e2e_dump_logs \
    "$log_prefix-gateway.log" \
    "$log_prefix-seed.log" \
    "$log_prefix-plugin-install.log" \
    "$log_prefix-plugin-registry/server.log" \
    /tmp/mcp-code-mode-mock-openai.log
}
openclaw_e2e_enable_failure_diagnostics

if [ "$mode" = mock ]; then
  mock_pid="$(openclaw_e2e_start_mock_openai "$mock_port" /tmp/mcp-code-mode-mock-openai.log)"
  openclaw_e2e_wait_mock_openai "$mock_port"
fi
tsx scripts/e2e/mcp-code-mode-gateway-seed.ts >"$log_prefix-seed.log"

# The OpenAI default preset uses Codex. Install its matching candidate with
# fixture consent before starting the packaged Gateway, just as onboarding does.
openclaw_prepublish_plugin_registry_start_mounted \
  "$log_prefix-plugin-registry" plugin_registry_pid '["@openclaw/codex"]'
codex_install_args=(codex)
if [ -n "${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR:-}" ]; then
  codex_install_args=("npm:@openclaw/codex@${OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION:?missing candidate version}" --pin)
fi
openclaw_e2e_fixture_plugin_command openclaw_e2e_run_command node "$entry" -- \
  plugins install "${codex_install_args[@]}" >"$log_prefix-plugin-install.log" 2>&1

gateway_pid="$(openclaw_e2e_start_gateway "$entry" "$port" "$log_prefix-gateway.log")"
openclaw_e2e_wait_gateway_ready "$gateway_pid" "$log_prefix-gateway.log" 480 "$port"
tsx scripts/e2e/mcp-code-mode-gateway-client.ts
