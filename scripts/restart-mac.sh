#!/usr/bin/env bash
# Reset Clawdis like Trimmy: kill running instances, rebuild, repackage, relaunch, verify.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="${CLAWDIS_APP_BUNDLE:-}"
APP_PROCESS_PATTERN="Clawdis.app/Contents/MacOS/Clawdis"
DEBUG_PROCESS_PATTERN="${ROOT_DIR}/apps/macos/.build/debug/Clawdis"
LOCAL_PROCESS_PATTERN="${ROOT_DIR}/apps/macos/.build-local/debug/Clawdis"
RELEASE_PROCESS_PATTERN="${ROOT_DIR}/apps/macos/.build/release/Clawdis"
LAUNCH_AGENT="${HOME}/Library/LaunchAgents/com.steipete.clawdis.plist"
LOCK_KEY="$(printf '%s' "${ROOT_DIR}" | shasum -a 256 | cut -c1-8)"
LOCK_DIR="${TMPDIR:-/tmp}/clawdis-restart-${LOCK_KEY}"
LOCK_PID_FILE="${LOCK_DIR}/pid"
WAIT_FOR_LOCK=0
LOG_PATH="${CLAWDIS_RESTART_LOG:-/tmp/clawdis-restart.log}"

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

trap cleanup EXIT INT TERM

for arg in "$@"; do
  case "${arg}" in
    --wait|-w) WAIT_FOR_LOCK=1 ;;
    --help|-h)
      log "Usage: $(basename "$0") [--wait]"
      exit 0
      ;;
    *) ;;
  esac
done

mkdir -p "$(dirname "$LOG_PATH")"
rm -f "$LOG_PATH"
exec > >(tee "$LOG_PATH") 2>&1
log "==> Log: ${LOG_PATH}"

acquire_lock

kill_all_clawdis() {
  for _ in {1..10}; do
    pkill -f "${APP_PROCESS_PATTERN}" 2>/dev/null || true
    pkill -f "${DEBUG_PROCESS_PATTERN}" 2>/dev/null || true
    pkill -f "${LOCAL_PROCESS_PATTERN}" 2>/dev/null || true
    pkill -f "${RELEASE_PROCESS_PATTERN}" 2>/dev/null || true
    pkill -x "Clawdis" 2>/dev/null || true
    if ! pgrep -f "${APP_PROCESS_PATTERN}" >/dev/null 2>&1 \
       && ! pgrep -f "${DEBUG_PROCESS_PATTERN}" >/dev/null 2>&1 \
       && ! pgrep -f "${LOCAL_PROCESS_PATTERN}" >/dev/null 2>&1 \
       && ! pgrep -f "${RELEASE_PROCESS_PATTERN}" >/dev/null 2>&1 \
       && ! pgrep -x "Clawdis" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.3
  done
}

stop_launch_agent() {
  launchctl bootout gui/"$UID"/com.steipete.clawdis 2>/dev/null || true
}

# 1) Kill all running instances first.
log "==> Killing existing Clawdis instances"
kill_all_clawdis
stop_launch_agent

# Bundle Gateway-hosted Canvas A2UI assets.
run_step "bundle canvas a2ui" bash -lc "cd '${ROOT_DIR}' && pnpm canvas:a2ui:bundle"

# 2) Rebuild into the same path the packager consumes (.build).
run_step "clean build cache" bash -lc "cd '${ROOT_DIR}/apps/macos' && rm -rf .build .build-swift .swiftpm 2>/dev/null || true"
run_step "swift build" bash -lc "cd '${ROOT_DIR}/apps/macos' && swift build -q --product Clawdis"

# 3) Package app (default to bundling the embedded gateway + CLI).
run_step "package app" bash -lc "cd '${ROOT_DIR}' && SKIP_TSC=${SKIP_TSC:-1} SKIP_GATEWAY_PACKAGE=${SKIP_GATEWAY_PACKAGE:-0} '${ROOT_DIR}/scripts/package-mac-app.sh'"

choose_app_bundle() {
  if [[ -n "${APP_BUNDLE}" && -d "${APP_BUNDLE}" ]]; then
    return 0
  fi

  if [[ -d "/Applications/Clawdis.app" ]]; then
    APP_BUNDLE="/Applications/Clawdis.app"
    return 0
  fi

  if [[ -d "${ROOT_DIR}/dist/Clawdis.app" ]]; then
    APP_BUNDLE="${ROOT_DIR}/dist/Clawdis.app"
    if [[ ! -d "${APP_BUNDLE}/Contents/Frameworks/Sparkle.framework" ]]; then
      fail "dist/Clawdis.app missing Sparkle after packaging"
    fi
    return 0
  fi

  fail "App bundle not found. Set CLAWDIS_APP_BUNDLE to your installed Clawdis.app"
}

choose_app_bundle

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
  /usr/bin/open "${APP_BUNDLE}"

# 5) Verify the app is alive.
sleep 1.5
if pgrep -f "${APP_PROCESS_PATTERN}" >/dev/null 2>&1; then
  log "OK: Clawdis is running."
else
  fail "App exited immediately. Check ${LOG_PATH} or Console.app (User Reports)."
fi
