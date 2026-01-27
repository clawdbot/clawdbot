#!/usr/bin/env bash
# Reset Moltbot like Trimmy: kill running instances, rebuild, repackage, relaunch, verify.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="${CLAWDBOT_APP_BUNDLE:-}"
APP_PROCESS_PATTERN="Moltbot.app/Contents/MacOS/Moltbot"
DEBUG_PROCESS_PATTERN="${ROOT_DIR}/apps/macos/.build/debug/Moltbot"
LOCAL_PROCESS_PATTERN="${ROOT_DIR}/apps/macos/.build-local/debug/Moltbot"
RELEASE_PROCESS_PATTERN="${ROOT_DIR}/apps/macos/.build/release/Moltbot"
LAUNCH_AGENT="${HOME}/Library/LaunchAgents/com.clawdbot.mac.plist"
LOCK_KEY="$(printf '%s' "${ROOT_DIR}" | shasum -a 256 | cut -c1-8)"
LOCK_DIR="${TMPDIR:-/tmp}/moltbot-restart-${LOCK_KEY}"
LOCK_PID_FILE="${LOCK_DIR}/pid"
WAIT_FOR_LOCK=0
LOG_PATH="${CLAWDBOT_RESTART_LOG:-/tmp/moltbot-restart.log}"
NO_SIGN=0
SIGN=0
AUTO_DETECT_SIGNING=1
GATEWAY_WAIT_SECONDS="${CLAWDBOT_GATEWAY_WAIT_SECONDS:-0}"
LAUNCHAGENT_DISABLE_MARKER="${HOME}/.clawdbot/disable-launchagent"
ATTACH_ONLY=1

log()  { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Ensure local node binaries (rolldown, tsc, pnpm) are discoverable for the steps below.
export PATH="${ROOT_DIR}/node_modules/.bin:${PATH}"

run_step() {
  local label="$1"; shift
  log "==> ${label}"
  if ! "$@"; then
    fail "${label} failed"
  fi
}

cleanup() {
  if [[ -d "${LOCK_DIR}" ]]; then
    rm -rf "${LOCK_DIR}"
  fi
}

acquire_lock() {
  while true; do
    if mkdir "${LOCK_DIR}" 2>/dev/null; then
      echo "$$" > "${LOCK_PID_FILE}"
      return 0
    fi

    local existing_pid=""
    if [[ -f "${LOCK_PID_FILE}" ]]; then
      existing_pid="$(cat "${LOCK_PID_FILE}" 2>/dev/null || true)"
    fi

    if [[ -n "${existing_pid}" ]] && kill -0 "${existing_pid}" 2>/dev/null; then
      if [[ "${WAIT_FOR_LOCK}" == "1" ]]; then
        log "==> Another restart is running (pid ${existing_pid}); waiting..."
        while kill -0 "${existing_pid}" 2>/dev/null; do
          sleep 1
        done
        continue
      fi
      log "==> Another restart is running (pid ${existing_pid}); re-run with --wait."
      exit 0
    fi

    rm -rf "${LOCK_DIR}"
  done
}

check_signing_keys() {
  security find-identity -p codesigning -v 2>/dev/null \
    | grep -Eq '(Developer ID Application|Apple Distribution|Apple Development)'
}

trap cleanup EXIT INT TERM

for arg in "$@"; do
  case "${arg}" in
    --wait|-w) WAIT_FOR_LOCK=1 ;;
    --no-sign) NO_SIGN=1; AUTO_DETECT_SIGNING=0 ;;
    --sign) SIGN=1; AUTO_DETECT_SIGNING=0 ;;
    --attach-only) ATTACH_ONLY=1 ;;
    --no-attach-only) ATTACH_ONLY=0 ;;
    --help|-h)
      log "Usage: $(basename "$0") [--wait] [--no-sign] [--sign] [--attach-only|--no-attach-only]"
      log "  --wait    Wait for other restart to complete instead of exiting"
      log "  --no-sign Force no code signing (fastest for development)"
      log "  --sign    Force code signing (will fail if no signing key available)"
      log "  --attach-only    Launch app with --attach-only (skip launchd install)"
      log "  --no-attach-only Launch app without attach-only override"
      log ""
      log "Env:"
      log "  CLAWDBOT_GATEWAY_WAIT_SECONDS=0  Wait time before gateway port check (unsigned only)"
      log ""
      log "Unsigned recovery:"
      log "  node dist/entry.js daemon install --force --runtime node"
      log "  node dist/entry.js daemon restart"
      log ""
      log "Reset unsigned overrides:"
      log "  rm ~/.clawdbot/disable-launchagent"
      log ""
      log "Default behavior: Auto-detect signing keys, fallback to --no-sign if none found"
      exit 0
      ;;
    *) ;;
  esac
