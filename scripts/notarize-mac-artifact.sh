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
SUBMISSION_FILE=""
STAPLE_APP_PATH="${STAPLE_APP_PATH:-}"
NOTARY_RESULT_FILE="${NOTARY_RESULT_FILE:-}"

usage() {
  cat <<'HELP'
Usage: scripts/notarize-mac-artifact.sh <artifact> [--submission-file <checkpoint.json>]

Options:
  --submission-file <path>  Save and resume the Apple submission for these exact artifact bytes.

Env:
  STAPLE_APP_PATH=dist/OpenClaw.app
  NOTARYTOOL_PROFILE=<keychain-profile>
  NOTARYTOOL_KEY=<api-key.p8>
  NOTARYTOOL_KEY_ID=<api-key-id>
  NOTARYTOOL_ISSUER=<issuer-id>
  NOTARY_RESULT_FILE=<accepted-result.json>
HELP
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --submission-file)
      [[ "$#" -ge 2 && -n "$2" && "$2" != -* && -z "$SUBMISSION_FILE" ]] || {
        echo "Error: --submission-file requires one checkpoint path." >&2; exit 1;
      }
      SUBMISSION_FILE="$2"; shift 2 ;;
    --) shift; break ;;
    -*) echo "Error: unknown notarization option: $1" >&2; exit 1 ;;
    *)
      [[ -z "$ARTIFACT" ]] || { echo "Error: unexpected notarization argument: $1" >&2; exit 1; }
      ARTIFACT="$1"; shift ;;
  esac
done
if [[ "$#" -gt 0 ]]; then
  [[ "$#" -eq 1 && -z "$ARTIFACT" ]] || { echo "Error: unexpected notarization argument: $1" >&2; exit 1; }
  ARTIFACT="$1"
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

