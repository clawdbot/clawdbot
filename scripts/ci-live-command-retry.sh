#!/usr/bin/env bash
set -euo pipefail

command="${OPENCLAW_LIVE_COMMAND:-}"
if [[ -z "$command" && "$#" -gt 0 ]]; then
  command="$*"
fi

if [[ -z "$command" ]]; then
  echo "Usage: OPENCLAW_LIVE_COMMAND='<command>' $0" >&2
  exit 64
fi

attempts="${OPENCLAW_LIVE_COMMAND_ATTEMPTS:-2}"
delay_seconds="${OPENCLAW_LIVE_COMMAND_RETRY_DELAY_SECONDS:-10}"
retry_pattern="${OPENCLAW_LIVE_COMMAND_RETRY_PATTERN:-ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|TLS connection|socket hang up|UND_ERR|gateway request timeout|model idle timeout|did not produce a response before the model idle timeout|\\b429\\b|\\b529\\b}"

if ! [[ "$attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "OPENCLAW_LIVE_COMMAND_ATTEMPTS must be a positive integer, got: $attempts" >&2
  exit 64
fi

if ! [[ "$delay_seconds" =~ ^[0-9]+$ ]]; then
  echo "OPENCLAW_LIVE_COMMAND_RETRY_DELAY_SECONDS must be a non-negative integer, got: $delay_seconds" >&2
  exit 64
fi

log_file="$(mktemp)"
cleanup() {
  rm -f "$log_file"
}
trap cleanup EXIT

for attempt in $(seq 1 "$attempts"); do
  : >"$log_file"
  set +e
  bash -o pipefail -c "$command" 2>&1 | tee "$log_file"
  status="${PIPESTATUS[0]}"
  set -e

  if [[ "$status" -eq 0 ]]; then
    exit 0
  fi

  if [[ "$attempt" -ge "$attempts" ]]; then
    exit "$status"
  fi

  if ! grep -Eiq "$retry_pattern" "$log_file"; then
    exit "$status"
  fi

  echo "Live command failed with a retryable provider/network error; retrying ($attempt/$attempts)..." >&2
  if [[ "$delay_seconds" -gt 0 ]]; then
    sleep "$delay_seconds"
  fi
done
