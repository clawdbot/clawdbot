#!/usr/bin/env bash
set -euo pipefail

URL="http://127.0.0.1:11435/api/generate"
MODEL="gpt-oss:20b"
TMP_RESPONSE="$(mktemp)"

cleanup() {
  rm -f "$TMP_RESPONSE"
}
trap cleanup EXIT

START="$(date +%s%3N)"

http_code="$(
  curl -sS \
    --max-time 180 \
    -o "$TMP_RESPONSE" \
    -w '%{http_code}' \
    "$URL" \
    -H "Content-Type: application/json" \
    -d "$(jq -n \
      --arg model "$MODEL" \
      --arg prompt "Reply with exactly: benchmark ok" \
      '{model:$model, prompt:$prompt, stream:false}')"
)"

END="$(date +%s%3N)"
ELAPSED="$((END - START))"

echo "Model: $MODEL"
echo "Latency_ms: $ELAPSED"

if [[ "$http_code" != "200" ]]; then
  echo "Status: error"
  echo "HTTP_status: $http_code"
  echo "Error: $(jq -r '.error // "unknown Ollama error"' "$TMP_RESPONSE" 2>/dev/null)"
  exit 1
fi

text="$(jq -r '.response // empty' "$TMP_RESPONSE")"

if [[ -z "$text" || "$text" == "null" ]]; then
  echo "Status: error"
  echo "Response: empty"
  exit 1
fi

echo "Status: healthy"
echo "Response: $text"
