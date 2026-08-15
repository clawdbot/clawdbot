#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/android-release-upload.sh

Uploads Android Play metadata, builds signed release artifacts, and uploads the
Play AAB to Google Play internal testing by default. This does not promote the
build to production.
EOF
}

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${ROOT_DIR}/scripts/lib/android-fastlane.sh"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --)
      shift
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

(
  cd "${ROOT_DIR}/apps/android"
  run_android_fastlane android release_upload
)
