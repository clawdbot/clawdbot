#!/usr/bin/env bash
set -euo pipefail

HOST="${TTS_HOST:-127.0.0.1}"
PORT="${TTS_PORT:-5002}"
SPEAKER="${TTS_SPEAKER:-Claribel Dervla}"
LANG="${TTS_LANG:-en}"
OUT="${TTS_OUT:-./tts.wav}"

if [ "$#" -eq 0 ]; then
  echo "usage: TTS_HOST=<host> TTS_PORT=<port> $0 \"text to speak\""
  exit 1
fi

TEXT="$*"

curl -sS -X POST "http://${HOST}:${PORT}/api/tts" \
  --data-urlencode "text=${TEXT}" \
  --data-urlencode "speaker_id=${SPEAKER}" \
  --data-urlencode "language_id=${LANG}" \
  -o "${OUT}"

echo "wrote ${OUT}"
