#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if [[ $# -lt 1 ]]; then
  echo "usage: run-node-tool.sh <tool> [args...]" >&2
  exit 2
fi

tool="$1"
shift

local_tool="$ROOT_DIR/node_modules/.bin/$tool"
if [[ -x "$local_tool" ]]; then
  exec "$local_tool" "$@"
fi

if [[ -f "$ROOT_DIR/pnpm-lock.yaml" ]] && command -v pnpm >/dev/null 2>&1; then
  if [[ ! -e "$ROOT_DIR/node_modules" ]]; then
    echo "Missing repo dependencies: cannot run $tool without node_modules." >&2
    echo "Run pnpm install in a normal checkout, or bypass the hook only after separate formatting proof." >&2
    exit 1
  fi

  echo "Missing local tool: $local_tool" >&2
  exit 1
fi

if { [[ -f "$ROOT_DIR/bun.lockb" ]] || [[ -f "$ROOT_DIR/bun.lock" ]]; } && command -v bun >/dev/null 2>&1; then
  exec bunx --bun "$tool" "$@"
fi

if command -v npm >/dev/null 2>&1; then
  exec npm exec -- "$tool" "$@"
fi

if command -v npx >/dev/null 2>&1; then
  exec npx "$tool" "$@"
fi

echo "Missing package manager: pnpm, bun, or npm required." >&2
exit 1
