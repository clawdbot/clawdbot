#!/usr/bin/env bash
#
# Runs one bundled plugin channel runtime-dependency scenario.
# Sourced by scripts/e2e/bundled-channel-runtime-deps-docker.sh.

run_channel_scenario() {
  local channel="$1"
  local dep_sentinel="$2"

  echo "Running bundled $channel runtime deps Docker E2E..."
  run_bundled_channel_container_with_state \
    "bundled-channel-deps-$channel" \
    "$DOCKER_RUN_TIMEOUT" \
    "bundled-channel-deps-$channel" \
    -e OPENCLAW_CHANNEL_UNDER_TEST="$channel" \
    -e OPENCLAW_DEP_SENTINEL="$dep_sentinel" \
    "${DOCKER_E2E_PACKAGE_ARGS[@]}" \
    -i "$IMAGE_NAME" bash -s <<'EOF'
set -euo pipefail

source scripts/lib/openclaw-e2e-instance.sh
source scripts/e2e/lib/bundled-channel/common.sh
openclaw_e2e_eval_test_state_from_b64 "${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing OPENCLAW_TEST_STATE_SCRIPT_B64}"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$NPM_CONFIG_PREFIX/bin:$PATH"
export OPENAI_API_KEY="sk-openclaw-bundled-channel-deps-e2e"
export OPENCLAW_NO_ONBOARD=1

TOKEN="bundled-channel-deps-token"
PORT="18789"
CHANNEL="${OPENCLAW_CHANNEL_UNDER_TEST:?missing OPENCLAW_CHANNEL_UNDER_TEST}"
DEP_SENTINEL="${OPENCLAW_DEP_SENTINEL:?missing OPENCLAW_DEP_SENTINEL}"
gateway_pid=""

terminate_gateways() {
  openclaw_e2e_terminate_gateways "${gateway_pid:-}"
}

cleanup() {
  terminate_gateways
}
trap cleanup EXIT

bundled_channel_install_package /tmp/openclaw-install.log

command -v openclaw >/dev/null
package_root="$(openclaw_e2e_package_root)"
openclaw_e2e_assert_package_extensions "$package_root" telegram discord slack feishu memory-lancedb

if [ -d "$package_root/dist/extensions/$CHANNEL/node_modules" ]; then
  echo "$CHANNEL runtime deps should not be preinstalled in package" >&2
  find "$package_root/dist/extensions/$CHANNEL/node_modules" -maxdepth 2 -type f | head -20 >&2 || true
  exit 1
fi

start_gateway() {
  local log_file="$1"
  local skip_sidecars="${2:-0}"
  : >"$log_file"
  if [ "$skip_sidecars" = "1" ]; then
    OPENCLAW_SKIP_CHANNELS=1 OPENCLAW_SKIP_PROVIDERS=1 \
      openclaw gateway --port "$PORT" --bind loopback --allow-unconfigured >"$log_file" 2>&1 &
  else
    openclaw gateway --port "$PORT" --bind loopback --allow-unconfigured >"$log_file" 2>&1 &
  fi
  gateway_pid="$!"

  # Cold bundled dependency staging can exceed 60s under 10-way Docker aggregate load.
  for _ in $(seq 1 1200); do
    if grep -Eq "listening on ws://|\\[gateway\\] http server listening|\\[gateway\\] ready( \\(|$)" "$log_file"; then
      return 0
    fi
    if ! kill -0 "$gateway_pid" 2>/dev/null; then
      echo "gateway exited unexpectedly" >&2
      cat "$log_file" >&2
      exit 1
    fi
    sleep 0.25
  done

  echo "timed out waiting for gateway" >&2
  cat "$log_file" >&2
  exit 1
}

stop_gateway() {
  terminate_gateways
  gateway_pid=""
}

wait_for_gateway_health() {
  local log_file="${1:-}"
  if [ -n "${gateway_pid:-}" ] && kill -0 "$gateway_pid" 2>/dev/null; then
    return 0
  fi
  echo "gateway process exited after ready marker" >&2
  if [ -n "$log_file" ]; then
    cat "$log_file" >&2
  fi
  return 1
}

parse_channel_status_json() {
  local out="$1"
  local channel="$2"
  node scripts/e2e/lib/bundled-channel/assert-channel-status.mjs "$out" "$channel"
}

assert_channel_status() {
  local channel="$1"
  if [ "$channel" = "memory-lancedb" ]; then
    echo "memory-lancedb plugin activation verified by dependency sentinel"
    return 0
  fi
  local out="/tmp/openclaw-channel-status-$channel.json"
  local err="/tmp/openclaw-channel-status-$channel.err"
  local parse_err="/tmp/openclaw-channel-status-$channel.parse.err"
  local parse_out="/tmp/openclaw-channel-status-$channel.parse.out"
  for _ in $(seq 1 30); do
    if openclaw gateway call channels.status \
      --url "ws://127.0.0.1:$PORT" \
      --token "$TOKEN" \
      --timeout 10000 \
      --json \
      --params '{"probe":false}' >"$out" 2>"$err"; then
      if parse_channel_status_json "$out" "$channel" >"$parse_out" 2>"$parse_err"; then
        cat "$parse_out"
        return 0
      fi
    fi
    if grep -Eq "\\[gateway\\] ready \\(.*\\b$channel\\b" /tmp/openclaw-"$channel"-*.log 2>/dev/null; then
      echo "$channel channel plugin visible in gateway ready log"
      return 0
    fi
    sleep 2
  done
  if [ ! -s "$out" ]; then
    cat "$err" >&2 || true
  else
    cat "$parse_err" >&2 || true
    cat "$out" >&2 || true
  fi
  cat /tmp/openclaw-"$channel"-*.log >&2 2>/dev/null || true
  return 1
}

assert_installed_once() {
  local log_file="$1"
  local channel="$2"
  local dep_path="$3"
  local count
  count="$(grep -Ec "\\[plugins\\] $channel installed bundled runtime deps( in [0-9]+ms)?:" "$log_file" || true)"
  if [ "$count" -eq 1 ]; then
    return 0
  fi
  if [ "$count" -eq 0 ] && [ -n "$(bundled_channel_find_external_dep_package "$dep_path")" ]; then
    return 0
  fi
  echo "expected one runtime deps install log or staged dependency sentinel for $channel, got $count log lines" >&2
  cat "$log_file" >&2
  find "$(bundled_channel_stage_root)" -maxdepth 12 -type f | sort | head -120 >&2 || true
  exit 1
}

assert_not_installed() {
  local log_file="$1"
  local channel="$2"
  if grep -Eq "\\[plugins\\] $channel installed bundled runtime deps( in [0-9]+ms)?:" "$log_file"; then
    echo "expected no runtime deps reinstall for $channel" >&2
    cat "$log_file" >&2
    exit 1
  fi
}

assert_dep_sentinel() {
  local channel="$1"
  local dep_path="$2"
  bundled_channel_assert_dep_available "$channel" "$dep_path" "$package_root"
}

assert_no_dep_sentinel() {
  local channel="$1"
  local dep_path="$2"
  bundled_channel_assert_no_dep_available "$channel" "$dep_path" "$package_root"
}

assert_no_install_stage() {
  local channel="$1"
  local stage="$package_root/dist/extensions/$channel/.openclaw-install-stage"
  if [ -e "$stage" ]; then
    echo "install stage should be cleaned after activation for $channel" >&2
    find "$stage" -maxdepth 4 -type f | sort | head -80 >&2 || true
    exit 1
  fi
}

echo "Starting baseline gateway with OpenAI configured..."
bundled_channel_write_config baseline
start_gateway "/tmp/openclaw-$CHANNEL-baseline.log" 1
wait_for_gateway_health "/tmp/openclaw-$CHANNEL-baseline.log"
stop_gateway
assert_no_dep_sentinel "$CHANNEL" "$DEP_SENTINEL"

echo "Enabling $CHANNEL by config edit, then restarting gateway..."
bundled_channel_write_config "$CHANNEL"
start_gateway "/tmp/openclaw-$CHANNEL-first.log"
wait_for_gateway_health "/tmp/openclaw-$CHANNEL-first.log"
assert_installed_once "/tmp/openclaw-$CHANNEL-first.log" "$CHANNEL" "$DEP_SENTINEL"
assert_dep_sentinel "$CHANNEL" "$DEP_SENTINEL"
assert_no_install_stage "$CHANNEL"
assert_channel_status "$CHANNEL"
stop_gateway

echo "Restarting gateway again; $CHANNEL deps must stay installed..."
start_gateway "/tmp/openclaw-$CHANNEL-second.log"
wait_for_gateway_health "/tmp/openclaw-$CHANNEL-second.log"
assert_not_installed "/tmp/openclaw-$CHANNEL-second.log" "$CHANNEL"
assert_no_install_stage "$CHANNEL"
assert_channel_status "$CHANNEL"
stop_gateway

echo "bundled $CHANNEL runtime deps Docker E2E passed"
EOF
}
