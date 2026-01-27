#!/usr/bin/env bash
set -euo pipefail

# Notarize a macOS artifact (zip/dmg/pkg) and optionally staple the app bundle.
#
# Usage:
#   STAPLE_APP_PATH=dist/Moltbot.app scripts/notarize-mac-artifact.sh <artifact>
#
# Auth (pick one):
#   NOTARYTOOL_PROFILE   keychain profile created via `xcrun notarytool store-credentials`
#   NOTARYTOOL_KEY       path to App Store Connect API key (.p8)
#   NOTARYTOOL_KEY_ID    API key ID
#   NOTARYTOOL_ISSUER    API issuer ID

ARTIFACT="${1:-}"
STAPLE_APP_PATH="${STAPLE_APP_PATH:-}"

if [[ -z "$ARTIFACT" ]]; then
  echo "Usage: $0 <artifact>" >&2
  exit 1
fi
if [[ ! -e "$ARTIFACT" ]]; then
  echo "Error: artifact not found: $ARTIFACT" >&2
  exit 1
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "Error: xcrun not found; install Xcode command line tools." >&2
  exit 1
fi

auth_args=()
if [[ -n "${NOTARYTOOL_PROFILE:-}" ]]; then
  auth_args+=(--keychain-profile "$NOTARYTOOL_PROFILE")
elif [[ -n "${NOTARYTOOL_KEY:-}" && -n "${NOTARYTOOL_KEY_ID:-}" && -n "${NOTARYTOOL_ISSUER:-}" ]]; then
  auth_args+=(--key "$NOTARYTOOL_KEY" --key-id "$NOTARYTOOL_KEY_ID" --issuer "$NOTARYTOOL_ISSUER")
else
  echo "Error: Notary auth missing. Set NOTARYTOOL_PROFILE or NOTARYTOOL_KEY/NOTARYTOOL_KEY_ID/NOTARYTOOL_ISSUER." >&2
  exit 1
fi

echo "🧾 Notarizing: $ARTIFACT"
xcrun notarytool submit "$ARTIFACT" "${auth_args[@]}" --wait

case "$ARTIFACT" in
  *.dmg|*.pkg)
    echo "📌 Stapling artifact: $ARTIFACT"
    xcrun stapler staple "$ARTIFACT"
    xcrun stapler validate "$ARTIFACT"
    ;;
  *)
    ;;
esac

if [[ -n "$STAPLE_APP_PATH" ]]; then
  if [[ -d "$STAPLE_APP_PATH" ]]; then
    echo "📌 Stapling app: $STAPLE_APP_PATH"
    xcrun stapler staple "$STAPLE_APP_PATH"
    xcrun stapler validate "$STAPLE_APP_PATH"
  else
    echo "Warn: STAPLE_APP_PATH not found: $STAPLE_APP_PATH" >&2
  fi
fi

echo "✅ Notarization complete"
