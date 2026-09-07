#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Standalone iOS release cutting is retired. Use scripts/mobile-release-version.ts
--prepare, capture pnpm ios:release:plan -- --json, then use --finalize.
EOF
}

for argument in "$@"; do
  if [[ "${argument}" == "-h" || "${argument}" == "--help" ]]; then
    usage
    exit 0
  fi
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec node --import tsx "${ROOT_DIR}/scripts/ios-release-cut.ts" "$@"
