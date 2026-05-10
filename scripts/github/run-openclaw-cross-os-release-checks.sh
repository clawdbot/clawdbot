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

node_cmd="node"
npm_cmd="npm"
npm_cli_js=""
if command -v cygpath >/dev/null 2>&1; then
  if command -v node.exe >/dev/null 2>&1; then
    node_cmd="node.exe"
    node_path="$(command -v node.exe)"
    node_dir="$(dirname "$(cygpath -u "${node_path}")")"
    if [[ -f "${node_dir}/node_modules/npm/bin/npm-cli.js" ]]; then
      npm_cli_js="${node_dir}/node_modules/npm/bin/npm-cli.js"
    fi
  fi
  if command -v npm.cmd >/dev/null 2>&1; then
    npm_cmd="npm.cmd"
  elif command -v npm.exe >/dev/null 2>&1; then
    npm_cmd="npm.exe"
  fi
fi

temp_root="${OPENCLAW_RELEASE_TSX_TOOL_ROOT:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"
if command -v cygpath >/dev/null 2>&1; then
  temp_root="$(cygpath -u "${temp_root}")"
fi

tool_dir="${OPENCLAW_RELEASE_TSX_TOOL_DIR:-${temp_root}/openclaw-release-tsx-${tsx_version}}"
loader_path="${tool_dir}/node_modules/tsx/dist/loader.mjs"
npm_tool_dir="${tool_dir}"
npm_cli_arg="${npm_cli_js}"
loader_arg="${loader_path}"
if command -v cygpath >/dev/null 2>&1; then
  npm_tool_dir="$(cygpath -w "${tool_dir}")"
  if [[ -n "${npm_cli_js}" ]]; then
    npm_cli_arg="$(cygpath -w "${npm_cli_js}")"
  fi
  loader_arg="$(cygpath -w "${loader_path}")"
fi

command -v "${node_cmd}" >/dev/null 2>&1 || {
  echo "node is required to run cross-OS release checks." >&2
  exit 127
}
command -v "${npm_cmd}" >/dev/null 2>&1 || {
  echo "npm is required to install the cross-OS release-check loader." >&2
  exit 127
}

if [[ ! -f "${loader_path}" ]]; then
  mkdir -p "${tool_dir}"
  if [[ -n "${npm_cli_js}" ]]; then
    if ! "${node_cmd}" "${npm_cli_arg}" install --prefix "${npm_tool_dir}" --no-save --no-package-lock "tsx@${tsx_version}" >/dev/null; then
      echo "failed to install cross-OS release-check loader with ${node_cmd} ${npm_cli_arg}." >&2
      exit 127
    fi
  elif ! "${npm_cmd}" install --prefix "${npm_tool_dir}" --no-save --no-package-lock "tsx@${tsx_version}" >/dev/null; then
    echo "failed to install cross-OS release-check loader with ${npm_cmd}." >&2
    exit 127
  fi
fi

if [[ ! -f "${loader_path}" ]]; then
  echo "tsx loader missing after install: ${loader_path}" >&2
  find "${tool_dir}" -maxdepth 5 -type f 2>/dev/null | sort | sed 's/^/  /' >&2 || true
  exit 127
fi

loader_url="$(
  "${node_cmd}" -e '
    const { resolve } = require("node:path");
    const { pathToFileURL } = require("node:url");
    process.stdout.write(pathToFileURL(resolve(process.argv[1])).href);
  ' "${loader_arg}"
)"

exec "${node_cmd}" --import "${loader_url}" "${script_path}" "$@"
