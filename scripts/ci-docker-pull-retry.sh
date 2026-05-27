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
run_docker_pull() {
  if ! command -v timeout >/dev/null 2>&1; then
    echo "timeout command not found; cannot bound Docker pull after ${timeout_seconds}s" >&2
    return 127
  fi
  if timeout --kill-after=1s 1s true >/dev/null 2>&1; then
    timeout --kill-after=30s "${timeout_seconds}s" docker pull "$image"
  else
    timeout "${timeout_seconds}s" docker pull "$image"
  fi
}

for ((attempt = 1; attempt <= attempts; attempt++)); do
  echo "==> Pull Docker image attempt ${attempt}/${attempts}: ${image}"
  if run_docker_pull; then
    exit 0
  else
    last_status="$?"
  fi
  echo "Docker pull failed or timed out after ${timeout_seconds}s: status=${last_status}" >&2
  if [[ "$attempt" -lt "$attempts" && "$retry_delay_seconds" -gt 0 ]]; then
    sleep "$retry_delay_seconds"
  fi
done

exit "$last_status"