done

if [[ "$NO_SIGN" -eq 1 && "$SIGN" -eq 1 ]]; then
  fail "Cannot use --sign and --no-sign together"
fi

mkdir -p "$(dirname "$LOG_PATH")"
rm -f "$LOG_PATH"
exec > >(tee "$LOG_PATH") 2>&1
log "==> Log: ${LOG_PATH}"
if [[ "$NO_SIGN" -eq 1 ]]; then
  log "==> Using --no-sign (unsigned flow enabled)"
fi
if [[ "$ATTACH_ONLY" -eq 1 ]]; then
  log "==> Using --attach-only (skip launchd install)"
fi

acquire_lock

kill_all_moltbot() {
  for _ in {1..10}; do
    pkill -f "${APP_PROCESS_PATTERN}" 2>/dev/null || true
    pkill -f "${DEBUG_PROCESS_PATTERN}" 2>/dev/null || true
    pkill -f "${LOCAL_PROCESS_PATTERN}" 2>/dev/null || true
    pkill -f "${RELEASE_PROCESS_PATTERN}" 2>/dev/null || true
    pkill -x "Moltbot" 2>/dev/null || true
    if ! pgrep -f "${APP_PROCESS_PATTERN}" >/dev/null 2>&1 \
       && ! pgrep -f "${DEBUG_PROCESS_PATTERN}" >/dev/null 2>&1 \
       && ! pgrep -f "${LOCAL_PROCESS_PATTERN}" >/dev/null 2>&1 \
       && ! pgrep -f "${RELEASE_PROCESS_PATTERN}" >/dev/null 2>&1 \
       && ! pgrep -x "Moltbot" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.3
  done
}

stop_launch_agent() {
  launchctl bootout gui/"$UID"/com.clawdbot.mac 2>/dev/null || true
}

# 1) Kill all running instances first.
log "==> Killing existing Moltbot instances"
kill_all_moltbot
stop_launch_agent

# Bundle Gateway-hosted Canvas A2UI assets.
run_step "bundle canvas a2ui" bash -lc "cd '${ROOT_DIR}' && pnpm canvas:a2ui:bundle"

# 2) Rebuild into the same path the packager consumes (.build).
run_step "clean build cache" bash -lc "cd '${ROOT_DIR}/apps/macos' && rm -rf .build .build-swift .swiftpm 2>/dev/null || true"
run_step "swift build" bash -lc "cd '${ROOT_DIR}/apps/macos' && swift build -q --product Moltbot"

if [ "$AUTO_DETECT_SIGNING" -eq 1 ]; then
  if check_signing_keys; then
    log "==> Signing keys detected, will code sign"
    SIGN=1
  else
    log "==> No signing keys found, will skip code signing (--no-sign)"
    NO_SIGN=1
  fi
fi

if [ "$NO_SIGN" -eq 1 ]; then
  export ALLOW_ADHOC_SIGNING=1
  export SIGN_IDENTITY="-"
  mkdir -p "${HOME}/.clawdbot"
  run_step "disable launchagent writes" /usr/bin/touch "${LAUNCHAGENT_DISABLE_MARKER}"
elif [ "$SIGN" -eq 1 ]; then
  if ! check_signing_keys; then
    fail "No signing identity found. Use --no-sign or install a signing key."
  fi
  unset ALLOW_ADHOC_SIGNING
  unset SIGN_IDENTITY
fi

# 3) Package app (no embedded gateway).
run_step "package app" bash -lc "cd '${ROOT_DIR}' && SKIP_TSC=${SKIP_TSC:-1} '${ROOT_DIR}/scripts/package-mac-app.sh'"

