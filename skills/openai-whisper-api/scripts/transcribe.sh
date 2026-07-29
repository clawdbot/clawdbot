#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage:
  transcribe.sh <audio-file> [--model gpt-4o-transcribe] [--out /path/to/out.txt] [--language en] [--prompt "hint"] [--json]
EOF
  exit 2
}

if [[ "${1:-}" == "" || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
fi

in="${1:-}"
shift || true

model="gpt-4o-transcribe"
out=""
language=""
prompt=""
json_output=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)
      model="${2:-}"
      shift 2
      ;;
    --out)
      out="${2:-}"
      shift 2
      ;;
    --language)
      language="${2:-}"
      shift 2
      ;;
    --prompt)
      prompt="${2:-}"
      shift 2
      ;;
    --json)
      json_output=1
      shift 1
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      ;;
  esac
done

if [[ ! -f "$in" ]]; then
  echo "File not found: $in" >&2
  exit 1
fi

if [[ "${OPENAI_API_KEY:-}" == "" ]]; then
  echo "Missing OPENAI_API_KEY" >&2
  exit 1
fi

if [[ "$out" == "" ]]; then
  base="${in%.*}"
  if [[ "$json_output" == "1" ]]; then
    out="${base}.json"
  else
    out="${base}.txt"
  fi
fi

mkdir -p "$(dirname "$out")"

api_base="${OPENAI_BASE_URL:-https://api.openai.com/v1}"
api_base="${api_base%/}"

request_format="text"
if [[ "$json_output" == "1" ]]; then
  request_format="json"
fi

diarize=0
case "$model" in
  gpt-4o-transcribe | gpt-4o-mini-transcribe | gpt-4o-mini-transcribe-*)
    request_format="json"
    ;;
  gpt-4o-transcribe-diarize)
    diarize=1
    request_format="diarized_json"
    ;;
esac

if [[ "$diarize" == "1" && "$prompt" != "" ]]; then
  echo "--prompt is not supported with gpt-4o-transcribe-diarize" >&2
  exit 2
fi

target="$out"
tmp=""
if [[ "$json_output" == "0" && ( "$request_format" == "json" || "$request_format" == "diarized_json" ) ]]; then
  tmp="$(mktemp)"
  trap '[[ "$tmp" == "" ]] || rm -f "$tmp"' EXIT
  target="$tmp"
fi

curl_args=(
  -sS "${api_base}/audio/transcriptions"
  -H "Authorization: Bearer $OPENAI_API_KEY"
  -H "Accept: application/json"
  -F "file=@${in}"
  -F "model=${model}"
  -F "response_format=${request_format}"
)
if [[ "$language" != "" ]]; then
  curl_args+=(-F "language=${language}")
fi
if [[ "$prompt" != "" ]]; then
  curl_args+=(-F "prompt=${prompt}")
fi
if [[ "$diarize" == "1" ]]; then
  curl_args+=(-F "chunking_strategy=auto")
fi

curl "${curl_args[@]}" >"$target"

if [[ "$target" != "$out" ]]; then
  node -e '
const fs = require("fs");
const input = process.argv[1];
const output = process.argv[2];
const payload = JSON.parse(fs.readFileSync(input, "utf8"));
if (Array.isArray(payload.segments)) {
  const lines = payload.segments
    .map((segment) => {
      const text = typeof segment?.text === "string" ? segment.text.trim() : "";
      if (!text) return "";
      const speaker = typeof segment?.speaker === "string" ? segment.speaker.trim() : "";
      return speaker ? `${speaker}: ${text}` : text;
    })
    .filter(Boolean);
  if (lines.length > 0) {
    fs.writeFileSync(output, lines.join("\n"));
    process.exit(0);
  }
}
if (typeof payload.text !== "string") {
  throw new Error("Transcription response missing text");
}
fs.writeFileSync(output, payload.text);
' "$target" "$out"
fi

echo "$out"
