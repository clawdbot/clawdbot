#!/usr/bin/env bash
# Installs a packed plugin with a real npm dependency, exposes its tool to a
# live OpenAI agent turn, and verifies the model received the dependency-made string.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-live-plugin-tool-e2e" OPENCLAW_LIVE_PLUGIN_TOOL_E2E_IMAGE)"
DOCKER_TARGET="${OPENCLAW_LIVE_PLUGIN_TOOL_DOCKER_TARGET:-bare}"
HOST_BUILD="${OPENCLAW_LIVE_PLUGIN_TOOL_HOST_BUILD:-1}"
PACKAGE_TGZ="${OPENCLAW_CURRENT_PACKAGE_TGZ:-}"
AGENT_TURN_TIMEOUT_SECONDS="${OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS:-300}"
PROFILE_FILE="${OPENCLAW_LIVE_PLUGIN_TOOL_PROFILE_FILE:-${OPENCLAW_TESTBOX_PROFILE_FILE:-$HOME/.openclaw-testbox-live.profile}}"
if [ ! -f "$PROFILE_FILE" ] && [ -f "$HOME/.profile" ]; then
  PROFILE_FILE="$HOME/.profile"
fi

docker_e2e_build_or_reuse "$IMAGE_NAME" live-plugin-tool "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "$DOCKER_TARGET"

prepare_package_tgz() {
  if [ -n "$PACKAGE_TGZ" ]; then
    PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz live-plugin-tool "$PACKAGE_TGZ")"
    return 0
  fi
  if [ "$HOST_BUILD" = "0" ] && [ -z "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}" ]; then
    echo "OPENCLAW_LIVE_PLUGIN_TOOL_HOST_BUILD=0 requires OPENCLAW_CURRENT_PACKAGE_TGZ" >&2
    exit 1
  fi
  PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz live-plugin-tool)"
}

prepare_package_tgz

PROFILE_MOUNT=()
PROFILE_STATUS="none"
if [ -f "$PROFILE_FILE" ] && [ -r "$PROFILE_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$PROFILE_FILE"
  set +a
  PROFILE_MOUNT=(-v "$PROFILE_FILE":/home/appuser/.profile:ro)
  PROFILE_STATUS="$PROFILE_FILE"
fi

docker_e2e_package_mount_args "$PACKAGE_TGZ"
run_log="$(docker_e2e_run_log live-plugin-tool)"
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 live-plugin-tool empty)"

echo "Running live plugin tool Docker E2E..."
echo "Profile file: $PROFILE_STATUS"
if ! docker_e2e_run_with_harness \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENAI_API_KEY \
  -e OPENAI_BASE_URL \
  -e OPENCLAW_LIVE_PLUGIN_TOOL_MODEL="${OPENCLAW_LIVE_PLUGIN_TOOL_MODEL:-openai/gpt-5.5}" \
  -e "OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS=$AGENT_TURN_TIMEOUT_SECONDS" \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  "${PROFILE_MOUNT[@]}" \
  -i "$IMAGE_NAME" bash -s >"$run_log" 2>&1 <<'EOF'; then
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export npm_config_prefix="$NPM_CONFIG_PREFIX"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-$XDG_CACHE_HOME/npm}"
export npm_config_cache="$NPM_CONFIG_CACHE"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENCLAW_AGENT_HARNESS_FALLBACK=none

for profile_path in "$HOME/.profile" /home/appuser/.profile; do
  if [ -f "$profile_path" ] && [ -r "$profile_path" ]; then
    set +e +u
    source "$profile_path"
    set -euo pipefail
    break
  fi
done
if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "ERROR: OPENAI_API_KEY was not available after sourcing ~/.profile." >&2
  exit 1
fi
export OPENAI_API_KEY
if [ -n "${OPENAI_BASE_URL:-}" ]; then
  export OPENAI_BASE_URL
fi

MODEL_REF="${OPENCLAW_LIVE_PLUGIN_TOOL_MODEL:?missing OPENCLAW_LIVE_PLUGIN_TOOL_MODEL}"
PLUGIN_ID="e2e-slug-tool"
PLUGIN_NAME="@openclaw/e2e-slug-tool"
PLUGIN_VERSION="0.0.0-e2e.1"
TOOL_NAME="e2e_slug_probe"
SEED="OpenClaw E2E Plugin Tool $(date +%s)-$RANDOM"
EXPECTED_SLUG="$(printf '%s' "$SEED" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//')"
export MODEL_REF PLUGIN_ID PLUGIN_NAME PLUGIN_VERSION TOOL_NAME SEED EXPECTED_SLUG

dump_debug_logs() {
  local status="$1"
  echo "Live plugin tool scenario failed with exit code $status" >&2
  openclaw_e2e_dump_logs \
    /tmp/openclaw-install.log \
    /tmp/openclaw-plugin-install.log \
    /tmp/openclaw-plugin-enable.log \
    /tmp/openclaw-plugins-list.json \
    /tmp/openclaw-plugin-inspect.json \
    /tmp/openclaw-agent.json \
    /tmp/openclaw-agent.err
}
trap 'status=$?; dump_debug_logs "$status"; exit "$status"' ERR

mkdir -p "$NPM_CONFIG_PREFIX" "$XDG_CACHE_HOME" "$NPM_CONFIG_CACHE"
chmod 700 "$XDG_CACHE_HOME" "$NPM_CONFIG_CACHE" || true

openclaw_e2e_install_package /tmp/openclaw-install.log
command -v openclaw >/dev/null

fixture_dir="$(mktemp -d /tmp/openclaw-live-plugin-tool.XXXXXX)"
plugin_dir="$fixture_dir/package"
mkdir -p "$plugin_dir"
node scripts/e2e/lib/live-plugin-tool/assertions.mjs write-fixture "$plugin_dir"
plugin_pack="$(cd "$plugin_dir" && npm pack --pack-destination "$fixture_dir" --silent)"
plugin_tgz="$fixture_dir/$plugin_pack"

echo "Installing fixture plugin from npm-pack: $plugin_tgz"
openclaw plugins install "npm-pack:$plugin_tgz" --force >/tmp/openclaw-plugin-install.log 2>&1
node scripts/e2e/lib/live-plugin-tool/assertions.mjs configure
openclaw plugins enable "$PLUGIN_ID" >/tmp/openclaw-plugin-enable.log 2>&1
openclaw plugins list --json >/tmp/openclaw-plugins-list.json
openclaw plugins inspect "$PLUGIN_ID" --runtime --json >/tmp/openclaw-plugin-inspect.json
node scripts/e2e/lib/live-plugin-tool/assertions.mjs assert-installed

echo "Running live OpenAI agent turn that must call $TOOL_NAME..."
openclaw agent --local \
  --agent main \
  --session-id live-plugin-tool \
  --model "$MODEL_REF" \
  --message "Call the tool named ${TOOL_NAME}. Reply with only the exact text returned by that tool. Do not compute, transform, or explain it." \
  --thinking off \
  --timeout "${OPENCLAW_LIVE_PLUGIN_TOOL_TIMEOUT_SECONDS:-300}" \
  --json >/tmp/openclaw-agent.json 2>/tmp/openclaw-agent.err

node scripts/e2e/lib/live-plugin-tool/assertions.mjs assert-agent-turn

echo "Live plugin tool Docker E2E passed"
EOF
  docker_e2e_print_log "$run_log"
  rm -f "$run_log"
  exit 1
fi

rm -f "$run_log"
echo "Live plugin tool Docker E2E passed"
