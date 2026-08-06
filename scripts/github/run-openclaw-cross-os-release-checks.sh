#!/usr/bin/env bash
set -euo pipefail

script_path="${OPENCLAW_RELEASE_CHECKS_SCRIPT:-workflow/scripts/openclaw-cross-os-release-checks.ts}"

if ! command -v node >/dev/null 2>&1; then
  if command -v cygpath >/dev/null 2>&1; then
    for node_dir in /c/hostedtoolcache/windows/node/*/x64 /c/actions-runner/_work/_tool/node/*/x64; do
      if [[ -x "${node_dir}/node.exe" ]]; then
        export PATH="${node_dir}:${PATH}"
        break
      fi
    done
  fi
fi

node_cmd="node"
if command -v cygpath >/dev/null 2>&1; then
  if command -v node.exe >/dev/null 2>&1; then
    node_cmd="node.exe"
  fi
fi

command -v "${node_cmd}" >/dev/null 2>&1 || {
  echo "node is required to run cross-OS release checks." >&2
  exit 127
}

exec "${node_cmd}" "${script_path}" "$@"
