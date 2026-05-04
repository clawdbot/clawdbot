#!/usr/bin/env bash
# Installs a prepared OpenClaw npm tarball in Docker, runs non-interactive
# onboarding for a channel, and verifies one mocked model turn through Gateway.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"
source "$ROOT_DIR/scripts/lib/docker-e2e-package.sh"

IMAGE_NAME="$(docker_e2e_resolve_image "openclaw-npm-onboard-channel-agent-e2e" OPENCLAW_NPM_ONBOARD_E2E_IMAGE)"
DOCKER_TARGET="${OPENCLAW_NPM_ONBOARD_DOCKER_TARGET:-bare}"
HOST_BUILD="${OPENCLAW_NPM_ONBOARD_HOST_BUILD:-1}"
PACKAGE_TGZ="${OPENCLAW_CURRENT_PACKAGE_TGZ:-}"
CHANNEL="${OPENCLAW_NPM_ONBOARD_CHANNEL:-telegram}"

case "$CHANNEL" in
telegram | discord) ;;
*)
  echo "OPENCLAW_NPM_ONBOARD_CHANNEL must be telegram or discord, got: $CHANNEL" >&2
  exit 1
  ;;
esac

docker_e2e_build_or_reuse "$IMAGE_NAME" npm-onboard-channel-agent "$ROOT_DIR/scripts/e2e/Dockerfile" "$ROOT_DIR" "$DOCKER_TARGET"

prepare_package_tgz() {
  if [ -n "$PACKAGE_TGZ" ]; then
    PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz npm-onboard-channel-agent "$PACKAGE_TGZ")"
    return 0
  fi
  if [ "$HOST_BUILD" = "0" ] && [ -z "${OPENCLAW_CURRENT_PACKAGE_TGZ:-}" ]; then
    echo "OPENCLAW_NPM_ONBOARD_HOST_BUILD=0 requires OPENCLAW_CURRENT_PACKAGE_TGZ" >&2
    exit 1
  fi
  PACKAGE_TGZ="$(docker_e2e_prepare_package_tgz npm-onboard-channel-agent)"
}

prepare_package_tgz

docker_e2e_package_mount_args "$PACKAGE_TGZ"
run_log="$(docker_e2e_run_log npm-onboard-channel-agent)"
OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 npm-onboard-channel-agent empty)"

echo "Running npm tarball onboard/channel/agent Docker E2E ($CHANNEL)..."
if ! docker_e2e_run_with_harness \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENCLAW_NPM_ONBOARD_CHANNEL="$CHANNEL" \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
  -i "$IMAGE_NAME" bash -s >"$run_log" 2>&1 <<'EOF'; then
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENAI_API_KEY="sk-openclaw-npm-onboard-e2e"
export OPENCLAW_GATEWAY_TOKEN="npm-onboard-channel-agent-token"

CHANNEL="${OPENCLAW_NPM_ONBOARD_CHANNEL:?missing OPENCLAW_NPM_ONBOARD_CHANNEL}"
PORT="18789"
MOCK_PORT="44080"
SUCCESS_MARKER="OPENCLAW_AGENT_E2E_OK_ASSISTANT"
MOCK_REQUEST_LOG="/tmp/openclaw-mock-openai-requests.jsonl"
export SUCCESS_MARKER MOCK_REQUEST_LOG
mock_pid=""

case "$CHANNEL" in
  telegram)
    CHANNEL_TOKEN="123456:openclaw-npm-onboard-token"
    DEP_SENTINEL="grammy"
    ;;
  discord)
    CHANNEL_TOKEN="openclaw-npm-onboard-discord-token"
    DEP_SENTINEL="discord-api-types"
    ;;
  *)
    echo "unsupported channel: $CHANNEL" >&2
    exit 1
    ;;
esac

cleanup() {
  openclaw_e2e_stop_process "${mock_pid:-}"
}
trap cleanup EXIT

