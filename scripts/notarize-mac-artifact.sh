#!/usr/bin/env bash
set -euo pipefail

# Notarize a macOS artifact (zip/dmg/pkg) and optionally staple the app bundle.
#
# Usage:
#   STAPLE_APP_PATH=dist/OpenClaw.app scripts/notarize-mac-artifact.sh <artifact>
#
# Auth (pick one):
#   NOTARYTOOL_PROFILE   keychain profile created via `xcrun notarytool store-credentials`
#   NOTARYTOOL_KEY       path to App Store Connect API key (.p8)
#   NOTARYTOOL_KEY_ID    API key ID
#   NOTARYTOOL_ISSUER    API issuer ID
#   NOTARY_RESULT_FILE   optional mode-0600 JSON result path

ARTIFACT=""
STAPLE_APP_PATH="${STAPLE_APP_PATH:-}"
NOTARY_RESULT_FILE="${NOTARY_RESULT_FILE:-}"

usage() {
  cat <<'HELP'
Usage: scripts/notarize-mac-artifact.sh <artifact>

Env:
  STAPLE_APP_PATH=dist/OpenClaw.app
  NOTARYTOOL_PROFILE=<keychain-profile>
  NOTARYTOOL_KEY=<api-key.p8>
  NOTARYTOOL_KEY_ID=<api-key-id>
  NOTARYTOOL_ISSUER=<issuer-id>
  NOTARY_RESULT_FILE=<accepted-result.json>
HELP
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi
if [[ "${1:-}" == "--" ]]; then
  shift
fi
if [[ "$#" -gt 0 ]]; then
  case "$1" in
    -*) echo "Error: unknown notarization option: $1" >&2; exit 1 ;;
    *) ARTIFACT="$1"; shift ;;
  esac
fi
if [[ "$#" -gt 0 ]]; then
  echo "Error: unexpected notarization argument: $1" >&2
  exit 1
fi

if [[ -z "$ARTIFACT" ]]; then
  usage >&2
  exit 1
fi
if [[ ! -e "$ARTIFACT" ]]; then
  echo "Error: artifact not found: $ARTIFACT" >&2
  exit 1
fi
if [[ -n "$STAPLE_APP_PATH" && ! -d "$STAPLE_APP_PATH" ]]; then
  echo "Error: STAPLE_APP_PATH not found: $STAPLE_APP_PATH" >&2
  exit 1
fi

if ! command -v xcrun >/dev/null 2>&1; then
  echo "Error: xcrun not found; install Xcode command line tools." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "Error: jq not found; install jq to validate notarization results." >&2
  exit 1
fi
if [[ -n "$NOTARY_RESULT_FILE" && ! -d "$(dirname "$NOTARY_RESULT_FILE")" ]]; then
  echo "Error: NOTARY_RESULT_FILE parent directory not found: $(dirname "$NOTARY_RESULT_FILE")" >&2
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
notary_result="$(
  xcrun notarytool submit "$ARTIFACT" "${auth_args[@]}" \
    --wait --no-s3-acceleration --output-format json
)"
printf '%s\n' "$notary_result"
notary_status="$(jq -r '.status // empty' <<<"$notary_result")"
notary_id="$(jq -r '.id // empty' <<<"$notary_result")"
if [[ "$notary_status" != "Accepted" || -z "$notary_id" ]]; then
  echo "Error: notarization did not return an accepted result with an id." >&2
  exit 1
fi
if [[ -n "$NOTARY_RESULT_FILE" ]]; then
  notary_result_tmp="${NOTARY_RESULT_FILE}.tmp.$$"
  umask 077
  printf '%s\n' "$notary_result" >"$notary_result_tmp"
  chmod 600 "$notary_result_tmp"
  mv "$notary_result_tmp" "$NOTARY_RESULT_FILE"
fi

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
  echo "📌 Stapling app: $STAPLE_APP_PATH"
  xcrun stapler staple "$STAPLE_APP_PATH"
  xcrun stapler validate "$STAPLE_APP_PATH"
fi

echo "✅ Notarization complete"