notary_json_tmp=""
staple_dir=""
cleanup() {
  [[ -z "$notary_json_tmp" ]] || rm -f "$notary_json_tmp"
  [[ -z "$staple_dir" ]] || rm -rf "$staple_dir"
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

write_json() {
  local destination="$1" value="$2"
  notary_json_tmp="$(mktemp "${destination}.tmp.XXXXXX")"
  chmod 600 "$notary_json_tmp"
  printf '%s\n' "$value" >"$notary_json_tmp"
  mv "$notary_json_tmp" "$destination"
  notary_json_tmp=""
}

checkpoint=""
artifact_sha=""
if [[ -n "$SUBMISSION_FILE" ]]; then
  [[ -d "$(dirname "$SUBMISSION_FILE")" && ! -L "$SUBMISSION_FILE" ]] || {
    echo "Error: invalid notarization checkpoint path: $SUBMISSION_FILE" >&2; exit 1;
  }
  canonical_submission="$(cd "$(dirname "$SUBMISSION_FILE")" && pwd -P)/$(basename "$SUBMISSION_FILE")"
  canonical_artifact="$(cd "$(dirname "$ARTIFACT")" && pwd -P)/$(basename "$ARTIFACT")"
  [[ "$canonical_submission" != "$canonical_artifact" ]] || {
    echo "Error: notarization checkpoint must be separate from the artifact." >&2; exit 1;
  }
  if [[ -n "$NOTARY_RESULT_FILE" ]]; then
    canonical_result="$(cd "$(dirname "$NOTARY_RESULT_FILE")" && pwd -P)/$(basename "$NOTARY_RESULT_FILE")"
    [[ "$canonical_submission" != "$canonical_result" ]] || {
      echo "Error: notarization checkpoint must be separate from NOTARY_RESULT_FILE." >&2; exit 1;
    }
  fi
  artifact_sha="$(shasum -a 256 "$ARTIFACT" | awk '{print $1}')"
  if [[ -e "$SUBMISSION_FILE" ]]; then
    checkpoint="$(cat "$SUBMISSION_FILE")"
    if ! jq -e --arg name "$(basename "$ARTIFACT")" --arg sha "$artifact_sha" '
      def digest: type == "string" and test("^[0-9a-f]{64}$");
      type == "object" and .version == 1 and .artifactName == $name and
      (.artifactSha256 | digest) and
      (.submissionId | type == "string" and test("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")) and
      ((has("result") | not) or (.result.id == .submissionId and
        (.result.status == "Accepted" or .result.status == "Invalid" or .result.status == "Rejected"))) and
      ((has("stapledSha256") | not) or (.result.status == "Accepted" and (.stapledSha256 | digest))) and
      (.artifactSha256 == $sha or .stapledSha256 == $sha)
    ' <<<"$checkpoint" >/dev/null 2>&1; then
      echo "Error: notarization checkpoint is corrupt or belongs to different artifact bytes: $SUBMISSION_FILE" >&2
      exit 1
    fi
  fi
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
if [[ -z "$SUBMISSION_FILE" ]]; then
  notary_result="$(xcrun notarytool submit "$ARTIFACT" "${auth_args[@]}" \
    --wait --no-s3-acceleration --output-format json)"
else
  if [[ -z "$checkpoint" ]]; then
    submission_exit=0
    submission_result="$(xcrun notarytool submit "$ARTIFACT" "${auth_args[@]}" \
      --no-wait --no-s3-acceleration --output-format json)" || submission_exit=$?
    notary_id="$(jq -er '.id | select(type == "string" and test("^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$"))' <<<"$submission_result")"
    checkpoint="$(jq -n --arg name "$(basename "$ARTIFACT")" --arg sha "$artifact_sha" --arg id "$notary_id" \
      '{version: 1, artifactName: $name, artifactSha256: $sha, submissionId: $id}')"
    # Persist before waiting: a transport failure must never create a second submission.
    write_json "$SUBMISSION_FILE" "$checkpoint"
    [[ "$submission_exit" -eq 0 ]] || exit "$submission_exit"
  fi
  notary_id="$(jq -r .submissionId <<<"$checkpoint")"
  notary_result="$(jq -c '.result // empty' <<<"$checkpoint")"
  if [[ -z "$notary_result" ]]; then
    wait_exit=0
    notary_result="$(xcrun notarytool wait "$notary_id" "${auth_args[@]}" --output-format json)" || wait_exit=$?
    jq -e --arg id "$notary_id" '.id == $id and (.status == "Accepted" or .status == "Invalid" or .status == "Rejected")' \
      <<<"$notary_result" >/dev/null || { echo "Error: unexpected notarization wait result." >&2; exit 1; }
    checkpoint="$(jq --argjson result "$notary_result" '.result = $result' <<<"$checkpoint")"
    write_json "$SUBMISSION_FILE" "$checkpoint"
    [[ "$wait_exit" -eq 0 ]] || exit "$wait_exit"
  fi
fi
printf '%s\n' "$notary_result"
notary_status="$(jq -r '.status // empty' <<<"$notary_result")"
notary_id="$(jq -r '.id // empty' <<<"$notary_result")"
if [[ "$notary_status" != "Accepted" || -z "$notary_id" ]]; then
  echo "Error: notarization did not return an accepted result with an id." >&2
  exit 1
fi
if [[ -n "$NOTARY_RESULT_FILE" ]]; then
  write_json "$NOTARY_RESULT_FILE" "$notary_result"
fi

case "$ARTIFACT" in
  *.dmg|*.pkg)
    echo "📌 Stapling artifact: $ARTIFACT"
    if [[ -n "$SUBMISSION_FILE" ]]; then
      if [[ "$artifact_sha" != "$(jq -r '.stapledSha256 // empty' <<<"$checkpoint")" ]]; then
        # Staple a copy, then record its hash before replacement so interruption
        # accepts either known version, never arbitrary post-submission changes.
        staple_dir="$(mktemp -d "$(dirname "$ARTIFACT")/.notary-staple.XXXXXX")"
        staple_artifact="$staple_dir/$(basename "$ARTIFACT")"
        cp -p "$ARTIFACT" "$staple_artifact"
        xcrun stapler staple "$staple_artifact"
        xcrun stapler validate "$staple_artifact"
        stapled_sha="$(shasum -a 256 "$staple_artifact" | awk '{print $1}')"
        checkpoint="$(jq --arg sha "$stapled_sha" '.stapledSha256 = $sha' <<<"$checkpoint")"
        write_json "$SUBMISSION_FILE" "$checkpoint"
        mv "$staple_artifact" "$ARTIFACT"
        rmdir "$staple_dir"
        staple_dir=""
      fi
    else
      xcrun stapler staple "$ARTIFACT"
    fi
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
