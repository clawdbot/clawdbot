#!/usr/bin/env bash
# Reset OpenClaw like Trimmy: kill running instances, rebuild, repackage, relaunch, verify.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib/restart-mac-gateway.sh"
APP_BUNDLE="${OPENCLAW_APP_BUNDLE:-}"
APP_EXECUTABLE_RELATIVE_PATH="Contents/MacOS/OpenClaw"
DEBUG_PROCESS_PATTERN="${ROOT_DIR}/apps/macos/.build/debug/OpenClaw"
LOCAL_PROCESS_PATTERN="${ROOT_DIR}/apps/macos/.build-local/debug/OpenClaw"
RELEASE_PROCESS_PATTERN="${ROOT_DIR}/apps/macos/.build/release/OpenClaw"
LAUNCH_AGENT="${HOME}/Library/LaunchAgents/ai.openclaw.mac.plist"
LOCK_KEY="$(printf '%s' "${ROOT_DIR}" | shasum -a 256 | cut -c1-8)"
LOCK_DIR="${TMPDIR:-/tmp}/openclaw-restart-${LOCK_KEY}"
LOCK_PID_FILE="${LOCK_DIR}/pid"
LOCK_HELD=0
WAIT_FOR_LOCK=0
LOG_PATH="${OPENCLAW_RESTART_LOG:-${TMPDIR:-/tmp}/openclaw-restart-${LOCK_KEY}.log}"
NO_SIGN=0
SIGN=0
AUTO_DETECT_SIGNING=1
GATEWAY_WAIT_SECONDS="${OPENCLAW_GATEWAY_WAIT_SECONDS:-0}"
LAUNCHAGENT_DISABLE_MARKER="${HOME}/.openclaw/disable-launchagent"
ATTACH_ONLY=1
TARGET_ONLY=0
TARGET_APP_BUNDLE="${ROOT_DIR}/dist/OpenClaw.app"
TARGET_EXECUTABLE="${TARGET_APP_BUNDLE}/${APP_EXECUTABLE_RELATIVE_PATH}"
INSTALLED_EXECUTABLE="/Applications/OpenClaw.app/${APP_EXECUTABLE_RELATIVE_PATH}"
STAGED_APP_DIR="${ROOT_DIR}/dist/.openclaw-replacement-${LOCK_KEY}-$$"
STAGED_APP_BUNDLE="${STAGED_APP_DIR}/OpenClaw.app"

