#!/usr/bin/env bash

extract_openclaw_semver() {
  local raw="${1:-}"
  local parsed=""
  parsed="$(
    printf '%s\n' "$raw" \
      | tr -d '\r' \
      | grep -Eo 'v?[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?(\+[0-9A-Za-z.-]+)?' \
      | head -n 1 \
      || true
  )"
  printf '%s' "${parsed#v}"
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
