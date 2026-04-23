#!/usr/bin/env bash

run_logged() {
  local label="$1"
  shift
  local log_file
  local tmp_dir="${TMPDIR:-/tmp}"
  tmp_dir="${tmp_dir%/}"
  log_file="$(mktemp "$tmp_dir/openclaw-${label}.XXXXXX")"
  if ! "$@" >"$log_file" 2>&1; then
    cat "$log_file"
    rm -f "$log_file"
    return 1
  fi
  rm -f "$log_file"
}
