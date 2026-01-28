#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ZIP=${1:?"Usage: $0 Moltbot-<ver>.zip"}
FEED_URL=${2:-"https://raw.githubusercontent.com/moltbot/moltbot/main/appcast.xml"}
PRIVATE_KEY_FILE=${SPARKLE_PRIVATE_KEY_FILE:-}
if [[ -z "$PRIVATE_KEY_FILE" ]]; then
  echo "Set SPARKLE_PRIVATE_KEY_FILE to your ed25519 private key (Sparkle)." >&2
  exit 1
fi
if [[ ! -f "$ZIP" ]]; then
  echo "Zip not found: $ZIP" >&2
  exit 1
fi

ZIP_DIR=$(cd "$(dirname "$ZIP")" && pwd)
ZIP_NAME=$(basename "$ZIP")
ZIP_BASE="${ZIP_NAME%.zip}"
VERSION=${SPARKLE_RELEASE_VERSION:-}
if [[ -z "$VERSION" ]]; then
  if [[ "$ZIP_NAME" =~ ^Moltbot-([0-9]+(\.[0-9]+){1,2}([-.][^.]*)?)\.zip$ ]]; then
    VERSION="${BASH_REMATCH[1]}"
  else
    echo "Could not infer version from $ZIP_NAME; set SPARKLE_RELEASE_VERSION." >&2
    exit 1
  fi
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
  if [[ "${KEEP_SPARKLE_NOTES:-0}" != "1" ]]; then
    rm -f "$NOTES_HTML"
  fi
}
trap cleanup EXIT
cp -f "$ZIP" "$TMP_DIR/$ZIP_NAME"
if [[ -f "$ROOT/appcast.xml" ]]; then
  cp -f "$ROOT/appcast.xml" "$TMP_DIR/appcast.xml"
fi

NOTES_HTML="${ZIP_DIR}/${ZIP_BASE}.html"
if [[ -x "$ROOT/scripts/changelog-to-html.sh" ]]; then
  "$ROOT/scripts/changelog-to-html.sh" "$VERSION" >"$NOTES_HTML"
else
  echo "Missing scripts/changelog-to-html.sh; cannot generate HTML release notes." >&2
  exit 1
fi
cp -f "$NOTES_HTML" "$TMP_DIR/${ZIP_BASE}.html"

DOWNLOAD_URL_PREFIX=${SPARKLE_DOWNLOAD_URL_PREFIX:-"https://github.com/moltbot/moltbot/releases/download/v${VERSION}/"}

export PATH="$ROOT/apps/macos/.build/artifacts/sparkle/Sparkle/bin:$PATH"
if ! command -v generate_appcast >/dev/null; then
  echo "generate_appcast not found in PATH. Build Sparkle tools via SwiftPM." >&2
  exit 1
fi

generate_appcast \
  --ed-key-file "$PRIVATE_KEY_FILE" \
  --download-url-prefix "$DOWNLOAD_URL_PREFIX" \
  --embed-release-notes \
  --link "$FEED_URL" \
  "$TMP_DIR"

cp -f "$TMP_DIR/appcast.xml" "$ROOT/appcast.xml"

echo "Appcast generated (appcast.xml). Upload alongside $ZIP at $FEED_URL"
