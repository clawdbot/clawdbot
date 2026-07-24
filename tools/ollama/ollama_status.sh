#!/usr/bin/env bash
set -euo pipefail

OLLAMA_URL="http://127.0.0.1:11435"
TMP_TAGS="$(mktemp)"

cleanup() {
  rm -f "$TMP_TAGS"
}
trap cleanup EXIT

echo "Ollama URL: $OLLAMA_URL"

if ! curl -fsS --max-time 15 \
  "$OLLAMA_URL/api/tags" \
  -o "$TMP_TAGS"
then
  echo "Status: offline"
  exit 1
fi

model_count="$(jq '.models | length' "$TMP_TAGS")"

echo "Status: online"
echo "Model count: $model_count"
echo "Models:"
jq -r '.models[]? | .name // .model' "$TMP_TAGS"
