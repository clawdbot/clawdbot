#!/usr/bin/env bash

extract_openclaw_semver() {
  local raw="${1:-}"
  raw="${raw//$'\r'/}"
  if [[ "$raw" =~ v?([0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?(\+[0-9A-Za-z.-]+)?) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
  fi
}

quiet_npm() {
  npm \
    --loglevel=error \
    --logs-max=0 \
    --no-update-notifier \
    --no-fund \
    --no-audit \
    --no-progress \
    "$@"
}