log()  { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Ensure local node binaries (rolldown, pnpm) are discoverable for the steps below.
export PATH="${ROOT_DIR}/node_modules/.bin:${PATH}"

run_step() {
  local label="$1"; shift
  log "==> ${label}"
  if ! "$@"; then
    fail "${label} failed"
  fi
}

cleanup() {
  if [[ -n "${STAGED_APP_DIR:-}" ]]; then
    rm -rf "${STAGED_APP_DIR}"
  fi
  if [[ "${LOCK_HELD}" != "1" || ! -d "${LOCK_DIR}" ]]; then
    return 0
  fi
  local owner_pid=""
  if [[ -f "${LOCK_PID_FILE}" ]]; then
    owner_pid="$(cat "${LOCK_PID_FILE}" 2>/dev/null || true)"
  fi
  if [[ -z "${owner_pid}" || "${owner_pid}" == "$$" ]]; then
    rm -rf "${LOCK_DIR}"
  fi
}

acquire_lock() {
  while true; do
    if mkdir "${LOCK_DIR}" 2>/dev/null; then
      LOCK_HELD=1
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

canonicalize_app_bundle() {
  if [[ -z "${APP_BUNDLE}" ]]; then
    return 0
  fi
  if [[ ! -d "${APP_BUNDLE}" ]]; then
    fail "OPENCLAW_APP_BUNDLE does not exist: ${APP_BUNDLE}"
  fi
  APP_BUNDLE="$(cd "${APP_BUNDLE}" && pwd -P)"
}

trap cleanup EXIT INT TERM

for arg in "$@"; do
  case "${arg}" in
    --wait|-w) WAIT_FOR_LOCK=1 ;;
    --no-sign) NO_SIGN=1; AUTO_DETECT_SIGNING=0 ;;
    --sign) SIGN=1; AUTO_DETECT_SIGNING=0 ;;
    --attach-only) ATTACH_ONLY=1 ;;
    --no-attach-only) ATTACH_ONLY=0 ;;
    --target-only) TARGET_ONLY=1 ;;
    --help|-h)
      log "Usage: $(basename "$0") [--wait] [--no-sign] [--sign] [--attach-only|--no-attach-only] [--target-only]"
      log "  --wait    Wait for other restart to complete instead of exiting"
      log "  --no-sign Force no code signing (fastest for development)"
      log "  --sign    Force code signing (will fail if no signing key available)"
      log "  --attach-only    Launch app with --attach-only (skip launchd install)"
      log "  --no-attach-only Launch app without attach-only override"
      log "  --target-only    Restart only this checkout's dist app; fail if another OpenClaw app is active"
      log ""
      log "Env:"
      log "  OPENCLAW_GATEWAY_WAIT_SECONDS=0  Wait time before gateway port check (unsigned only)"
      log ""
      log "Unsigned recovery:"
      log "  node openclaw.mjs daemon install --force --runtime node"
      log "  node openclaw.mjs daemon restart"
      log ""
      log "Reset unsigned overrides:"
      log "  rm ~/.openclaw/disable-launchagent"
      log ""
      log "Default behavior: Auto-detect signing keys, fallback to --no-sign if none found"
      exit 0
      ;;
    --) ;;
    *) fail "Unknown restart option: ${arg}" ;;
  esac
done

if [[ "$NO_SIGN" -eq 1 && "$SIGN" -eq 1 ]]; then
  fail "Cannot use --sign and --no-sign together"
fi
if [[ "$TARGET_ONLY" -eq 1 && "$ATTACH_ONLY" -ne 1 ]]; then
  fail "--target-only requires --attach-only"
fi
if [[ "$TARGET_ONLY" -eq 1 && -n "$APP_BUNDLE" ]]; then
  fail "--target-only does not accept OPENCLAW_APP_BUNDLE"
fi
canonicalize_app_bundle

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

kill_all_openclaw() {
  for _ in {1..10}; do
    local pids=""
    pids="$(openclaw_process_pids)"
    if [[ -z "${pids}" ]]; then
      return 0
    fi
    while IFS= read -r pid; do
      kill "${pid}" 2>/dev/null || true
    done <<< "${pids}"
    sleep 0.3
  done
  [[ -z "$(openclaw_process_pids)" ]]
}

known_openclaw_executables() {
  if [[ -n "${APP_BUNDLE}" ]]; then
    printf '%s\n' "${APP_BUNDLE}/${APP_EXECUTABLE_RELATIVE_PATH}"
  fi
  printf '%s\n' \
    "${ROOT_DIR}/dist/OpenClaw.app/${APP_EXECUTABLE_RELATIVE_PATH}" \
    "/Applications/OpenClaw.app/${APP_EXECUTABLE_RELATIVE_PATH}" \
    "${DEBUG_PROCESS_PATTERN}" \
    "${LOCAL_PROCESS_PATTERN}" \
    "${RELEASE_PROCESS_PATTERN}"
}

openclaw_process_pids() {
  local pattern=""
  while IFS= read -r pattern; do
    [[ -n "${pattern}" ]] || continue
    process_pids_matching "${pattern}"
  done < <(known_openclaw_executables) | sort -u
}

process_pids_matching() {
  local pattern="$1"
  ps axww -o pid=,command= 2>/dev/null \
    | while read -r pid command_line; do
        [[ "${pid}" =~ ^[0-9]+$ ]] || continue
        [[ "${pid}" != "$$" ]] || continue
        [[ "${command_line}" == *"${pattern}"* ]] || continue
        printf '%s\n' "${pid}"
      done
}

