#!/usr/bin/env bash
set -euo pipefail

cd /repo

export CLAWDBOT_STATE_DIR="/tmp/moltbot-test"
export CLAWDBOT_CONFIG_PATH="${CLAWDBOT_STATE_DIR}/moltbot.json"

echo "==> Seed state"
mkdir -p "${CLAWDBOT_STATE_DIR}/credentials"
mkdir -p "${CLAWDBOT_STATE_DIR}/agents/main/sessions"
echo '{}' >"${CLAWDBOT_CONFIG_PATH}"
echo 'creds' >"${CLAWDBOT_STATE_DIR}/credentials/marker.txt"
echo 'session' >"${CLAWDBOT_STATE_DIR}/agents/main/sessions/sessions.json"

echo "==> Reset (config+creds+sessions)"
pnpm moltbot reset --scope config+creds+sessions --yes --non-interactive

test ! -f "${CLAWDBOT_CONFIG_PATH}"
test ! -d "${CLAWDBOT_STATE_DIR}/credentials"
test ! -d "${CLAWDBOT_STATE_DIR}/agents/main/sessions"

echo "==> Recreate minimal config"
mkdir -p "${CLAWDBOT_STATE_DIR}/credentials"
echo '{}' >"${CLAWDBOT_CONFIG_PATH}"

echo "==> Uninstall (state only)"
pnpm moltbot uninstall --state --yes --non-interactive

test ! -d "${CLAWDBOT_STATE_DIR}"

echo "OK"
