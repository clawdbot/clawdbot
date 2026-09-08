#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/lib/docker-e2e-image.sh"

BASE_IMAGE="$(docker_e2e_resolve_image "openclaw-browser-plugin-profiles-base-e2e" OPENCLAW_BROWSER_PLUGIN_PROFILES_BASE_IMAGE)"
IMAGE_NAME="${OPENCLAW_BROWSER_PLUGIN_PROFILES_IMAGE:-openclaw-browser-plugin-profiles-e2e:${OPENCLAW_DOCKER_ALL_LANE_NAME:-local}}"
CONTAINER_NAME="openclaw-browser-plugin-profiles-e2e-$$"
BUILD_DIR=""
PORT="18789"
TOKEN="browser-plugin-profiles-token"
PROFILE="qa-browser"
DOCKER_COMMAND_TIMEOUT="${OPENCLAW_BROWSER_PLUGIN_PROFILES_DOCKER_TIMEOUT:-1200s}"
PLAYWRIGHT_CORE_VERSION="$(
  node -p 'require(process.argv[1]).dependencies["playwright-core"]' \
    "$ROOT_DIR/extensions/browser/package.json"
)"

cleanup() {
  if [ -n "$CONTAINER_NAME" ] && docker_e2e_docker_cmd inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
    docker_e2e_docker_cmd rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  fi
  if [ -n "$BUILD_DIR" ]; then
    rm -rf "$BUILD_DIR"
  fi
}
trap cleanup EXIT INT TERM

if [ "${OPENCLAW_BROWSER_PLUGIN_PROFILES_SKIP_BUILD:-0}" = "1" ]; then
  docker_e2e_docker_cmd image inspect "$IMAGE_NAME" >/dev/null
else
  docker_e2e_build_or_reuse "$BASE_IMAGE" browser-plugin-profiles-base
  BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-browser-plugin-profiles-build.XXXXXX")"
  cat >"$BUILD_DIR/Dockerfile" <<EOF
FROM $BASE_IMAGE
USER root
ARG EXPECTED_PLAYWRIGHT_CORE
ENV PLAYWRIGHT_BROWSERS_PATH=/home/appuser/.cache/ms-playwright
RUN test "\$(node -p 'require("/app/node_modules/playwright-core/package.json").version')" = "\$EXPECTED_PLAYWRIGHT_CORE" \
 && mkdir -p "\$PLAYWRIGHT_BROWSERS_PATH" \
 && DEBIAN_FRONTEND=noninteractive node /app/node_modules/playwright-core/cli.js install --with-deps chromium \
 && chown -R appuser:appuser "\$PLAYWRIGHT_BROWSERS_PATH"
USER appuser
EOF
  docker_build_run browser-plugin-profiles-build \
    --build-arg "EXPECTED_PLAYWRIGHT_CORE=$PLAYWRIGHT_CORE_VERSION" \
    -t "$IMAGE_NAME" -f "$BUILD_DIR/Dockerfile" "$BUILD_DIR"
fi

OPENCLAW_TEST_STATE_SCRIPT_B64="$(docker_e2e_test_state_shell_b64 browser-plugin-profiles empty)"
docker_e2e_harness_mount_args
docker_e2e_docker_cmd run -d \
  "${DOCKER_E2E_HARNESS_ARGS[@]}" \
  --name "$CONTAINER_NAME" \
  -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
  -e OPENCLAW_DISABLE_BONJOUR=1 \
  -e OPENCLAW_GATEWAY_TOKEN="$TOKEN" \
  -e OPENCLAW_SKIP_CANVAS_HOST=1 \
  -e OPENCLAW_SKIP_CHANNELS=1 \
  -e OPENCLAW_SKIP_CRON=1 \
  -e OPENCLAW_SKIP_GMAIL_WATCHER=1 \
  -e OPENCLAW_SKIP_PROVIDERS=1 \
  -e "OPENCLAW_TEST_STATE_SCRIPT_B64=$OPENCLAW_TEST_STATE_SCRIPT_B64" \
  "$IMAGE_NAME" \
  bash -lc "set -euo pipefail
source scripts/lib/openclaw-e2e-instance.sh
openclaw_e2e_eval_test_state_from_b64 \"\${OPENCLAW_TEST_STATE_SCRIPT_B64:?missing test state}\"
openclaw_e2e_write_state_env
source /tmp/openclaw-test-state-env
test -z \"\${OPENCLAW_EAGER_BROWSER_CONTROL_SERVER:-}\"
entry=\"\$(openclaw_e2e_resolve_entrypoint)\"
node \"\$entry\" config set browser.enabled true >/dev/null
node \"\$entry\" config set browser.noSandbox true >/dev/null
openclaw_e2e_exec_gateway \"\$entry\" $PORT loopback /tmp/browser-plugin-profiles-gateway.log" >/dev/null

