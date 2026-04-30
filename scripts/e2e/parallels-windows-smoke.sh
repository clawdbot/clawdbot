#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
exec pnpm --dir "$ROOT_DIR" exec tsx scripts/e2e/parallels/windows-smoke.ts "$@"
