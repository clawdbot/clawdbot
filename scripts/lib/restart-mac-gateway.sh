#!/usr/bin/env bash

verify_gateway_port_listening() {
  local port="$1"
  local lsof_output=""

  if ! lsof_output="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN 2>&1)"; then
    if [[ -n "${lsof_output}" ]]; then
      printf '%s\n' "${lsof_output}" >&2
    fi
    printf 'No process is listening on gateway port %s.\n' "${port}" >&2
    return 1
  fi

  if [[ -z "${lsof_output}" ]]; then
    printf 'No process is listening on gateway port %s.\n' "${port}" >&2
    return 1
  fi

  awk 'NR <= 5 { print }' <<<"${lsof_output}"
}
