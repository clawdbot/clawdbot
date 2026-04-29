#!/usr/bin/env bash
#
# Shared helpers for Docker E2E scripts that keep a named container running
# while polling readiness from the host.

docker_e2e_docker_cmd() {
  if command -v timeout >/dev/null 2>&1; then
    timeout "${DOCKER_COMMAND_TIMEOUT:-600s}" docker "$@"
    return
  fi
  docker "$@"
}

docker_e2e_container_running() {
  local container_name="$1"
  [ "$(docker_e2e_docker_cmd inspect -f '{{.State.Running}}' "$container_name" 2>/dev/null || echo false)" = "true" ]
}

docker_e2e_container_exec_bash() {
  local container_name="$1"
  shift
  docker_e2e_docker_cmd exec "$container_name" bash -lc "$*"
}

docker_e2e_wait_container_bash() {
  local container_name="$1"
  shift
  docker_e2e_wait_container_bash_while_running "$container_name" "$container_name" "$@"
}

docker_e2e_wait_container_bash_while_running() {
  local running_container_name="$1"
  local exec_container_name="$2"
  local attempts="$3"
  local sleep_seconds="$4"
  shift 4
  local probe="$*"

  for _ in $(seq 1 "$attempts"); do
    if ! docker_e2e_container_running "$running_container_name"; then
      return 1
    fi
    if docker_e2e_container_exec_bash "$exec_container_name" "$probe" >/dev/null 2>&1; then
      return 0
    fi
    sleep "$sleep_seconds"
  done
  return 1
}

docker_e2e_tail_container_file_if_running() {
  local container_name="$1"
  local file_path="$2"
  local lines="${3:-120}"
  if docker_e2e_container_running "$container_name"; then
    docker_e2e_container_exec_bash "$container_name" "tail -n $lines $file_path" || true
  else
    docker_e2e_docker_cmd logs "$container_name" 2>&1 | tail -n "$lines" || true
  fi
}
