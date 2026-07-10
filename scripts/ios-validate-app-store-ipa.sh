#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/ios-validate-app-store-ipa.sh --ipa apps/ios/build/app-store/OpenClaw-<version>.ipa \
    [--expected-commit <full-sha>] [--expected-build-timestamp <utc-iso>]

Validates the exported iOS App Store IPA before App Store Connect upload.
EOF
}

IPA_PATH=""
EXPECTED_GIT_COMMIT=""
EXPECTED_BUILD_TIMESTAMP=""
EXPECTED_TEAM_ID="FWJYW4S8P8"
EXPECTED_BUNDLE_ID="ai.openclawfoundation.app"
EXPECTED_PROFILE_NAME="OpenClaw App Store ai.openclawfoundation.app"
EXPECTED_APP_GROUP="group.ai.openclawfoundation.app.shared"
EXPECTED_PUSH_MODE="appStore"

PLIST_BUDDY_BIN="${IOS_VALIDATE_PLIST_BUDDY_BIN:-/usr/libexec/PlistBuddy}"
CODESIGN_BIN="${IOS_VALIDATE_CODESIGN_BIN:-codesign}"
SECURITY_BIN="${IOS_VALIDATE_SECURITY_BIN:-security}"
UNZIP_BIN="${IOS_VALIDATE_UNZIP_BIN:-unzip}"

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
    --ipa)
      require_option_value "$1" "${2-}"
      IPA_PATH="$2"
      shift 2
      ;;
    --expected-commit)
      require_option_value "$1" "${2-}"
      EXPECTED_GIT_COMMIT="$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')"
      shift 2
      ;;
    --expected-build-timestamp)
      require_option_value "$1" "${2-}"
      EXPECTED_BUILD_TIMESTAMP="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${IPA_PATH}" ]]; then
  echo "Missing required --ipa." >&2
  usage >&2
  exit 1
fi

if [[ ! -f "${IPA_PATH}" ]]; then
  echo "IPA not found: ${IPA_PATH}" >&2
  exit 1
fi

tmp_dir="$(mktemp -d -t openclaw-ios-ipa.XXXXXX)"
trap 'rm -rf "${tmp_dir}"' EXIT

"${UNZIP_BIN}" -q "${IPA_PATH}" -d "${tmp_dir}"

payload_dir="${tmp_dir}/Payload"
if [[ ! -d "${payload_dir}" ]]; then
  echo "Invalid IPA: missing Payload directory." >&2
  exit 1
fi

app_paths=()
while IFS= read -r app_bundle; do
  app_paths+=("${app_bundle}")
done < <(find "${payload_dir}" -maxdepth 1 -type d -name "*.app" | sort)
if [[ "${#app_paths[@]}" -ne 1 ]]; then
  echo "Invalid IPA: expected exactly one app bundle in Payload, found ${#app_paths[@]}." >&2
  exit 1
fi

app_path="${app_paths[0]}"
info_plist="${app_path}/Info.plist"
embedded_profile="${app_path}/embedded.mobileprovision"
entitlements_plist="${tmp_dir}/entitlements.plist"
profile_plist="${tmp_dir}/profile.plist"

if [[ ! -f "${info_plist}" ]]; then
  echo "Invalid IPA: missing app Info.plist." >&2
  exit 1
fi
if [[ ! -f "${embedded_profile}" ]]; then
  echo "Invalid IPA: missing embedded.mobileprovision." >&2
  exit 1
fi

plist_value() {
  local plist="$1"
  local key_path="$2"
  "${PLIST_BUDDY_BIN}" -c "Print:${key_path}" "${plist}" 2>/dev/null || true
}

plist_has_key() {
  local plist="$1"
  local key_path="$2"
  "${PLIST_BUDDY_BIN}" -c "Print:${key_path}" "${plist}" >/dev/null 2>&1
}

assert_plist_string() {
  local plist="$1"
  local key_path="$2"
  local expected="$3"
  local label="$4"
  local actual
  actual="$(plist_value "${plist}" "${key_path}")"
  if [[ "${actual}" != "${expected}" ]]; then
    echo "Invalid IPA: ${label}; expected ${expected}, got ${actual:-missing}." >&2
    exit 1
  fi
}

assert_plist_key_absent() {
  local plist="$1"
  local key_path="$2"
  local label="$3"
  if plist_has_key "${plist}" "${key_path}"; then
    echo "Invalid IPA: ${label} must not be present in App Store builds." >&2
    exit 1
  fi
}

assert_plist_array_contains() {
  local plist="$1"
  local key_path="$2"
  local expected="$3"
  local label="$4"
  local raw
  raw="$(plist_value "${plist}" "${key_path}")"
  if ! printf '%s\n' "${raw}" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -Fxq "${expected}"; then
    echo "Invalid IPA: ${label}; expected ${expected} in ${key_path}." >&2
    exit 1
  fi
}

