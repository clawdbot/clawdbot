#!/usr/bin/env bash

docker_e2e_resource_limit_error_file() {
  local status="$1"
  local stderr_file="$2"
  local line
  [ "$status" = "125" ] || return 1

  local text=""
  while IFS= read -r line || [ -n "$line" ]; do
    text="${text}${line}
"
  done <"$stderr_file"

  case "$text" in
    *"controller pids is not available"* | *"cgroup controller pids is not available"* | \
      *"NanoCPUs can not be set"* | *"CPU CFS scheduler"* | \
      *"cgroup is not mounted"* | *"cgroup not mounted"* | \
      *"resource limit not supported"* | *"resource limits not supported"*)
      return 0
      ;;
  esac
  return 1
}

docker_e2e_resource_limit_temp_dir() {
  local template="${TMPDIR:-/tmp}/openclaw-docker-resource-limits.XXXXXX"
  if command -v mktemp >/dev/null 2>&1; then
    mktemp -d "$template"
    return
  fi
  if [ -x /usr/bin/mktemp ]; then
    /usr/bin/mktemp -d "$template"
    return
  fi
  echo "mktemp command not found; cannot create Docker resource-limit diagnostics" >&2
  return 127
}

docker_e2e_tee_bin() {
  if command -v tee >/dev/null 2>&1; then
    command -v tee
    return
  fi
  if [ -x /usr/bin/tee ]; then
    printf '%s\n' /usr/bin/tee
    return
  fi
  return 1
}

docker_e2e_tail_bin() {
  if command -v tail >/dev/null 2>&1; then
    command -v tail
    return
  fi
  if [ -x /usr/bin/tail ]; then
    printf '%s\n' /usr/bin/tail
    return
  fi
  return 1
}

docker_e2e_remove_diagnostic_dir() {
  if command -v rm >/dev/null 2>&1; then
    rm -rf "$1"
    return
  fi
  /bin/rm -rf "$1"
}

docker_e2e_print_resource_limit_error() {
  echo "Docker E2E resource limits are incompatible with this Docker runtime. Fix its cgroup support or explicitly opt out with OPENCLAW_DOCKER_E2E_DISABLE_RESOURCE_LIMITS=1." >&2
}

docker_e2e_docker_run_with_resource_diagnostics() {
  local timeout_value="$1"
  shift
  if [ "${#DOCKER_E2E_RUN_RESOURCE_ARGS[@]}" -eq 0 ]; then
    docker_e2e_timeout_cmd "$timeout_value" docker run "$@"
    return
  fi

  local diagnostic_dir=""
  if ! diagnostic_dir="$(docker_e2e_resource_limit_temp_dir)"; then
    docker_e2e_timeout_cmd \
      "$timeout_value" \
      docker run "${DOCKER_E2E_RUN_RESOURCE_ARGS[@]}" "$@"
    return
  fi
  local tee_bin=""
  if ! tee_bin="$(docker_e2e_tee_bin)"; then
    docker_e2e_remove_diagnostic_dir "$diagnostic_dir"
    docker_e2e_timeout_cmd \
      "$timeout_value" \
      docker run "${DOCKER_E2E_RUN_RESOURCE_ARGS[@]}" "$@"
    return
  fi
  local tail_bin=""
  if ! tail_bin="$(docker_e2e_tail_bin)"; then
    docker_e2e_remove_diagnostic_dir "$diagnostic_dir"
    docker_e2e_timeout_cmd \
      "$timeout_value" \
      docker run "${DOCKER_E2E_RUN_RESOURCE_ARGS[@]}" "$@"
    return
  fi
  local stderr_file="${diagnostic_dir}/stderr"
  local stderr_fifo="${diagnostic_dir}/stderr.pipe"
  local capture_fifo="${diagnostic_dir}/capture.pipe"
  local mkfifo_bin=""
  if command -v mkfifo >/dev/null 2>&1; then
    mkfifo_bin="$(command -v mkfifo)"
  elif [ -x /usr/bin/mkfifo ]; then
    mkfifo_bin=/usr/bin/mkfifo
  fi
  if [ -z "$mkfifo_bin" ] || ! "$mkfifo_bin" "$stderr_fifo" "$capture_fifo"; then
    docker_e2e_remove_diagnostic_dir "$diagnostic_dir"
    docker_e2e_timeout_cmd \
      "$timeout_value" \
      docker run "${DOCKER_E2E_RUN_RESOURCE_ARGS[@]}" "$@"
    return
  fi

  "$tail_bin" -c 65536 <"$capture_fifo" >"$stderr_file" &
  local tail_pid="$!"
  "$tee_bin" "$capture_fifo" <"$stderr_fifo" >&2 &
  local tee_pid="$!"
  local run_status=0
  if docker_e2e_timeout_cmd \
    "$timeout_value" \
    docker run "${DOCKER_E2E_RUN_RESOURCE_ARGS[@]}" "$@" \
    2>"$stderr_fifo"; then
    run_status=0
  else
    run_status="$?"
  fi
  wait "$tee_pid" || true
  wait "$tail_pid" || true

  if docker_e2e_resource_limit_error_file "$run_status" "$stderr_file"; then
    docker_e2e_print_resource_limit_error
  fi
  docker_e2e_remove_diagnostic_dir "$diagnostic_dir"
  return "$run_status"
}
