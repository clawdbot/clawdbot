#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/ios-release-prepare.sh --version 2026.7.2 --revision 1 --build-number 3 [--team-id TEAMID]

Prepares local App Store release inputs without touching local signing overrides:
- writes apps/ios/build/Version.xcconfig for the explicit gateway and App Store revision
- writes apps/ios/build/AppStoreRelease.xcconfig with canonical bundle IDs
- configures the release build for relay-backed APNs registration
- configures manual App Store distribution signing with pinned provisioning profiles
- regenerates apps/ios/OpenClaw.xcodeproj via xcodegen
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="${ROOT_DIR}/apps/ios"
BUILD_DIR="${IOS_DIR}/build"
RELEASE_XCCONFIG="${IOS_DIR}/build/AppStoreRelease.xcconfig"
TEAM_HELPER="${ROOT_DIR}/scripts/ios-team-id.sh"
VERSION_HELPER="${ROOT_DIR}/scripts/ios-write-version-xcconfig.sh"
IOS_VERSION_HELPER="${ROOT_DIR}/scripts/ios-version.ts"
VERSION_SYNC_HELPER="${ROOT_DIR}/scripts/ios-sync-versioning.ts"
RELEASE_SIGNING_HELPER="${ROOT_DIR}/scripts/ios-release-signing.mjs"
RELEASE_SOURCE_HELPER="${ROOT_DIR}/scripts/apple-release-source-check.sh"
CANONICAL_TEAM_ID="FWJYW4S8P8"

BUILD_NUMBER=""
APP_STORE_REVISION=""
RELEASE_VERSION=""
TEAM_ID="${IOS_DEVELOPMENT_TEAM:-}"
IOS_VERSION=""
RELEASE_SIGNING_XCCONFIG=""
RELEASE_GIT_COMMIT=""

prepare_build_dir() {
  if [[ -L "${BUILD_DIR}" ]]; then
    echo "Refusing to use symlinked build directory: ${BUILD_DIR}" >&2
    exit 1
  fi

  mkdir -p "${BUILD_DIR}"
}

write_generated_file() {
  local output_path="$1"
  local tmp_file=""

  if [[ -e "${output_path}" && -L "${output_path}" ]]; then
    echo "Refusing to overwrite symlinked file: ${output_path}" >&2
    exit 1
  fi

  tmp_file="$(mktemp "${output_path}.XXXXXX")"
  cat >"${tmp_file}"
  mv -f "${tmp_file}" "${output_path}"
}

require_option_value() {
  local option="$1"
  local value="${2-}"

  if [[ -z "${value}" || "${value}" == --* ]]; then
    echo "Missing value for ${option}." >&2
    usage >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
      ;;
    --build-number)
      require_option_value "$1" "${2-}"
      BUILD_NUMBER="${2:-}"
      shift 2
      ;;
    --revision)
      require_option_value "$1" "${2-}"
      APP_STORE_REVISION="${2:-}"
      shift 2
      ;;
    --version)
      require_option_value "$1" "${2-}"
      RELEASE_VERSION="${2:-}"
      shift 2
      ;;
    --team-id)
      require_option_value "$1" "${2-}"
      TEAM_ID="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "${BUILD_NUMBER}" ]]; then
  echo "Missing required --build-number." >&2
  usage >&2
  exit 1
fi

if [[ -z "${RELEASE_VERSION}" ]]; then
  echo "Missing required --version." >&2
  usage >&2
  exit 1
fi

if [[ -z "${APP_STORE_REVISION}" ]]; then
  echo "Missing required --revision." >&2
  usage >&2
  exit 1
fi

if [[ -z "${TEAM_ID}" ]]; then
  TEAM_ID="$(IOS_ALLOW_KEYCHAIN_TEAM_FALLBACK=1 bash "${TEAM_HELPER}" --require-canonical)"
fi

if [[ -z "${TEAM_ID}" ]]; then
  echo "Could not resolve Apple Team ID. Set IOS_DEVELOPMENT_TEAM or sign into Xcode." >&2
  exit 1
