#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/ios-release-archive.sh --version 2026.7.2 --revision 1 [--build-number 3]

Archives and exports an App Store distribution IPA locally without uploading.
EOF
}

BUILD_NUMBER=""
APP_STORE_REVISION=""
RELEASE_VERSION=""
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib/ios-fastlane.sh"

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

FASTLANE_ARGS=(ios app_store_archive "release_version:${RELEASE_VERSION}" "app_store_revision:${APP_STORE_REVISION}")
if [[ -n "${BUILD_NUMBER}" ]]; then
  FASTLANE_ARGS+=("build_number:${BUILD_NUMBER}")
fi

(
  cd "${ROOT_DIR}/apps/ios"
  run_ios_fastlane "${FASTLANE_ARGS[@]}"
)
