#!/usr/bin/env bash

upgrade_survivor_process_group_has_live_members() {
  local pid="$1"
  local stat_file stat_line stat_fields state parent process_group remaining
  # The PGID remains authoritative after its leader exits while descendants still own the port.
  kill -0 -- "-$pid" >/dev/null 2>&1 || return 1
  # Treat unreadable or malformed proc state as live so replacement cannot race an unknown owner.
  [ -r "/proc/$$/stat" ] || return 0
  for stat_file in /proc/[0-9]*/stat; do
    [ -e "$stat_file" ] || continue
    IFS= read -r stat_line <"$stat_file" || { [ ! -e "$stat_file" ] && continue; return 0; }
    stat_fields="${stat_line##*) }"
    [ "$stat_fields" != "$stat_line" ] || return 0
    read -r state parent process_group remaining <<<"$stat_fields"
    [[ "$state" =~ ^[A-Za-z]$ && "$parent" =~ ^[0-9]+$ && "$process_group" =~ ^[0-9]+$ ]] && [ -n "$remaining" ] || return 0
    [ "$process_group" != "$pid" ] || case "$state" in Z | X) ;; *) return 0 ;; esac
  done
  return 1
}

upgrade_survivor_append_systemctl_process_helpers() {
  declare -f upgrade_survivor_process_group_has_live_members >>"$1" || return 1
  cat >>"$1" <<'SHIM'
read_ownership() {
  local ownership="pid"
  [ ! -e "$ownership_file" ] || ownership="$(cat "$ownership_file" 2>/dev/null || true)"
  case "$ownership" in
    pid | process-group) printf '%s\n' "$ownership" ;;
    *) echo "systemctl shim invalid process ownership: $ownership" >&2; return 2 ;;
  esac
}

owned_process_running() {
  local pid="$1" ownership="$2"
  if [ "$ownership" = "process-group" ]; then
    upgrade_survivor_process_group_has_live_members "$pid"
    return $?
  fi
  kill -0 "$pid" >/dev/null 2>&1 || return 1
  [ "$(awk '{ print $3 }' "/proc/$pid/stat" 2>/dev/null || true)" != "Z" ]
}

is_running() {
  local pid ownership
  [ -s "$pid_file" ] || return 1
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] || return 2
  ownership="$(read_ownership)" || return $?
  owned_process_running "$pid" "$ownership"
}

stop_gateway() {
  local pid ownership target stop_deadline kill_deadline
  [ -s "$pid_file" ] || {
    rm -f "$ownership_file" "$supervisor_script"
    return 0
  }
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] && [ "$pid" -gt 1 ] || {
    echo "systemctl shim invalid pid: $pid" >&2
    return 2
  }
  ownership="$(read_ownership)" || return $?
  target="$pid"
  [ "$ownership" = "pid" ] || target="-$pid"
  stop_deadline=$((SECONDS + 35))
  kill_deadline=$((stop_deadline - 5))
  kill -TERM -- "$target" >/dev/null 2>&1 || true
  while owned_process_running "$pid" "$ownership" && [ "$SECONDS" -lt "$kill_deadline" ]; do
    sleep 0.1
  done
  owned_process_running "$pid" "$ownership" &&
    kill -KILL -- "$target" >/dev/null 2>&1 || true
  while owned_process_running "$pid" "$ownership" && [ "$SECONDS" -lt "$stop_deadline" ]; do
    sleep 0.1
  done
  if owned_process_running "$pid" "$ownership"; then
    echo "systemctl shim could not stop $ownership $pid" >&2
    return 1
  fi
  rm -f "$pid_file" "$ownership_file" "$supervisor_script"
}

SHIM
}

