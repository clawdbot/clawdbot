#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 1 || -z "${1// }" ]]; then
  echo "usage: $0 <image>" >&2
  exit 2
fi

image="$1"
attempts="${OPENCLAW_DOCKER_PULL_ATTEMPTS:-3}"
timeout_seconds="${OPENCLAW_DOCKER_PULL_TIMEOUT_SECONDS:-180}"
retry_delay_seconds="${OPENCLAW_DOCKER_PULL_RETRY_DELAY_SECONDS:-5}"

if ! [[ "$attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "OPENCLAW_DOCKER_PULL_ATTEMPTS must be a positive integer, got: $attempts" >&2
  exit 2
fi

if ! [[ "$timeout_seconds" =~ ^[1-9][0-9]*$ ]]; then
  echo "OPENCLAW_DOCKER_PULL_TIMEOUT_SECONDS must be a positive integer, got: $timeout_seconds" >&2
  exit 2
fi

if ! [[ "$retry_delay_seconds" =~ ^[0-9]+$ ]]; then
  echo "OPENCLAW_DOCKER_PULL_RETRY_DELAY_SECONDS must be a non-negative integer, got: $retry_delay_seconds" >&2
  exit 2
fi

last_status=1
for attempt in $(seq 1 "$attempts"); do
  echo "==> Pull Docker image attempt ${attempt}/${attempts}: ${image}"
  if timeout --foreground --kill-after=30s "${timeout_seconds}s" docker pull "$image"; then
    exit 0
  fi
  last_status="$?"
  echo "Docker pull failed or timed out after ${timeout_seconds}s: status=${last_status}" >&2
  if [[ "$attempt" -lt "$attempts" && "$retry_delay_seconds" -gt 0 ]]; then
    sleep "$retry_delay_seconds"
  fi
done

exit "$last_status"
