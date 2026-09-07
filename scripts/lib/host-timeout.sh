#!/usr/bin/env bash

openclaw_host_timeout_bin() {
  if command -v timeout >/dev/null 2>&1; then
    printf '%s\n' timeout
  elif command -v gtimeout >/dev/null 2>&1; then
    printf '%s\n' gtimeout
  else
    return 1
  fi
}

openclaw_host_timeout_cmd() {
  local timeout_value="$1"
  shift
  local timeout_bin
  if ! timeout_bin="$(openclaw_host_timeout_bin)"; then
    "$@"
    return
  fi
  if "$timeout_bin" --kill-after=1s 1s true >/dev/null 2>&1; then
    "$timeout_bin" --kill-after=30s "$timeout_value" "$@"
  else
    "$timeout_bin" "$timeout_value" "$@"
  fi
}