foreign_openclaw_process_pids() {
  ps axww -o pid=,command= 2>/dev/null \
    | while read -r pid command_line; do
        [[ "${pid}" =~ ^[0-9]+$ ]] || continue
        [[ "${pid}" != "$$" ]] || continue
        local executable="${command_line%% *}"
        [[ "${executable}" == "${TARGET_EXECUTABLE}" ]] && continue
        [[ "${executable}" == "${INSTALLED_EXECUTABLE}" ]] && continue
        if [[ "${executable}" == *"/OpenClaw.app/${APP_EXECUTABLE_RELATIVE_PATH}" \
          || "${executable}" == *"/apps/macos/.build/debug/OpenClaw" \
          || "${executable}" == *"/apps/macos/.build-local/debug/OpenClaw" \
          || "${executable}" == *"/apps/macos/.build/release/OpenClaw" ]]; then
          printf '%s\n' "${pid}"
        fi
      done
}

process_pids_for_executable() {
  local executable="$1"
  ps axww -o pid=,command= 2>/dev/null \
    | while read -r pid command_line; do
        [[ "${pid}" =~ ^[0-9]+$ ]] || continue
        [[ "${pid}" != "$$" ]] || continue
        [[ "${command_line}" == "${executable}" || "${command_line}" == "${executable} "* ]] || continue
        printf '%s\n' "${pid}"
      done
}

managed_openclaw_process_pids() {
  {
    process_pids_for_executable "${TARGET_EXECUTABLE}"
    process_pids_for_executable "${INSTALLED_EXECUTABLE}"
  } | sort -u
}

launch_domain_jobs() {
  local domain="$1"
  local snapshot=""
  if ! snapshot="$(/bin/launchctl print "${domain}" 2>/dev/null)"; then
    return 1
  fi
  printf '%s\n' "${snapshot}" | /usr/bin/awk -v domain="${domain}" '
    /^[[:space:]]*services = \{$/ { services = 1; next }
    services && /^[[:space:]]*\}$/ { services = 0; next }
    services && NF >= 3 { print domain "|" $NF }
  '
}

loaded_launch_jobs() {
  local uid=""
  uid="$(/usr/bin/id -u)"
  local domain=""
  for domain in "gui/${uid}" "user/${uid}" system; do
    launch_domain_jobs "${domain}" || return 1
  done
}

launch_job_snapshot() {
  local domain="$1"
  local label="$2"
  /bin/launchctl print "${domain}/${label}" 2>/dev/null
}

# A launchd-owned app will immediately respawn after target-only cleanup. Find
# exact managed executables before the expensive Swift build so the operator
# can stop the owning job instead of waiting for an inevitable switch failure.
print_managed_openclaw_supervisor_label() {
  local domain="$1"
  local label="$2"
  local job=""
  if ! job="$(launch_job_snapshot "${domain}" "${label}")"; then
    return 0
  fi
  local executable=""
  executable="$(/usr/bin/awk -F ' = ' '/^[[:space:]]*program = / { print $2; exit }' <<<"${job}")"
  local properties=""
  properties="$(/usr/bin/awk -F ' = ' '/^[[:space:]]*properties = / { print $2; exit }' <<<"${job}")"
  local is_managed_executable=0
  if [[ "${executable}" == "${TARGET_EXECUTABLE}" || "${executable}" == "${INSTALLED_EXECUTABLE}" ]]; then
    is_managed_executable=1
  fi
  if [[ "${is_managed_executable}" -eq 1 && " ${properties} " == *" keepalive "* ]]; then
    printf '%s\n' "${label}"
  fi
}

managed_openclaw_supervisor_labels() {
  local jobs=""
  if ! jobs="$(loaded_launch_jobs)"; then
    return 1
  fi
  local batch_size=0
  local domain=""
  local label=""
  while IFS='|' read -r domain label; do
    [[ -n "${domain}" && -n "${label}" ]] || continue
    print_managed_openclaw_supervisor_label "${domain}" "${label}" &
    batch_size=$((batch_size + 1))
    if [[ "${batch_size}" -ge 16 ]]; then
      wait
      batch_size=0
    fi
  done <<< "${jobs}"
  wait
}