if ! docker_e2e_wait_container_bash "$CONTAINER_NAME" 240 0.5 \
  "source scripts/lib/openclaw-e2e-instance.sh; openclaw_e2e_probe_tcp 127.0.0.1 $PORT"; then
  echo "Packaged browser Gateway failed to become ready" >&2
  docker_e2e_tail_container_file_if_running \
    "$CONTAINER_NAME" "/tmp/browser-plugin-profiles-gateway.log" 160
  exit 1
fi

if docker_e2e_docker_cmd exec "$CONTAINER_NAME" \
  grep -q "Browser control service ready" /tmp/browser-plugin-profiles-gateway.log; then
  echo "Browser control service started eagerly" >&2
  exit 1
fi

if [ -z "$BUILD_DIR" ]; then
  BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-browser-plugin-profiles-run.XXXXXX")"
fi
LIFECYCLE_SCRIPT="$BUILD_DIR/profile-lifecycle.sh"
cat >"$LIFECYCLE_SCRIPT" <<'CONTAINER'
set -euo pipefail
PORT="$1"
TOKEN="$2"
PROFILE="$3"
source /tmp/openclaw-test-state-env
source scripts/lib/openclaw-e2e-instance.sh
entry="$(openclaw_e2e_resolve_entrypoint)"
base=(--url "ws://127.0.0.1:$PORT" --token "$TOKEN" --json)
browser() { node "$entry" browser "${base[@]}" "$@"; }
profile() { node "$entry" browser "${base[@]}" --browser-profile "$PROFILE" "$@"; }

browser profiles >/tmp/profiles-initial.json
node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1])); if (!Array.isArray(d.profiles) || d.profiles.some((p) => p.name === process.argv[2])) throw new Error("profile unexpectedly present")' \
  /tmp/profiles-initial.json "$PROFILE"

browser create-profile --name "$PROFILE" --color "#1A73E8" >/tmp/profile-created.json
browser profiles >/tmp/profiles-created.json
node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1])); if (!d.profiles.some((p) => p.name === process.argv[2])) throw new Error("created profile missing")' \
  /tmp/profiles-created.json "$PROFILE"

profile status >/tmp/profile-stopped.json
node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1])); if (d.profile !== process.argv[2] || d.running) throw new Error("selected profile was not stopped")' \
  /tmp/profile-stopped.json "$PROFILE"

profile start --headless >/tmp/profile-started.json
profile status >/tmp/profile-running.json
BROWSER_PID="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1])).pid' /tmp/profile-running.json)"
CDP_PORT="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1])).cdpPort' /tmp/profile-running.json)"
node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1])); if (!d.running || !d.headless || !d.cdpReady || !Number.isInteger(d.pid) || !Number.isInteger(d.cdpPort)) throw new Error("headless browser status incomplete")' \
  /tmp/profile-running.json
kill -0 "$BROWSER_PID"
node --input-type=module -e 'const response=await fetch(`http://127.0.0.1:${process.argv[1]}/json/version`); const body=await response.json(); if (!response.ok || typeof body.webSocketDebuggerUrl !== "string") throw new Error("CDP /json/version unavailable")' \
  "$CDP_PORT"

assert_device_state() {
  node -e '
    const fs = require("node:fs");
    const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const state = payload.result;
    const [width, height, dpr, screenWidth, screenHeight, touchPoints] = process.argv
      .slice(3, 9)
      .map(Number);
    const expected = {
      width,
      height,
      dpr,
      screenWidth,
      screenHeight,
      touchPoints,
      orientation: process.argv[9],
    };
    const actual = {
      width: state?.width,
      height: state?.height,
      dpr: state?.dpr,
      screenWidth: state?.screenWidth,
      screenHeight: state?.screenHeight,
      touchPoints: state?.touchPoints,
      orientation: state?.orientation,
    };
    if (!state?.userAgent?.includes(process.argv[2]) || JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`device state mismatch: ${JSON.stringify({ actual, expected })}`);
    }
  ' "$@"
}

profile evaluate --fn '() => { const meta = document.createElement("meta"); meta.name = "viewport"; meta.content = "width=device-width, initial-scale=1"; document.head.append(meta); return meta.content; }' \
  >/tmp/profile-viewport-meta.json