assert_plist_empty_or_absent() {
  local plist="$1"
  local key_path="$2"
  local label="$3"
  local actual
  actual="$(plist_value "${plist}" "${key_path}")"
  if [[ -n "${actual}" ]]; then
    echo "Invalid IPA: ${label} must be empty for App Store builds; got ${actual}." >&2
    exit 1
  fi
}

assert_build_provenance() {
  local commit
  local timestamp
  commit="$(plist_value "${info_plist}" "OpenClawGitCommit")"
  timestamp="$(plist_value "${info_plist}" "OpenClawBuildTimestamp")"
  if [[ ! "${commit}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Invalid IPA: OpenClawGitCommit must be a full lowercase commit SHA; got ${commit:-missing}." >&2
    exit 1
  fi
  if [[ ! "${timestamp}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$ ]]; then
    echo "Invalid IPA: OpenClawBuildTimestamp must be a canonical UTC timestamp; got ${timestamp:-missing}." >&2
    exit 1
  fi
  if [[ -n "${EXPECTED_GIT_COMMIT}" && "${commit}" != "${EXPECTED_GIT_COMMIT}" ]]; then
    echo "Invalid IPA: embedded Git commit mismatch; expected ${EXPECTED_GIT_COMMIT}, got ${commit}." >&2
    exit 1
  fi
  if [[ -n "${EXPECTED_BUILD_TIMESTAMP}" && "${timestamp}" != "${EXPECTED_BUILD_TIMESTAMP}" ]]; then
    echo "Invalid IPA: embedded build timestamp mismatch; expected ${EXPECTED_BUILD_TIMESTAMP}, got ${timestamp}." >&2
    exit 1
  fi
}

assert_plist_string "${info_plist}" "CFBundleIdentifier" "${EXPECTED_BUNDLE_ID}" "bundle identifier mismatch"
assert_plist_string "${info_plist}" "OpenClawPushMode" "${EXPECTED_PUSH_MODE}" "push mode mismatch"
assert_build_provenance
assert_plist_empty_or_absent "${info_plist}" "OpenClawPushRelayBaseURL" "push relay URL override"
assert_plist_key_absent "${info_plist}" "OpenClawPushTransport" "legacy push transport"
assert_plist_key_absent "${info_plist}" "OpenClawPushDistribution" "legacy push distribution"
assert_plist_key_absent "${info_plist}" "OpenClawPushAPNsEnvironment" "legacy APNs environment"
assert_plist_key_absent "${info_plist}" "OpenClawPushRelayProfile" "legacy relay profile"
assert_plist_key_absent "${info_plist}" "OpenClawPushProofPolicy" "legacy proof policy"

if ! "${CODESIGN_BIN}" -d --entitlements :- "${app_path}" >"${entitlements_plist}" 2>"${tmp_dir}/codesign.err"; then
  detail="$(<"${tmp_dir}/codesign.err")"
  echo "Invalid IPA: failed to read signed entitlements${detail:+: ${detail}}" >&2
  exit 1
fi

assert_plist_string "${entitlements_plist}" "application-identifier" "${EXPECTED_TEAM_ID}.${EXPECTED_BUNDLE_ID}" "signed application identifier mismatch"
assert_plist_string "${entitlements_plist}" "com.apple.developer.team-identifier" "${EXPECTED_TEAM_ID}" "signed team identifier mismatch"
assert_plist_string "${entitlements_plist}" "aps-environment" "production" "signed APNs entitlement mismatch"
assert_plist_string "${entitlements_plist}" "com.apple.developer.devicecheck.appattest-environment" "production" "signed App Attest entitlement mismatch"
assert_plist_array_contains "${entitlements_plist}" "com.apple.security.application-groups" "${EXPECTED_APP_GROUP}" "signed App Group entitlement mismatch"

if ! "${SECURITY_BIN}" cms -D -i "${embedded_profile}" >"${profile_plist}" 2>"${tmp_dir}/security.err"; then
  detail="$(<"${tmp_dir}/security.err")"
  echo "Invalid IPA: failed to decode embedded provisioning profile${detail:+: ${detail}}" >&2
  exit 1
fi

assert_plist_string "${profile_plist}" "Name" "${EXPECTED_PROFILE_NAME}" "embedded profile name mismatch"
assert_plist_array_contains "${profile_plist}" "TeamIdentifier" "${EXPECTED_TEAM_ID}" "embedded profile team mismatch"
assert_plist_string "${profile_plist}" "Entitlements:application-identifier" "${EXPECTED_TEAM_ID}.${EXPECTED_BUNDLE_ID}" "embedded profile application identifier mismatch"
assert_plist_string "${profile_plist}" "Entitlements:aps-environment" "production" "embedded profile APNs entitlement mismatch"
assert_plist_array_contains "${profile_plist}" "Entitlements:com.apple.developer.devicecheck.appattest-environment" "production" "embedded profile App Attest entitlement mismatch"
assert_plist_array_contains "${profile_plist}" "Entitlements:com.apple.security.application-groups" "${EXPECTED_APP_GROUP}" "embedded profile App Group entitlement mismatch"

echo "Validated iOS App Store IPA: ${IPA_PATH}"
