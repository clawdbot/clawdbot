#!/bin/sh
set -eu

echo "==> Verifying fs-safe native addon..."
node scripts/docker/verify-fs-safe-native.mjs --package-root /app --mode require

# Matrix's downloader can exit successfully after a transient CDN failure.
# Check both fresh installs, including the build target used by live tests.
# Do not hardcode pnpm virtual-store paths: peer hashes can change them.
if grep -qx 'matrix' /tmp/openclaw-selected-plugin-dirs; then
  echo "==> Verifying matrix-sdk-crypto native addon..."
  for attempt in 1 2 3 4 5; do
    if find /app/node_modules -name "matrix-sdk-crypto*.node" 2>/dev/null | grep -q .; then
      exit 0
    fi
    echo "matrix-sdk-crypto native addon missing; retrying download (${attempt}/5)"
    node /app/node_modules/@matrix-org/matrix-sdk-crypto-nodejs/download-lib.js || true
    sleep $((attempt * 2))
  done
  find /app/node_modules -name "matrix-sdk-crypto*.node" 2>/dev/null | grep -q . || {
    echo "ERROR: matrix-sdk-crypto native addon missing after retries" >&2
    exit 1
  }
else
  echo "==> matrix not bundled, skipping matrix-sdk-crypto check"
fi