kill_managed_openclaw() {
  for _ in {1..10}; do
    local pids=""
    pids="$(managed_openclaw_process_pids)"
    if [[ -z "${pids}" ]]; then
      return 0
    fi
    while IFS= read -r pid; do
      kill "${pid}" 2>/dev/null || true
    done <<< "${pids}"
    sleep 0.3
  done
  # The app can keep handling SIGTERM while shutting down. Escalate only for
  # the two exact executables target-only mode has already classified as safe.
  local remaining_pids=""
  remaining_pids="$(managed_openclaw_process_pids)"
  while IFS= read -r pid; do
    [[ -n "${pid}" ]] || continue
    kill -KILL "${pid}" 2>/dev/null || true
  done <<< "${remaining_pids}"
  sleep 0.3
  [[ -z "$(managed_openclaw_process_pids)" ]]
}

stop_launch_agent() {
  launchctl bootout gui/"$UID"/ai.openclaw.mac 2>/dev/null || true
}

# 1) Validate the process set selected by the requested mode. Target-only keeps
# the current managed app alive while the replacement builds and signs.
if [[ "$TARGET_ONLY" -eq 1 ]]; then
  if ! managed_supervisors="$(managed_openclaw_supervisor_labels | sort -u | /usr/bin/paste -sd, -)"; then
    fail "Unable to inspect loaded launchd jobs before target-only restart"
  fi
  if [[ -n "${managed_supervisors}" ]]; then
    fail "Managed OpenClaw app is supervised by launchd job(s): ${managed_supervisors}; stop those jobs before a target-only restart"
  fi
  if [[ -n "$(foreign_openclaw_process_pids)" ]]; then
    fail "Another OpenClaw app or test process is active; target-only restart deferred"
  fi
  log "==> Keeping managed OpenClaw running while the replacement builds"
else
  stop_launch_agent
  log "==> Killing existing OpenClaw instances"
  if ! kill_all_openclaw; then
    fail "OpenClaw instances did not exit after cleanup attempts"
  fi
fi

# Bundle Gateway-hosted plugin assets.
run_step "bundle plugin assets" bash -c "cd '${ROOT_DIR}' && pnpm plugins:assets:build"

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
  mkdir -p "${HOME}/.openclaw"
  run_step "disable launchagent writes" /usr/bin/touch "${LAUNCHAGENT_DISABLE_MARKER}"
elif [ "$SIGN" -eq 1 ]; then
  if ! check_signing_keys; then
    fail "No signing identity found. Use --no-sign or install a signing key."
  fi
  unset ALLOW_ADHOC_SIGNING
  unset SIGN_IDENTITY
fi

# 3) Package and sign outside the live bundle. A failed package/sign operation
# must leave the currently running and on-disk app untouched.
run_step "package app" env \
  SKIP_TSC="${SKIP_TSC:-1}" \
  OPENCLAW_PACKAGE_APP_ROOT="${STAGED_APP_BUNDLE}" \
  "${ROOT_DIR}/scripts/package-mac-app.sh"
run_step "verify packaged app" /usr/bin/codesign --verify --deep --strict "${STAGED_APP_BUNDLE}"

install_staged_app() {
  local previous="${ROOT_DIR}/dist/.OpenClaw.app.previous-$$"
  rm -rf "${previous}"
  if [[ -d "${TARGET_APP_BUNDLE}" ]]; then
    mv "${TARGET_APP_BUNDLE}" "${previous}"
  fi
  if ! mv "${STAGED_APP_BUNDLE}" "${TARGET_APP_BUNDLE}"; then
    if [[ -d "${previous}" && ! -d "${TARGET_APP_BUNDLE}" ]]; then
      mv "${previous}" "${TARGET_APP_BUNDLE}"
    fi
    return 1
  fi
  rm -rf "${previous}" "${STAGED_APP_DIR}"
}

