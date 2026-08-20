#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ARTIFACT_MANIFEST="$ROOT_DIR/extensions/cua-computer/package.json"
VERSION="$(node -e 'const manifest = require(process.argv[1]); process.stdout.write(manifest.dependencies["@trycua/cua-driver"]);' "$ARTIFACT_MANIFEST")"
TAG="cua-driver-rs-v${VERSION}"
ASSET="cua-driver-rs-${VERSION}-darwin-universal-binary.tar.gz"
EXPECTED_SHA256="$(node -e 'const manifest = require(process.argv[1]); process.stdout.write(manifest.cuaDriverArtifacts["darwin-universal-binary"].archiveSha256);' "$ARTIFACT_MANIFEST")"
DOWNLOAD_URL="https://github.com/trycua/cua/releases/download/${TAG}/${ASSET}"
CACHE_DIR="$ROOT_DIR/apps/macos/.build/cua-driver/${TAG}"
ARCHIVE="$CACHE_DIR/$ASSET"
DESTINATION="${1:-}"

if [[ -z "$DESTINATION" || "$DESTINATION" == -* ]]; then
  echo "Usage: scripts/stage-cua-driver-macos.sh <destination>" >&2
  exit 2
fi

verify_archive() {
  [[ -f "$ARCHIVE" ]] || return 1
  local actual
  actual="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
  [[ "$actual" == "$EXPECTED_SHA256" ]]
}

mkdir -p "$CACHE_DIR"
if ! verify_archive; then
  rm -f "$ARCHIVE"
  partial="$ARCHIVE.partial.$$"
  trap 'rm -f "$partial"' EXIT
  curl --fail --location --retry 3 --retry-delay 2 --output "$partial" "$DOWNLOAD_URL"
  actual="$(shasum -a 256 "$partial" | awk '{print $1}')"
  if [[ "$actual" != "$EXPECTED_SHA256" ]]; then
    echo "ERROR: CUA driver archive sha256 mismatch: got $actual" >&2
    exit 1
  fi
  mv "$partial" "$ARCHIVE"
  trap - EXIT
fi

extract_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-cua-driver.XXXXXX")"
trap 'rm -rf "$extract_dir"' EXIT
tar -xzf "$ARCHIVE" -C "$extract_dir" cua-driver
source_binary="$extract_dir/cua-driver"
if [[ ! -f "$source_binary" || -L "$source_binary" ]]; then
  echo "ERROR: CUA driver archive did not contain a regular cua-driver executable" >&2
  exit 1
fi

archs="$(/usr/bin/lipo -archs "$source_binary")"
if [[ " $archs " != *" arm64 "* || " $archs " != *" x86_64 "* ]]; then
  echo "ERROR: CUA driver is not universal (architectures: $archs)" >&2
  exit 1
fi

mkdir -p "$(dirname "$DESTINATION")"
cp "$source_binary" "$DESTINATION"
chmod 0755 "$DESTINATION"
echo "Staged cua-driver $VERSION at $DESTINATION"
