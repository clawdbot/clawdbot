#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/apple-release-source-check.sh --root <repository> --expected-commit <full-sha>

Verifies an Apple release build uses the clean checkout at the selected commit.
EOF
}

EXPECTED_COMMIT=""
ROOT_DIR=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/build-metadata.sh"

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
    --expected-commit)
      require_option_value "$1" "${2-}"
      EXPECTED_COMMIT="$2"
      shift 2
      ;;
    --root)
      require_option_value "$1" "${2-}"
      ROOT_DIR="$2"
      shift 2
      ;;
    -h | --help)
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

if [[ -z "${ROOT_DIR}" ]]; then
  echo "Missing required --root." >&2
  usage >&2
  exit 1
fi
if [[ -z "${EXPECTED_COMMIT}" ]]; then
  echo "Missing required --expected-commit." >&2
  usage >&2
  exit 1
fi

EXPECTED_COMMIT="$(openclaw_trim_build_metadata_value "${EXPECTED_COMMIT}")"
if ! openclaw_is_full_git_commit "${EXPECTED_COMMIT}"; then
  echo "Apple release commit must be a full 40-character hexadecimal SHA." >&2
  exit 1
fi
EXPECTED_COMMIT="$(printf '%s' "${EXPECTED_COMMIT}" | tr '[:upper:]' '[:lower:]')"

if ! CHECKOUT_COMMIT="$(git -C "${ROOT_DIR}" rev-parse --verify HEAD 2>/dev/null)"; then
  echo "Apple release builds require a readable Git checkout." >&2
  exit 1
fi
if ! openclaw_is_full_git_commit "${CHECKOUT_COMMIT}"; then
  echo "Apple release checkout HEAD must be a full Git commit." >&2
  exit 1
fi
CHECKOUT_COMMIT="$(printf '%s' "${CHECKOUT_COMMIT}" | tr '[:upper:]' '[:lower:]')"

if [[ "${EXPECTED_COMMIT}" != "${CHECKOUT_COMMIT}" ]]; then
  echo "Apple release commit mismatch: metadata ${EXPECTED_COMMIT}, checkout ${CHECKOUT_COMMIT}." >&2
  exit 1
fi

if ! CHECKOUT_STATUS="$(git -C "${ROOT_DIR}" status --porcelain=v1 --untracked-files=all 2>/dev/null)"; then
  echo "Apple release builds require a readable Git checkout." >&2
  exit 1
fi
if [[ -n "${CHECKOUT_STATUS}" ]]; then
  echo "Apple release builds require a clean Git checkout." >&2
  exit 1
fi

echo "Verified Apple release source: commit=${CHECKOUT_COMMIT} clean=true"
