#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IOS_DIR="${ROOT_DIR}/apps/ios"

APP_NAME="${IOS_APP_NAME:-OpenClaw}"
CONFIGURATION="${IOS_CONFIGURATION:-Debug}"
DERIVED_DATA_DIR="${IOS_DERIVED_DATA_DIR:-${IOS_DIR}/build/DerivedData}"
IOS_DESTINATION="${IOS_DEST:-platform=iOS Simulator,name=iPhone 17}"
SIMULATOR_TARGET="${IOS_SIM:-iPhone 17}"

XCODEBUILD_BIN="${IOS_RUN_XCODEBUILD_BIN:-xcodebuild}"
XCODEGEN_BIN="${IOS_RUN_XCODEGEN_BIN:-xcodegen}"
SIMCTL_BIN="${IOS_RUN_SIMCTL_BIN:-xcrun simctl}"
PLIST_BUDDY_BIN="${IOS_RUN_PLIST_BUDDY_BIN:-/usr/libexec/PlistBuddy}"

usage() {
  cat <<'EOF'
Usage: scripts/ios-run.sh [options]

Options:
  --push-sandbox-simulator
      Build with the hosted sandbox push relay and launch the simulator with an
      internal simulator proof secret.
  --push-relay-base-url <url>
      Override the sandbox relay URL used with --push-sandbox-simulator.
      Defaults to https://ios-push-relay-sandbox.openclaw.ai.
  --simulator-proof-secret-env <name>
      Environment variable that contains the simulator proof secret.
      Defaults to OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET.
  -h, --help
      Show this help.
EOF
}

run_simctl() {
  # shellcheck disable=SC2086
  ${SIMCTL_BIN} "$@"
}

push_sandbox_simulator=0
push_relay_base_url="${OPENCLAW_PUSH_SANDBOX_RELAY_BASE_URL:-https://ios-push-relay-sandbox.openclaw.ai}"
simulator_proof_secret_env="${OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET_ENV:-OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --push-sandbox-simulator)
      push_sandbox_simulator=1
      ;;
    --push-relay-base-url)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "ERROR: --push-relay-base-url requires a URL" >&2
        exit 1
      fi
      push_relay_base_url="$2"
      shift
      ;;
    --simulator-proof-secret-env)
      if [[ $# -lt 2 || -z "$2" ]]; then
        echo "ERROR: --simulator-proof-secret-env requires an environment variable name" >&2
        exit 1
      fi
      simulator_proof_secret_env="$2"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
done

xcodebuild_overrides=()
simulator_proof_secret=""

if [[ ! "${simulator_proof_secret_env}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "ERROR: Invalid simulator proof secret environment variable name" >&2
  exit 1
fi

if [[ "${push_sandbox_simulator}" == "1" ]]; then
  simulator_proof_secret="${!simulator_proof_secret_env:-}"
  if [[ -z "${simulator_proof_secret}" ]]; then
    echo "ERROR: ${simulator_proof_secret_env} must be set for --push-sandbox-simulator" >&2
    exit 1
  fi
  if [[ "${#simulator_proof_secret}" -lt 32 ]]; then
    echo "ERROR: ${simulator_proof_secret_env} must contain at least 32 characters" >&2
    exit 1
  fi

  xcodebuild_overrides+=(
    "OPENCLAW_PUSH_MODE=simulatorSandbox"
    "OPENCLAW_PUSH_RELAY_BASE_URL=${push_relay_base_url}"
    "OPENCLAW_APNS_ENTITLEMENT_ENVIRONMENT=development"
  )
fi

unset "${simulator_proof_secret_env}"
if [[ "${simulator_proof_secret_env}" != "OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET" ]]; then
  unset OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET
fi

"${ROOT_DIR}/scripts/ios-configure-signing.sh"
"${ROOT_DIR}/scripts/ios-write-version-xcconfig.sh"
node "${ROOT_DIR}/scripts/ios-write-swift-filelist.mjs"

cd "${IOS_DIR}"
"${XCODEGEN_BIN}" generate
if [[ "${push_sandbox_simulator}" == "1" ]]; then
  "${XCODEBUILD_BIN}" \
    -project OpenClaw.xcodeproj \
    -scheme OpenClaw \
    -destination "${IOS_DESTINATION}" \
    -configuration "${CONFIGURATION}" \
    -derivedDataPath "${DERIVED_DATA_DIR}" \
    build \
    "${xcodebuild_overrides[@]}"
else
  "${XCODEBUILD_BIN}" \
    -project OpenClaw.xcodeproj \
    -scheme OpenClaw \
    -destination "${IOS_DESTINATION}" \
    -configuration "${CONFIGURATION}" \
    -derivedDataPath "${DERIVED_DATA_DIR}" \
    build
fi

app_path="${DERIVED_DATA_DIR}/Build/Products/${CONFIGURATION}-iphonesimulator/${APP_NAME}.app"
if [[ ! -d "${app_path}" ]]; then
  echo "ERROR: Built app not found at ${app_path}" >&2
  exit 1
fi

bundle_id="$("${PLIST_BUDDY_BIN}" -c 'Print :CFBundleIdentifier' "${app_path}/Info.plist" 2>/dev/null || true)"
if [[ -z "${bundle_id}" ]]; then
  echo "ERROR: Built app is missing CFBundleIdentifier: ${app_path}/Info.plist" >&2
  exit 1
fi

boot_output=""
if ! boot_output="$(run_simctl boot "${SIMULATOR_TARGET}" 2>&1)"; then
  if [[ "${boot_output}" != *"Unable to boot device in current state: Booted"* ]]; then
    printf '%s\n' "${boot_output}" >&2
    exit 1
  fi
fi

run_simctl install "${SIMULATOR_TARGET}" "${app_path}"
if [[ "${push_sandbox_simulator}" == "1" ]]; then
  # shellcheck disable=SC2086
  SIMCTL_CHILD_OPENCLAW_SIMULATOR_PUSH_PROOF_SECRET="${simulator_proof_secret}" \
    ${SIMCTL_BIN} launch "${SIMULATOR_TARGET}" "${bundle_id}"
else
  run_simctl launch "${SIMULATOR_TARGET}" "${bundle_id}"
fi