fi

if [[ "${TEAM_ID}" != "${CANONICAL_TEAM_ID}" ]]; then
  echo "iOS App Store release must use canonical OpenClaw Team ID ${CANONICAL_TEAM_ID}; got ${TEAM_ID}." >&2
  exit 1
fi

if [[ -n "${OPENCLAW_PUSH_RELAY_BASE_URL:-}" || -n "${IOS_PUSH_RELAY_BASE_URL:-}" ]]; then
  echo "iOS App Store release uses the canonical hosted push relay; custom relay URL overrides are not allowed." >&2
  exit 1
fi

source "${ROOT_DIR}/scripts/lib/build-metadata.sh"
RELEASE_GIT_COMMIT="$(OPENCLAW_REQUIRE_BUILD_METADATA=1 openclaw_resolve_git_commit "${ROOT_DIR}")"
bash "${RELEASE_SOURCE_HELPER}" --root "${ROOT_DIR}" --expected-commit "${RELEASE_GIT_COMMIT}"
export GIT_COMMIT="${RELEASE_GIT_COMMIT}"

prepare_build_dir

(
  cd "${ROOT_DIR}" && node --import tsx "${VERSION_SYNC_HELPER}" --check --version "${RELEASE_VERSION}" --revision "${APP_STORE_REVISION}"
)

IOS_VERSION="$(cd "${ROOT_DIR}" && node --import tsx "${IOS_VERSION_HELPER}" --version "${RELEASE_VERSION}" --revision "${APP_STORE_REVISION}" --field marketingVersion)"
if [[ -z "${IOS_VERSION}" ]]; then
  echo "Unable to resolve App Store version for gateway '${RELEASE_VERSION}' revision '${APP_STORE_REVISION}'." >&2
  exit 1
fi

RELEASE_SIGNING_XCCONFIG="$(cd "${ROOT_DIR}" && node "${RELEASE_SIGNING_HELPER}" --mode xcconfig)"
if [[ -z "${RELEASE_SIGNING_XCCONFIG}" ]]; then
  echo "Unable to resolve App Store release signing profile settings." >&2
  exit 1
fi

(
  OPENCLAW_REQUIRE_BUILD_METADATA=1 \
    bash "${VERSION_HELPER}" --version "${RELEASE_VERSION}" --revision "${APP_STORE_REVISION}" --build-number "${BUILD_NUMBER}"
)
node "${ROOT_DIR}/scripts/ios-write-swift-filelist.mjs"

write_generated_file "${RELEASE_XCCONFIG}" <<EOF
// Auto-generated by scripts/ios-release-prepare.sh.
// Local App Store release override; do not commit.
${RELEASE_SIGNING_XCCONFIG}
OPENCLAW_DEVELOPMENT_TEAM = ${TEAM_ID}
OPENCLAW_IOS_SELECTED_TEAM = ${TEAM_ID}
OPENCLAW_APP_BUNDLE_ID = ai.openclawfoundation.app
OPENCLAW_SHARE_BUNDLE_ID = ai.openclawfoundation.app.share
OPENCLAW_ACTIVITY_WIDGET_BUNDLE_ID = ai.openclawfoundation.app.activitywidget
OPENCLAW_WATCH_APP_BUNDLE_ID = ai.openclawfoundation.app.watchkitapp
OPENCLAW_CODE_SIGN_ENTITLEMENTS = Sources/OpenClawAppAttest.entitlements
OPENCLAW_APNS_ENTITLEMENT_ENVIRONMENT = production
OPENCLAW_APP_ATTEST_ENVIRONMENT = production
OPENCLAW_PUSH_MODE = appStore
OPENCLAW_PUSH_RELAY_BASE_URL =
EOF

(
  cd "${IOS_DIR}"
  xcodegen generate
)

echo "Prepared iOS App Store release: version=${IOS_VERSION} build=${BUILD_NUMBER} team=${TEAM_ID}"
echo "XCODE_XCCONFIG_FILE=${RELEASE_XCCONFIG}"
