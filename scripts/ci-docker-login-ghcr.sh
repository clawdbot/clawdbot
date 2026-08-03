#!/usr/bin/env bash
set -euo pipefail

registry="${GHCR_REGISTRY:-ghcr.io}"
username="${GHCR_USERNAME:-${GITHUB_ACTOR:-github-actions[bot]}}"

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "GITHUB_TOKEN is required for GHCR login." >&2
  exit 1
fi

for attempt in 1 2 3 4; do
  if printf '%s' "$GITHUB_TOKEN" | docker login "$registry" --username "$username" --password-stdin; then
    exit 0
  fi
  if [[ "$attempt" -eq 4 ]]; then
    break
  fi
  sleep_seconds=$((attempt * 5))
  echo "GHCR login failed on attempt ${attempt}; retrying in ${sleep_seconds}s." >&2
  sleep "$sleep_seconds"
done

echo "GHCR login failed after 4 attempts." >&2
exit 1
