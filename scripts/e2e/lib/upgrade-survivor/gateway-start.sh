#!/usr/bin/env bash
upgrade_survivor_start_gateway() {
  local log="${1:?missing gateway log}" attempts="${2:?missing readiness attempts}"
  local ready_port="${3:?missing gateway port}" readiness_mode="${4:-strict}"
  shift 4
  local refusal="OpenClaw plugin migration inputs changed during startup convergence; refusing to report the gateway ready. Restart OpenClaw so state migrations run against the final config and plugin inventory."
  local attempt log_offset child_status
  : >"$log"
  for attempt in 1 2; do
    log_offset="$(wc -c <"$log")"
    "$@" >>"$log" 2>&1 &
    gateway_pid="$!"
    child_status=""
    if openclaw_e2e_wait_gateway_ready \
      "$gateway_pid" "$log" "$attempts" child_status "$ready_port" "$readiness_mode"; then
      return 0
    fi
    if [ "$attempt" -ne 1 ] || [ "$child_status" != "1" ]; then
      return 1
    fi
    tail -c "+$((log_offset + 1))" "$log" | grep -Fqx -- "$refusal" || return 1
  done
}
