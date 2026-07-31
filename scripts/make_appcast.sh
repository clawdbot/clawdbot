#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
ZIP=${1:?"Usage: $0 OpenClaw-<ver>.zip"}
FEED_URL=${2:-"https://raw.githubusercontent.com/openclaw/openclaw/main/appcast.xml"}
PRIVATE_KEY_FILE=${SPARKLE_PRIVATE_KEY_FILE:-}

find_generate_appcast() {
  if [[ -n "${SPARKLE_GENERATE_APPCAST:-}" ]]; then
    if [[ ! -x "$SPARKLE_GENERATE_APPCAST" ]]; then
      echo "SPARKLE_GENERATE_APPCAST is not executable: $SPARKLE_GENERATE_APPCAST" >&2
      return 1
    fi
    printf '%s\n' "$SPARKLE_GENERATE_APPCAST"
    return 0
  fi

  local host_arch bundled_root bundled_tool
  host_arch="$(uname -m)"
  bundled_root="$ROOT/apps/macos/.build/$host_arch"
  if [[ -d "$bundled_root" ]]; then
    bundled_tool="$(find "$bundled_root" -type f -path "*/artifacts/sparkle/Sparkle/bin/generate_appcast" -print -quit)"
    if [[ -n "$bundled_tool" ]]; then
      printf '%s\n' "$bundled_tool"
      return 0
    fi
  fi

  if command -v generate_appcast >/dev/null 2>&1; then
    command -v generate_appcast
    return 0
  fi

  if [[ -d "$ROOT/apps/macos/.build" ]]; then
    find "$ROOT/apps/macos/.build" -type f -path "*/artifacts/sparkle/Sparkle/bin/generate_appcast" -print -quit
  fi
  return 0
}

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
  # Accept legacy calver suffixes like -1 and prerelease forms like -alpha.1 / -beta.1 / .beta.1.
  if [[ "$ZIP_NAME" =~ ^OpenClaw-([0-9]+(\.[0-9]+){1,2}([-.][0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?)\.zip$ ]]; then
    VERSION="${BASH_REMATCH[1]}"
  else
    echo "Could not infer version from $ZIP_NAME; set SPARKLE_RELEASE_VERSION." >&2
    exit 1
  fi
fi

CHANNEL_ARGS=()
if [[ "$VERSION" == *-alpha.* || "$VERSION" == *.alpha.* ]]; then
  echo "Alpha releases do not ship via Sparkle: $VERSION" >&2
  exit 1
fi
if [[ "$VERSION" == *-beta.* || "$VERSION" == *.beta.* ]]; then
  CHANNEL_ARGS=(--channel beta)
fi

TMP_DIR="$(mktemp -d)"
NOTES_HTML=""
cleanup() {
  rm -rf "$TMP_DIR"
  if [[ -n "$NOTES_HTML" && "${KEEP_SPARKLE_NOTES:-0}" != "1" ]]; then
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

DOWNLOAD_URL_PREFIX=${SPARKLE_DOWNLOAD_URL_PREFIX:-"https://github.com/openclaw/openclaw/releases/download/v${VERSION}/"}

GENERATE_APPCAST="$(find_generate_appcast)"
if [[ -z "$GENERATE_APPCAST" ]]; then
  echo "generate_appcast not found. Install Sparkle tooling or build the mac app first so SwiftPM emits the Sparkle binaries." >&2
  exit 1
fi

"$GENERATE_APPCAST" \
  --ed-key-file "$PRIVATE_KEY_FILE" \
  --download-url-prefix "$DOWNLOAD_URL_PREFIX" \
  --embed-release-notes \
  --link "$FEED_URL" \
  "${CHANNEL_ARGS[@]}" \
  "$TMP_DIR"

APPCAST_PATH="$TMP_DIR/appcast.xml" APPCAST_VERSION="$VERSION" node <<'NODE'
const { readFileSync } = require("node:fs");

const appcastPath = process.env.APPCAST_PATH;
const version = process.env.APPCAST_VERSION;
const appcast = readFileSync(appcastPath, "utf8");
const item = [...appcast.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gu)].find((match) =>
  match[1]?.includes(`<sparkle:shortVersionString>${version}</sparkle:shortVersionString>`),
);
if (!item) {
  throw new Error(`Generated appcast is missing release ${version}.`);
}
if (!/sparkle:edSignature="[^"]+"/u.test(item[1] ?? "")) {
  throw new Error(`Generated appcast release ${version} is missing sparkle:edSignature.`);
}
NODE

cp -f "$TMP_DIR/appcast.xml" "$ROOT/appcast.xml"

echo "Appcast generated (appcast.xml). Upload alongside $ZIP at $FEED_URL"
