#!/usr/bin/env bash
set -euo pipefail
lease_file="$LEASE_FILE"
lease_lost_marker="$LEASE_LOST_MARKER"
[[ -n "$lease_file" && -f "$lease_file" ]] || exit 0
if [[ -n "$lease_lost_marker" && -f "$lease_lost_marker" ]]; then
  echo "Lease was already lost; no release is required."
  exit 0
fi
node --import tsx scripts/e2e/telegram-user-credential.ts release \
  --lease-file "$lease_file"
