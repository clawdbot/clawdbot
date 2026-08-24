#!/usr/bin/env bash
set -euo pipefail
result=0
scripts/mantis/stop-lease-keepalive.sh \
  "$LEASE_KEEPALIVE_PID_FILE" \
  "$LEASE_FILE" \
  "$GITHUB_WORKSPACE" || result=1

active_codex_pids() {
  sudo ps -u codex -o pid=,stat= 2>/dev/null | awk '$2 !~ /^Z/ {print $1}' || true
}
sudo pkill -TERM -u codex 2>/dev/null || true
for _ in {1..10}; do
  [[ -z "$(active_codex_pids)" ]] && break
  sleep 1
done
sudo pkill -KILL -u codex 2>/dev/null || true
if [[ -n "$(active_codex_pids)" ]]; then
  echo "Codex processes remained after cleanup." >&2
  result=1
fi

session_root="$SESSION_ROOT"
if [[ -n "$session_root" ]]; then
  lock="$session_root/harness.lock"
  if sudo test -f "$lock"; then
    lane_pid="$(sudo cat "$lock")"
    remove_lock=false
    if [[ "$lane_pid" =~ ^[1-9][0-9]*$ ]] && sudo test -d "/proc/$lane_pid"; then
      sut_uid="$(id -u mantis-sut)"
      lane_uid="$(sudo stat -c %u "/proc/$lane_pid")"
      lane_pgid="$(sudo ps -o pgid= -p "$lane_pid" | tr -d ' ')"
      lane_exe="$(sudo readlink -f "/proc/$lane_pid/exe")"
      lane_args="$(sudo tr '\0' '\n' <"/proc/$lane_pid/cmdline")"
      if [[ "$lane_uid" == "$sut_uid" && "$lane_pgid" == "$lane_pid" && "$lane_exe" == /usr/local/lib/mantis-toolchain/node ]] &&
        grep -Fxq /usr/local/lib/mantis-toolchain/scripts/e2e/telegram-mantis-lane.mjs <<<"$lane_args"; then
        sudo kill -TERM -- "-$lane_pgid" 2>/dev/null || true
        for _ in {1..10}; do
          sudo kill -0 -- "-$lane_pgid" 2>/dev/null || break
          sleep 1
        done
        sudo kill -KILL -- "-$lane_pgid" 2>/dev/null || true
        for _ in {1..10}; do
          sudo kill -0 -- "-$lane_pgid" 2>/dev/null || break
          sleep 1
        done
        if sudo kill -0 -- "-$lane_pgid" 2>/dev/null; then
          echo "Mantis lane process group remained after SIGKILL." >&2
          result=1
        else
          remove_lock=true
        fi
      else
        echo "Refusing to kill an unverified Mantis lock owner." >&2
        result=1
      fi
    else
      remove_lock=true
    fi
    [[ "$remove_lock" == true ]] && sudo rm -f "$lock"
  fi

  for lane in baseline candidate; do
    if sudo test -f "$session_root/${lane}.active.json" || sudo test -f "$session_root/${lane}.starting.json"; then
      "/usr/local/bin/mantis-telegram-${lane}" abort >/dev/null 2>&1 || result=1
    fi
  done
  /usr/local/bin/openclaw-telegram-desktop-recorder teardown \
    --session desktop-recorder.json >/dev/null 2>&1 || result=1
  if sudo test -f "$lock"; then
    echo "Mantis harness lock remained after cleanup." >&2
    result=1
  fi
fi
if ((result == 0)); then
  echo "safe_to_release=true" >> "$GITHUB_OUTPUT"
fi
exit "$result"
