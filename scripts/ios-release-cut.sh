#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/ios-release-cut.sh [--version 2026.7.2] [--revision 1] [--build-number 3]

Resolves the live iOS release plan and moves Unreleased notes into the exact
planned App Store version heading. This does not mutate App Store Connect.
EOF
}

for argument in "$@"; do
  if [[ "${argument}" == "-h" || "${argument}" == "--help" ]]; then
    usage
    exit 0
  fi
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLAN_FILE="$(mktemp "${TMPDIR:-/tmp}/openclaw-ios-release-cut.XXXXXX")"
trap 'rm -f "${PLAN_FILE}"' EXIT

bash "${ROOT_DIR}/scripts/ios-release-plan.sh" --json "$@" >"${PLAN_FILE}"
(
  cd "${ROOT_DIR}"
  node --import tsx scripts/ios-release-cut.ts --plan "${PLAN_FILE}"
)
