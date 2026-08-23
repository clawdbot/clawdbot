#!/usr/bin/env bash
set -euo pipefail

if (( $# < 3 )) || [[ "$2" != "--" ]]; then
  echo "Usage: run-with-lease-fence.sh <lost-marker-path> -- <command...>" >&2
  exit 64
fi

lost_marker_path="$1"
shift 2

# The marker records broker-confirmed loss of the shared-account lease; continuing
# Telegram I/O would violate broker serialization. The <=1s poll window is accepted
# against the 20-minute lease TTL.
# <&0: a backgrounded command's stdin defaults to /dev/null, which silently
# swallowed the piped agent prompt. The explicit redirect keeps the caller's stdin.
setsid "$@" <&0 &
command_pid=$!

command_exit() {
  local status
  set +e
  wait "$command_pid"
  status=$?
  set -e
  exit "$status"
}

while true; do
  if ! kill -0 "$command_pid" 2>/dev/null; then
    command_exit
  fi

  if [[ -f "$lost_marker_path" ]]; then
    if ! kill -0 "$command_pid" 2>/dev/null; then
      command_exit
    fi
    echo "::error::Telegram QA lease lost mid-run; fencing proof" >&2
    kill -TERM -- "-$command_pid" 2>/dev/null || true
    deadline=$((SECONDS + 15))
    while kill -0 -- "-$command_pid" 2>/dev/null && (( SECONDS < deadline )); do
      sleep 1
    done
    if kill -0 -- "-$command_pid" 2>/dev/null; then
      kill -KILL -- "-$command_pid" 2>/dev/null || true
    fi
    wait "$command_pid" 2>/dev/null || true
    exit 97
  fi

  sleep 1
done
