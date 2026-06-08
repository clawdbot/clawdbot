#!/usr/bin/env bash
set -euo pipefail

cd /repo

export OPENCLAW_STATE_DIR="/tmp/openclaw-test"
export OPENCLAW_CONFIG_PATH="${OPENCLAW_STATE_DIR}/openclaw.json"

print_log_tail() {
  local log_file="$1"
  local max_bytes="${OPENCLAW_CLEANUP_SMOKE_LOG_PRINT_BYTES:-65536}"
  if ! [[ "$max_bytes" =~ ^[0-9]+$ ]] || [ "$max_bytes" -lt 1 ]; then
    max_bytes="65536"
  else
    max_bytes="$((10#$max_bytes))"
  fi
  if [ ! -f "$log_file" ]; then
    return 0
  fi
  local log_bytes
  log_bytes="$(wc -c <"$log_file" 2>/dev/null || echo 0)"
  log_bytes="${log_bytes//[[:space:]]/}"
  if ! [[ "$log_bytes" =~ ^[0-9]+$ ]]; then
    log_bytes="0"
  fi
  if [ "$log_bytes" -le "$max_bytes" ]; then
    cat "$log_file"
    return 0
  fi
  echo "--- ${log_file} truncated: showing last ${max_bytes} of ${log_bytes} bytes ---"
  tail -c "$max_bytes" "$log_file"
}

echo "==> Build"
if ! pnpm build >/tmp/openclaw-cleanup-build.log 2>&1; then
  print_log_tail /tmp/openclaw-cleanup-build.log
  exit 1
fi

echo "==> Seed state"
mkdir -p "${OPENCLAW_STATE_DIR}/credentials"
mkdir -p "${OPENCLAW_STATE_DIR}/agents/main/sessions"
echo '{}' >"${OPENCLAW_CONFIG_PATH}"
echo 'creds' >"${OPENCLAW_STATE_DIR}/credentials/marker.txt"
echo 'session' >"${OPENCLAW_STATE_DIR}/agents/main/sessions/sessions.json"

echo "==> Reset (config+creds+sessions)"
if ! pnpm openclaw reset --scope config+creds+sessions --yes --non-interactive >/tmp/openclaw-cleanup-reset.log 2>&1; then
  print_log_tail /tmp/openclaw-cleanup-reset.log
  exit 1
fi

test ! -f "${OPENCLAW_CONFIG_PATH}"
test ! -d "${OPENCLAW_STATE_DIR}/credentials"
test ! -d "${OPENCLAW_STATE_DIR}/agents/main/sessions"

echo "==> Recreate minimal config"
mkdir -p "${OPENCLAW_STATE_DIR}/credentials"
echo '{}' >"${OPENCLAW_CONFIG_PATH}"

echo "==> Uninstall (state only)"
if ! pnpm openclaw uninstall --state --yes --non-interactive >/tmp/openclaw-cleanup-uninstall.log 2>&1; then
  print_log_tail /tmp/openclaw-cleanup-uninstall.log
  exit 1
fi

test ! -d "${OPENCLAW_STATE_DIR}"

echo "OK"