profile set timezone America/New_York >/tmp/profile-timezone.json
profile set locale en-GB >/tmp/profile-locale.json
profile evaluate --fn '() => ({ locale: Intl.DateTimeFormat().resolvedOptions().locale, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })' \
  >/tmp/profile-locale-timezone-state.json
node -e '
  const fs = require("node:fs");
  const state = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).result;
  if (state?.locale !== "en-GB" || state?.timeZone !== "America/New_York") {
    throw new Error(`locale/timezone state mismatch: ${JSON.stringify(state)}`);
  }
' /tmp/profile-locale-timezone-state.json

profile set device "iPhone 14" >/tmp/profile-device-phone.json
profile evaluate --fn '() => ({ userAgent: navigator.userAgent, width: innerWidth, height: innerHeight, dpr: devicePixelRatio, screenWidth: screen.width, screenHeight: screen.height, touchPoints: navigator.maxTouchPoints, orientation: screen.orientation.type })' \
  >/tmp/profile-device-phone-state.json
assert_device_state /tmp/profile-device-phone-state.json iPhone 390 664 3 390 844 1 portrait-primary

profile set device "Desktop Chrome" >/tmp/profile-device-desktop.json
profile evaluate --fn '() => ({ userAgent: navigator.userAgent, width: innerWidth, height: innerHeight, dpr: devicePixelRatio, screenWidth: screen.width, screenHeight: screen.height, touchPoints: navigator.maxTouchPoints, orientation: screen.orientation.type })' \
  >/tmp/profile-device-desktop-state.json
assert_device_state /tmp/profile-device-desktop-state.json Windows 1280 720 1 1920 1080 0 landscape-primary

profile stop >/tmp/profile-stopped-final.json
for _ in $(seq 1 80); do
  if ! kill -0 "$BROWSER_PID" 2>/dev/null &&
    ! openclaw_e2e_probe_tcp 127.0.0.1 "$CDP_PORT" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
! kill -0 "$BROWSER_PID" 2>/dev/null
! openclaw_e2e_probe_tcp 127.0.0.1 "$CDP_PORT" 2>/dev/null
profile status >/tmp/profile-closed.json
node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1])); if (d.running || d.cdpReady) throw new Error("browser remained open after stop")' \
  /tmp/profile-closed.json

browser delete-profile --name "$PROFILE" >/tmp/profile-deleted.json
browser profiles >/tmp/profiles-final.json
node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1])); if (d.profiles.some((p) => p.name === process.argv[2])) throw new Error("deleted profile remained listed")' \
  /tmp/profiles-final.json "$PROFILE"
printf 'profile=%s browserPid=%s cdpPort=%s playwrightCore=%s\n' \
  "$PROFILE" "$BROWSER_PID" "$CDP_PORT" "$(node -p 'require("/app/node_modules/playwright-core/package.json").version')"
CONTAINER
docker_e2e_docker_cmd cp \
  "$LIFECYCLE_SCRIPT" "$CONTAINER_NAME:/tmp/browser-plugin-profiles-lifecycle.sh"

if ! docker_e2e_docker_cmd exec "$CONTAINER_NAME" \
  bash /tmp/browser-plugin-profiles-lifecycle.sh "$PORT" "$TOKEN" "$PROFILE"
then
  echo "Packaged browser plugin profile lifecycle failed" >&2
  docker_e2e_tail_container_file_if_running \
    "$CONTAINER_NAME" "/tmp/browser-plugin-profiles-gateway.log" 200
  exit 1
fi

READY_COUNT="$(
  docker_e2e_docker_cmd exec "$CONTAINER_NAME" \
    grep -c "Browser control service ready" /tmp/browser-plugin-profiles-gateway.log || true
)"
if [ "$READY_COUNT" != "1" ]; then
  echo "Expected exactly one lazy browser control service start, got $READY_COUNT" >&2
  exit 1
fi

docker_e2e_docker_cmd stop --time 20 "$CONTAINER_NAME" >/dev/null
if [ "$(docker_e2e_docker_cmd inspect --format '{{.State.Running}}' "$CONTAINER_NAME")" != "false" ]; then
  echo "Gateway container remained running after graceful stop" >&2
  exit 1
fi
docker_e2e_docker_cmd rm "$CONTAINER_NAME" >/dev/null
CONTAINER_NAME=""

echo "BROWSER_PLUGIN_PROFILES_PACKAGED_OK"
