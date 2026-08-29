#!/usr/bin/env bash
set -euo pipefail

stop_lease_keepalive() {
  local keepalive_pid_file="$1"
  local lease_file="$2"
  local expected_cwd="$3"
  [[ -n "$keepalive_pid_file" && -f "$keepalive_pid_file" ]] || return 0
  local keepalive_pid
  keepalive_pid="$(<"$keepalive_pid_file")"
  [[ "$keepalive_pid" =~ ^[1-9][0-9]*$ ]]
  if [[ -d "/proc/$keepalive_pid" ]]; then
    local keepalive_uid keepalive_pgid keepalive_exe keepalive_cwd keepalive_args
    keepalive_uid="$(stat -c %u "/proc/$keepalive_pid")" || return 0
    keepalive_pgid="$(ps -o pgid= -p "$keepalive_pid" | tr -d ' ')" || return 0
    keepalive_exe="$(readlink -f "/proc/$keepalive_pid/exe")" || return 0
    keepalive_cwd="$(readlink -f "/proc/$keepalive_pid/cwd")" || return 0
    keepalive_args="$(tr '\0' '\n' <"/proc/$keepalive_pid/cmdline")" || return 0
    [[ "$keepalive_uid" == "$(id -u)" ]]
    [[ "$keepalive_pgid" == "$keepalive_pid" ]]
    [[ "$keepalive_exe" == /usr/local/lib/mantis-toolchain/node ]]
    [[ "$keepalive_cwd" == "$expected_cwd" ]]
    grep -Fxq "scripts/e2e/telegram-user-credential.ts" <<<"$keepalive_args"
    grep -Fxq "heartbeat-loop" <<<"$keepalive_args"
    grep -Fxq "$lease_file" <<<"$keepalive_args"
    kill -TERM "$keepalive_pid" 2>/dev/null || true
    local deadline=$((SECONDS + 10))
    while kill -0 "$keepalive_pid" 2>/dev/null && ((SECONDS < deadline)); do
      sleep 1
    done
    if kill -0 "$keepalive_pid" 2>/dev/null; then
      kill -KILL "$keepalive_pid" 2>/dev/null || true
    fi
    deadline=$((SECONDS + 5))
    while kill -0 "$keepalive_pid" 2>/dev/null && ((SECONDS < deadline)); do
      sleep 1
    done
    ! kill -0 "$keepalive_pid" 2>/dev/null
  fi
  rm -f "$keepalive_pid_file"
}

stop_lease_keepalive "$@"
