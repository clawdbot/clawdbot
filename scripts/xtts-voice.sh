#!/usr/bin/env bash
set -euo pipefail

HOST="${TTS_HOST:-127.0.0.1}"
PORT="${TTS_PORT:-5002}"
SPEAKER="${TTS_SPEAKER:-Claribel Dervla}"
LANG="${TTS_LANG:-en}"
WAV_OUT="${TTS_WAV_OUT:-./tts.wav}"
OGG_OUT="${TTS_OGG_OUT:-./tts.ogg}"

if [ "$#" -eq 0 ]; then
  echo "usage: TTS_HOST=<host> TTS_PORT=<port> $0 \"text to speak\""
  exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ffmpeg is required (brew install ffmpeg)."
  exit 1
fi

TEXT="$*"

curl -sS -X POST "http://${HOST}:${PORT}/api/tts" \
  --data-urlencode "text=${TEXT}" \
  --data-urlencode "speaker_id=${SPEAKER}" \
  --data-urlencode "language_id=${LANG}" \
  -o "${WAV_OUT}"

ffmpeg -y -hide_banner -loglevel error \
  -i "${WAV_OUT}" \
  -c:a libopus -b:a 64k -vbr on -compression_level 10 -application voip \
  "${OGG_OUT}"

echo "wrote ${OGG_OUT}"
