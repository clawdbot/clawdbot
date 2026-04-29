#!/usr/bin/env bash
set -euo pipefail

tsx_version="${OPENCLAW_RELEASE_TSX_VERSION:-${TSX_VERSION:-4.21.0}}"
script_path="${OPENCLAW_RELEASE_CHECKS_SCRIPT:-workflow/scripts/openclaw-cross-os-release-checks.ts}"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  if command -v cygpath >/dev/null 2>&1; then
    for node_dir in /c/hostedtoolcache/windows/node/*/x64 /c/actions-runner/_work/_tool/node/*/x64; do
      if [[ -x "${node_dir}/node.exe" ]]; then
        export PATH="${node_dir}:${PATH}"
        break
      fi
    done
  fi
fi

temp_root="${OPENCLAW_RELEASE_TSX_TOOL_ROOT:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"
if command -v cygpath >/dev/null 2>&1; then
  temp_root="$(cygpath -u "${temp_root}")"
fi

tool_dir="${OPENCLAW_RELEASE_TSX_TOOL_DIR:-${temp_root}/openclaw-release-tsx-${tsx_version}}"
loader_path="${tool_dir}/node_modules/tsx/dist/loader.mjs"

command -v node >/dev/null 2>&1 || {
  echo "node is required to run cross-OS release checks." >&2
  exit 127
}
command -v npm >/dev/null 2>&1 || {
  echo "npm is required to install the cross-OS release-check loader." >&2
  exit 127
}

if [[ ! -f "${loader_path}" ]]; then
  mkdir -p "${tool_dir}"
  npm install --prefix "${tool_dir}" --no-save --no-package-lock "tsx@${tsx_version}" >/dev/null
fi

loader_url="$(
  node -e '
    const { resolve } = require("node:path");
    const { pathToFileURL } = require("node:url");
    process.stdout.write(pathToFileURL(resolve(process.argv[1])).href);
  ' "${loader_path}"
)"

exec node --import "${loader_url}" "${script_path}" "$@"