dump_debug_logs() {
  local status="$1"
  echo "npm onboard/channel/agent scenario failed with exit code $status" >&2
  openclaw_e2e_dump_logs \
    /tmp/openclaw-install.log \
    /tmp/openclaw-onboard.json \
    /tmp/openclaw-channel-add.log \
    /tmp/openclaw-channels-status.json \
    /tmp/openclaw-channels-status.err \
    /tmp/openclaw-status.txt \
    /tmp/openclaw-status.err \
    /tmp/openclaw-doctor.log \
    /tmp/openclaw-agent.combined \
    /tmp/openclaw-agent.err \
    /tmp/openclaw-agent.json \
    /tmp/openclaw-mock-openai.log \
    "$MOCK_REQUEST_LOG"
}
trap 'status=$?; dump_debug_logs "$status"; exit "$status"' ERR

openclaw_e2e_install_package /tmp/openclaw-install.log

command -v openclaw >/dev/null
package_root="$(openclaw_e2e_package_root)"
if [ -d "$package_root/dist/extensions/$CHANNEL" ]; then
  CHANNEL_PACKAGE_MODE="bundled"
else
  CHANNEL_PACKAGE_MODE="external"
  echo "$CHANNEL is not packaged with core OpenClaw; expecting channel selection to install it on demand."
fi

mock_pid="$(openclaw_e2e_start_mock_openai "$MOCK_PORT" /tmp/openclaw-mock-openai.log)"
openclaw_e2e_wait_mock_openai "$MOCK_PORT"

echo "Running non-interactive onboarding..."
openclaw onboard --non-interactive --accept-risk \
  --mode local \
  --auth-choice openai-api-key \
  --secret-input-mode ref \
  --gateway-port "$PORT" \
  --gateway-bind loopback \
  --skip-daemon \
  --skip-ui \
  --skip-skills \
  --skip-health \
  --json >/tmp/openclaw-onboard.json

node scripts/e2e/lib/npm-onboard-channel-agent/assertions.mjs assert-onboard-state "$HOME"
node scripts/e2e/lib/npm-onboard-channel-agent/assertions.mjs configure-mock-model "$MOCK_PORT"

openclaw_e2e_assert_dep_absent "$DEP_SENTINEL" "$HOME/.openclaw"

echo "Configuring $CHANNEL..."
openclaw channels add --channel "$CHANNEL" --token "$CHANNEL_TOKEN" >/tmp/openclaw-channel-add.log 2>&1
node scripts/e2e/lib/npm-onboard-channel-agent/assertions.mjs assert-channel-config "$CHANNEL" "$CHANNEL_TOKEN"

echo "Checking status surfaces for $CHANNEL..."
openclaw channels status --json >/tmp/openclaw-channels-status.json 2>/tmp/openclaw-channels-status.err
openclaw status >/tmp/openclaw-status.txt 2>/tmp/openclaw-status.err
node scripts/e2e/lib/npm-onboard-channel-agent/assertions.mjs assert-status-surfaces "$CHANNEL" /tmp/openclaw-channels-status.json /tmp/openclaw-status.txt

echo "Running doctor after channel activation..."
openclaw doctor --repair --non-interactive >/tmp/openclaw-doctor.log 2>&1
if [ "$CHANNEL_PACKAGE_MODE" = "external" ]; then
  openclaw_e2e_assert_dep_present "$DEP_SENTINEL" "$HOME/.openclaw"
else
  openclaw_e2e_assert_dep_absent "$DEP_SENTINEL" "$HOME/.openclaw"
fi

echo "Running local agent turn against mocked OpenAI..."
openclaw agent --local \
  --agent main \
  --session-id npm-onboard-channel-agent \
  --message "Return the success marker from the test server." \
  --thinking off \
  --json >/tmp/openclaw-agent.combined 2>&1

node scripts/e2e/lib/npm-onboard-channel-agent/assertions.mjs assert-agent-turn "$SUCCESS_MARKER" "$MOCK_REQUEST_LOG"

echo "npm tarball onboard/channel/agent Docker E2E passed for $CHANNEL"
EOF
  docker_e2e_print_log "$run_log"
  rm -f "$run_log"
  exit 1
fi

rm -f "$run_log"
echo "npm tarball onboard/channel/agent Docker E2E passed ($CHANNEL)"