choose_app_bundle() {
  if [[ -n "${APP_BUNDLE}" && -d "${APP_BUNDLE}" ]]; then
    return 0
  fi

  if [[ -d "/Applications/Moltbot.app" ]]; then
    APP_BUNDLE="/Applications/Moltbot.app"
    return 0
  fi

  if [[ -d "${ROOT_DIR}/dist/Moltbot.app" ]]; then
    APP_BUNDLE="${ROOT_DIR}/dist/Moltbot.app"
    if [[ ! -d "${APP_BUNDLE}/Contents/Frameworks/Sparkle.framework" ]]; then
      fail "dist/Moltbot.app missing Sparkle after packaging"
    fi
    return 0
  fi

  fail "App bundle not found. Set CLAWDBOT_APP_BUNDLE to your installed Moltbot.app"
}

choose_app_bundle

# When signed, clear any previous launchagent override marker.
if [[ "$NO_SIGN" -ne 1 && "$ATTACH_ONLY" -ne 1 && -f "${LAUNCHAGENT_DISABLE_MARKER}" ]]; then
  run_step "clear launchagent disable marker" /bin/rm -f "${LAUNCHAGENT_DISABLE_MARKER}"
fi

# When unsigned, ensure the gateway LaunchAgent targets the repo CLI (before the app launches).
# This reduces noisy "could not connect" errors during app startup.
if [ "$NO_SIGN" -eq 1 ] && [ "$ATTACH_ONLY" -ne 1 ]; then
  run_step "install gateway launch agent (unsigned)" bash -lc "cd '${ROOT_DIR}' && node dist/entry.js daemon install --force --runtime node"
  run_step "restart gateway daemon (unsigned)" bash -lc "cd '${ROOT_DIR}' && node dist/entry.js daemon restart"
  if [[ "${GATEWAY_WAIT_SECONDS}" -gt 0 ]]; then
    run_step "wait for gateway (unsigned)" sleep "${GATEWAY_WAIT_SECONDS}"
  fi
  GATEWAY_PORT="$(
    node -e '
      const fs = require("node:fs");
      const path = require("node:path");
      try {
        const raw = fs.readFileSync(path.join(process.env.HOME, ".clawdbot", "moltbot.json"), "utf8");
        const cfg = JSON.parse(raw);
        const port = cfg && cfg.gateway && typeof cfg.gateway.port === "number" ? cfg.gateway.port : 18789;
        process.stdout.write(String(port));
      } catch {
        process.stdout.write("18789");
      }
    '
  )"
  run_step "verify gateway port ${GATEWAY_PORT} (unsigned)" bash -lc "lsof -iTCP:${GATEWAY_PORT} -sTCP:LISTEN | head -n 5 || true"
fi

ATTACH_ONLY_ARGS=()
if [[ "$ATTACH_ONLY" -eq 1 ]]; then
  ATTACH_ONLY_ARGS+=(--args --attach-only)
fi

# 4) Launch the installed app in the foreground so the menu bar extra appears.
# LaunchServices can inherit a huge environment from this shell (secrets, prompt vars, etc.).
# That can cause launchd spawn failures and is undesirable for a GUI app anyway.
run_step "launch app" env -i \
  HOME="${HOME}" \
  USER="${USER:-$(id -un)}" \
  LOGNAME="${LOGNAME:-$(id -un)}" \
  TMPDIR="${TMPDIR:-/tmp}" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  LANG="${LANG:-en_US.UTF-8}" \
  /usr/bin/open "${APP_BUNDLE}" ${ATTACH_ONLY_ARGS[@]:+"${ATTACH_ONLY_ARGS[@]}"}

# 5) Verify the app is alive.
sleep 1.5
if pgrep -f "${APP_PROCESS_PATTERN}" >/dev/null 2>&1; then
  log "OK: Moltbot is running."
else
  fail "App exited immediately. Check ${LOG_PATH} or Console.app (User Reports)."
fi

if [ "$NO_SIGN" -eq 1 ] && [ "$ATTACH_ONLY" -ne 1 ]; then
  run_step "show gateway launch agent args (unsigned)" bash -lc "/usr/bin/plutil -p '${HOME}/Library/LaunchAgents/com.clawdbot.gateway.plist' | head -n 40 || true"
fi
