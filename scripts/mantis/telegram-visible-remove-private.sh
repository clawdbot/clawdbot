#!/usr/bin/env bash
set -euo pipefail
for root in \
  "$SESSION_ROOT" \
  "$SUT_CREDENTIAL_DIR" \
  "$CREDENTIAL_DIR"; do
  [[ -n "$root" ]] || continue
  [[ "$root" == /tmp/openclaw-mantis-*-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT} ]]
  sudo rm -rf --one-file-system "$root"
done
