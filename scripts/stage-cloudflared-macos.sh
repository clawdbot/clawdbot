#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT_DIR/scripts/lib/cloudflared-macos.json"
ARCH="${1:-}"
DESTINATION="${2:-}"
if [[ "$#" != 2 || ( "$ARCH" != arm64 && "$ARCH" != x86_64 ) || -z "$DESTINATION" || "$DESTINATION" == -* ]]; then
  echo "Usage: scripts/stage-cloudflared-macos.sh <arm64|x86_64> <resource-directory>" >&2
  exit 2
fi
read -r VERSION ASSET ARCHIVE_SHA LICENSE_SHA < <(node - "$MANIFEST" "$ARCH" <<'JS'
const manifest = require(process.argv[2]);
const artifact = manifest.artifacts[process.argv[3]];
console.log(manifest.version, artifact.asset, artifact.sha256, manifest.licenseSha256);
JS
)
CACHE_DIR="$ROOT_DIR/apps/macos/.build/cloudflared/$VERSION"
mkdir -p "$CACHE_DIR"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-cloudflared.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

verified_download() {
  local name="$1" expected="$2" url="$3" actual
  if [[ -f "$CACHE_DIR/$name" && ! -L "$CACHE_DIR/$name" ]]; then
    actual="$(shasum -a 256 "$CACHE_DIR/$name" | awk '{print $1}')"
    [[ "$actual" != "$expected" ]] || return 0
  fi
  curl --fail --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 15 --max-time 180 --retry 3 --retry-delay 2 \
    --output "$WORK/$name" "$url"
  actual="$(shasum -a 256 "$WORK/$name" | awk '{print $1}')"
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: cloudflared $name sha256 mismatch" >&2
    return 1
  fi
  mv -f "$WORK/$name" "$CACHE_DIR/$name"
}

verified_download "$ASSET" "$ARCHIVE_SHA" \
  "https://github.com/cloudflare/cloudflared/releases/download/$VERSION/$ASSET"
verified_download LICENSE "$LICENSE_SHA" \
  "https://raw.githubusercontent.com/cloudflare/cloudflared/$VERSION/LICENSE"
# Select only the published executable; never extract arbitrary archive paths.
tar -xzf "$CACHE_DIR/$ASSET" -C "$WORK" cloudflared
if [[ ! -f "$WORK/cloudflared" || -L "$WORK/cloudflared" || "$(/usr/bin/lipo -archs "$WORK/cloudflared")" != "$ARCH" ]]; then
  echo "ERROR: cloudflared archive did not contain the expected $ARCH executable" >&2
  exit 1
fi
mkdir -p "$DESTINATION/$ARCH"
cp "$WORK/cloudflared" "$DESTINATION/$ARCH/cloudflared"
chmod 0755 "$DESTINATION/$ARCH/cloudflared"
cp "$MANIFEST" "$DESTINATION/manifest.json"
cp "$CACHE_DIR/LICENSE" "$DESTINATION/LICENSE"
echo "Staged cloudflared $VERSION ($ARCH)"
