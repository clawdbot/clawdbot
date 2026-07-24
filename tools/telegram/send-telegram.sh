#!/usr/bin/env bash
set -euo pipefail

source ~/.openclaw/credentials/telegram.env

MESSAGE="${*:-OpenClaw Telegram test message}"

curl -s \
  -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d chat_id="${TELEGRAM_CHAT_ID}" \
  -d text="${MESSAGE}" \
  | python3 -m json.tool
