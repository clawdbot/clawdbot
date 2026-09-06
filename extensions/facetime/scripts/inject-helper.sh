#!/usr/bin/env bash
set -euo pipefail

staged_macabi="${HOME}/Library/Containers/com.apple.FaceTime/Data/tmp/FaceTimeHelper.dylib"
target_app="${FACETIME_HELPER_APP:-FaceTime}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--app" ]]; then
  target_app="${2:-}"
  shift 2
fi
if [[ $# -gt 0 ]]; then
  echo "Usage: $0 [--app FaceTime|Phone]" >&2
  exit 2
fi

case "${target_app}" in
  FaceTime)
    target_bundle="com.apple.FaceTime"
    target_executable="/System/Applications/FaceTime.app/Contents/MacOS/FaceTime"
    ;;
  Phone)
    target_bundle="com.apple.mobilephone"
    target_executable="/System/Applications/Phone.app/Contents/MacOS/Phone"
    ;;
  *)
    echo "Unsupported helper app: ${target_app}. Use FaceTime or Phone." >&2
    exit 1
    ;;
esac

if ! /usr/bin/csrutil status 2>/dev/null | grep -Eq \
  'System Integrity Protection status: disabled|Debugging Restrictions: disabled'; then
  cat >&2 <<'EOF'
System Integrity Protection debugging restrictions are enabled.

This helper uses LLDB to load into Apple's protected FaceTime and Phone apps.
Apple's SIP runtime protections reject that attach even for root. Disable SIP
debugging restrictions from macOS Recovery, reboot, and rerun facetime.setup
before injecting:

  csrutil enable --without debug

This preserves the other SIP protections, but allowing debugger attachment
still reduces macOS security. This plugin never changes SIP itself.

EOF
  exit 1
fi

if ! DevToolsSecurity -status 2>/dev/null | grep -q "enabled"; then
  cat >&2 <<'EOF'
Developer Tools mode is disabled.

Run this once in an interactive Terminal, then rerun this script:

  sudo /usr/sbin/DevToolsSecurity -enable

EOF
  exit 1
fi

dylib="${staged_macabi}"

if [[ -z "${dylib}" || ! -f "${dylib}" ]]; then
  cat >&2 <<EOF
FaceTimeHelper.dylib was not found under:

  ${staged_macabi}

Install and stage the signed native helper first:

  brew install openclaw/tap/openclaw-facetime

EOF
  exit 1
fi

target_tmp="${HOME}/Library/Containers/${target_bundle}/Data/tmp"
mkdir -p "${target_tmp}"
unique_dylib="${target_tmp}/FaceTimeHelper-$(date +%Y%m%d%H%M%S)-$$.dylib"
cp "${dylib}" "${unique_dylib}"
dylib="${unique_dylib}"
ipc_key_file="${HOME}/Library/Application Support/OpenClaw/FaceTime/helper-ipc-key"
auth_sidecar="${dylib}.auth"
lldb_pid=""
watchdog_pid=""
lldb_log="$(mktemp "${TMPDIR:-/tmp}/openclaw-facetime-lldb.XXXXXX")"
cleanup_attach() {
  if [[ -n "${watchdog_pid}" ]] && kill -0 "${watchdog_pid}" 2>/dev/null; then
    kill "${watchdog_pid}" 2>/dev/null || true
  fi
  if [[ -n "${lldb_pid}" ]] && kill -0 "${lldb_pid}" 2>/dev/null; then
    kill "${lldb_pid}" 2>/dev/null || true
  fi
  if [[ -e "${auth_sidecar}" ]]; then
    # Objective-C +load finishes synchronously inside this dlopen. Reinjection
    # always uses a new uniquely named dylib and sidecar, so this path is never
    # reused after LLDB detaches and retaining the credential only adds risk.
    # Unlink the directory entry without reopening it. The injected target can
    # write this container and must not be able to redirect cleanup via symlink.
    /usr/bin/python3 -c \
      'import os, sys; p=sys.argv[1]; os.unlink(p) if os.path.lexists(p) else None' \
      "${auth_sidecar}" >/dev/null 2>&1 || true
  fi
  if [[ -e "${lldb_log}" ]]; then
    /usr/bin/python3 -c \
      'import os, sys; p=sys.argv[1]; os.unlink(p) if os.path.lexists(p) else None' \
      "${lldb_log}" >/dev/null 2>&1 || true
  fi
}
trap cleanup_attach EXIT HUP INT TERM

"${repo_root}/scripts/ensure-helper-ipc-key.sh" >/dev/null
ipc_key="$(tr -d '[:space:]' < "${ipc_key_file}")"
if [[ ! "${ipc_key}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "FaceTime helper authentication key is malformed." >&2
  exit 1
fi
umask 077
printf '%s\n' "${ipc_key}" | /usr/bin/python3 -c '
import os
import sys

path = sys.argv[1]
flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
if hasattr(os, "O_NOFOLLOW"):
    flags |= os.O_NOFOLLOW
descriptor = os.open(path, flags, 0o600)
try:
    with os.fdopen(descriptor, "wb", closefd=False) as handle:
        handle.write(sys.stdin.buffer.read())
        handle.flush()
        os.fsync(descriptor)
finally:
    os.close(descriptor)
' "${auth_sidecar}"

target_pid="${FACETIME_HELPER_PID:-}"
target_name="${target_app} app"

if [[ -z "${target_pid}" ]]; then
  target_pid="$(pgrep -f "${target_executable}" | head -1 || true)"
fi

if [[ -z "${target_pid}" ]]; then
  open -gj -a "${target_app}"
  sleep 2
  target_pid="$(pgrep -f "${target_executable}" | head -1 || true)"
fi

if [[ -z "${target_pid}" && "${target_app}" == "FaceTime" ]]; then
  target_name="FaceTime conversation service"
  target_pid="$(pgrep -f '/com.apple.FaceTime.FTConversationService' | head -1 || true)"
fi

if [[ -z "${target_pid}" ]]; then
  echo "${target_app} is not running. Open ${target_app}, then rerun this script." >&2
  exit 1
fi

echo "Injecting ${dylib}"
echo "Target ${target_name} PID: ${target_pid}"

lldb -p "${target_pid}" \
  -o "expr -- (int)({ void *h = (void *)dlopen(\"${dylib}\", 2); int *ready = h ? (int *)(void *)dlsym(h, \"OpenClawFaceTimeHelperInitialized\") : 0; ready && *ready == 1; })" \
  -o detach \
  -o quit >"${lldb_log}" 2>&1 &
lldb_pid=$!
(
  sleep "${FACETIME_HELPER_ATTACH_TIMEOUT_SECONDS:-90}"
  if kill -0 "${lldb_pid}" 2>/dev/null; then
    echo "LLDB attach to ${target_app} timed out" >&2
    kill "${lldb_pid}" 2>/dev/null || true
  fi
) &
watchdog_pid=$!

set +e
wait "${lldb_pid}"
lldb_status=$?
set -e
lldb_pid=""
kill "${watchdog_pid}" 2>/dev/null || true
wait "${watchdog_pid}" 2>/dev/null || true
watchdog_pid=""
if [[ "${lldb_status}" -ne 0 ]]; then
  /bin/cat "${lldb_log}" >&2
  exit "${lldb_status}"
fi
if ! /usr/bin/grep -Eq '^\(int\) \$[0-9]+ = 1$' "${lldb_log}"; then
  /bin/cat "${lldb_log}" >&2
  echo "LLDB did not confirm that FaceTimeHelper.dylib initialized" >&2
  exit 1
fi