choose_app_bundle() {
  if [[ -n "${APP_BUNDLE}" ]]; then
    canonicalize_app_bundle
    return 0
  fi

  if [[ -d "${ROOT_DIR}/dist/OpenClaw.app" ]]; then
    APP_BUNDLE="$(cd "${ROOT_DIR}/dist/OpenClaw.app" && pwd -P)"
    if [[ ! -d "${APP_BUNDLE}/Contents/Frameworks/Sparkle.framework" ]]; then
      fail "dist/OpenClaw.app missing Sparkle after packaging"
    fi
    return 0
  fi

  if [[ -d "/Applications/OpenClaw.app" ]]; then
    APP_BUNDLE="$(cd "/Applications/OpenClaw.app" && pwd -P)"
    return 0
  fi

  fail "App bundle not found. Set OPENCLAW_APP_BUNDLE to your installed OpenClaw.app"
}

# When signed, clear any previous launchagent override marker.
if [[ "$NO_SIGN" -ne 1 && "$ATTACH_ONLY" -ne 1 && -f "${LAUNCHAGENT_DISABLE_MARKER}" ]]; then
  run_step "clear launchagent disable marker" /bin/rm -f "${LAUNCHAGENT_DISABLE_MARKER}"
fi

# When unsigned, ensure the gateway LaunchAgent targets the repo CLI (before the app launches).
# This reduces noisy "could not connect" errors during app startup.
if [ "$NO_SIGN" -eq 1 ] && [ "$ATTACH_ONLY" -ne 1 ]; then
  run_step "install gateway launch agent (unsigned)" bash -c "cd '${ROOT_DIR}' && node openclaw.mjs daemon install --force --runtime node"
  run_step "restart gateway daemon (unsigned)" bash -c "cd '${ROOT_DIR}' && node openclaw.mjs daemon restart"
  if [[ "${GATEWAY_WAIT_SECONDS}" -gt 0 ]]; then
    run_step "wait for gateway (unsigned)" sleep "${GATEWAY_WAIT_SECONDS}"
  fi
  GATEWAY_PORT="$(
    node -e '
      const fs = require("node:fs");
      const path = require("node:path");
      try {
        const raw = fs.readFileSync(path.join(process.env.HOME, ".openclaw", "openclaw.json"), "utf8");
        const cfg = JSON.parse(raw);
        const port = cfg && cfg.gateway && typeof cfg.gateway.port === "number" ? cfg.gateway.port : 18789;
        process.stdout.write(String(port));
      } catch {
        process.stdout.write("18789");
      }
    '
  )"
  run_step "verify gateway port ${GATEWAY_PORT} (unsigned)" verify_gateway_port_listening "${GATEWAY_PORT}"
fi

ATTACH_ONLY_ARGS=()
if [[ "$ATTACH_ONLY" -eq 1 ]]; then
  ATTACH_ONLY_ARGS+=(--args --attach-only)
fi

if [[ "$TARGET_ONLY" -eq 1 ]]; then
  if [[ -n "$(foreign_openclaw_process_pids)" ]]; then
    fail "Another OpenClaw app or test process appeared during build; target-only restart deferred"
  fi
  log "==> Switching managed installed and exact target OpenClaw instances"
  if ! kill_managed_openclaw; then
    fail "Managed OpenClaw instances did not exit after cleanup attempts"
  fi
fi

run_step "install packaged app" install_staged_app
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
  /usr/bin/open -n "${APP_BUNDLE}" ${ATTACH_ONLY_ARGS[@]:+"${ATTACH_ONLY_ARGS[@]}"}

# 5) Verify the app is alive.
sleep 1.5
if [[ -n "$(process_pids_matching "${APP_BUNDLE}/${APP_EXECUTABLE_RELATIVE_PATH}")" ]]; then
  log "OK: OpenClaw is running."
else
  fail "App exited immediately. Check ${LOG_PATH} or Console.app (User Reports)."
fi

if [ "$NO_SIGN" -eq 1 ] && [ "$ATTACH_ONLY" -ne 1 ]; then
  run_step "show gateway launch agent args (unsigned)" bash -c "/usr/bin/plutil -p '${HOME}/Library/LaunchAgents/ai.openclaw.gateway.plist' | head -n 40 || true"
fi