upgrade_survivor_start_gateway_with_convergence_retry() {
  if [ "$#" -lt 8 ]; then
    return 2
  fi

  local output_var="$1"
  local log_file="$2"
  local readiness_attempts="$3"
  local port="$4"
  local readiness_mode="$5"
  local absolute_deadline="$6"
  local ownership_var=""
  shift 6
  if [ "$1" != "--" ]; then
    ownership_var="$1"
    shift
  fi
  if [ "$1" != "--" ]; then
    return 2
  fi
  shift

  if ! [[ "$output_var" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] ||
    { [ -n "$ownership_var" ] && { ! [[ "$ownership_var" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || [ "$ownership_var" = "$output_var" ]; }; } ||
    [ -z "$log_file" ] ||
    ! [[ "$readiness_attempts" =~ ^[0-9]+$ ]] ||
    [ "$readiness_attempts" -lt 1 ] ||
    { [ -n "$port" ] && { ! [[ "$port" =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ]; }; } ||
    ! [[ "$absolute_deadline" =~ ^[0-9]+$ ]] ||
    { [ "$readiness_mode" != "strict" ] && [ "$readiness_mode" != "legacy-ready-log-ok" ]; } ||
    [ "$#" -eq 0 ] ||
    [ "$(uname -s)" != "Linux" ] ||
    ! command -v setsid >/dev/null 2>&1; then
    return 2
  fi

  printf -v "$output_var" '%s' ""
  [ -z "$ownership_var" ] || printf -v "$ownership_var" '%s' ""
  local launch_attempt leader child_status offset stderr_file wait_status
  local retry_prefix="OpenClaw plugin migration inputs changed during startup convergence;"

  for ((launch_attempt = 1; launch_attempt <= 2; launch_attempt++)); do
    if [ "$SECONDS" -ge "$absolute_deadline" ]; then
      return 1
    fi

    offset=0
    if [ -f "$log_file" ]; then
      offset="$(wc -c <"$log_file")" || return 1
      offset="${offset//[[:space:]]/}"
      [[ "$offset" =~ ^[0-9]+$ ]] || return 1
    fi
    stderr_file="$(mktemp "${TMPDIR:-/tmp}/openclaw-upgrade-survivor-stderr.XXXXXX")" || return 1

    if [ "$launch_attempt" -eq 2 ]; then
      if [ "$SECONDS" -ge "$absolute_deadline" ]; then
        rm -f "$stderr_file"
        return 1
      fi
      printf '%s\n' "[upgrade-survivor] retrying gateway startup after convergence input change" |
        tee -a "$log_file"
    fi
    setsid bash -c '
      log="$1"
      stderr_capture="$2"
      shift 2
      "$@" >>"$log" 2> >(tee -a "$log" >"$stderr_capture")
      status=$?
      wait
      exit "$status"
    ' bash "$log_file" "$stderr_file" "$@" &
    leader="$!"
    child_status=""
    wait_status=0
    openclaw_e2e_wait_gateway_ready \
      "$leader" "$log_file" "$readiness_attempts" "$port" "$readiness_mode" \
      child_status "$absolute_deadline" "$offset" || wait_status="$?"
    if [ "$wait_status" -eq 0 ]; then
      rm -f "$stderr_file"
      printf -v "$output_var" '%s' "$leader"
      [ -z "$ownership_var" ] || printf -v "$ownership_var" '%s' "process-group"
      return 0
    fi

    openclaw_e2e_stop_process "$leader"

    if [ "$launch_attempt" -eq 1 ] &&
      [ "$wait_status" -eq 1 ] &&
      [ "$child_status" = "1" ] &&
      [ "$SECONDS" -lt "$absolute_deadline" ] &&
      awk -v prefix="$retry_prefix" 'index($0, prefix) == 1 { found = 1; exit } END { exit !found }' "$stderr_file"; then
      while upgrade_survivor_process_group_has_live_members "$leader" &&
        [ "$SECONDS" -lt "$absolute_deadline" ]; do
        sleep 0.1
      done
      if upgrade_survivor_process_group_has_live_members "$leader"; then
        rm -f "$stderr_file"
        return 1
      fi
      rm -f "$stderr_file"
      continue
    fi

    rm -f "$stderr_file"
    return "$wait_status"
  done

  return 1
}
