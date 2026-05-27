#!/usr/bin/env bash

openclaw_node_version_matches() {
  local actual="$1"
  local requested="$2"
  if [[ -z "$requested" ]]; then
    return 0
  fi
  case "$requested" in
    *x)
      [[ "${actual%%.*}" == "${requested%%.*}" ]] || return 1
      if [[ "${requested%%.*}" == "22" ]]; then
        openclaw_node_version_at_least "$actual" "22.19.0"
      fi
      ;;
    *.*.*)
      [[ "$actual" == "$requested" ]]
      ;;
    *.*)
      [[ "$actual" == "$requested".* ]]
      ;;
    *)
      [[ "${actual%%.*}" == "$requested" ]]
      ;;
  esac
}

openclaw_node_version_at_least() {
  local actual="$1"
  local minimum="$2"
  local actual_major actual_minor actual_patch minimum_major minimum_minor minimum_patch
  IFS=. read -r actual_major actual_minor actual_patch <<< "$actual"
  IFS=. read -r minimum_major minimum_minor minimum_patch <<< "$minimum"
  actual_minor="${actual_minor:-0}"
  actual_patch="${actual_patch:-0}"
  minimum_minor="${minimum_minor:-0}"
  minimum_patch="${minimum_patch:-0}"

  if (( actual_major != minimum_major )); then
    (( actual_major > minimum_major ))
    return
  fi
  if (( actual_minor != minimum_minor )); then
    (( actual_minor > minimum_minor ))
    return
  fi
  (( actual_patch >= minimum_patch ))
}

openclaw_active_node_version() {
  node -p 'process.versions.node' 2>/dev/null || true
}

openclaw_prepend_node_bin() {
  local node_bin_dir="$1"
  local github_path_dir="${2:-$node_bin_dir}"
  local shell_node_bin_dir="$node_bin_dir"
  if command -v cygpath >/dev/null 2>&1; then
    shell_node_bin_dir="$(cygpath -u "$node_bin_dir" 2>/dev/null || printf '%s' "$node_bin_dir")"
  fi
  export PATH="$shell_node_bin_dir:$PATH"
  if [[ -n "${GITHUB_PATH:-}" ]]; then
    local github_node_bin_dir="$github_path_dir"
    if [[ $# -lt 2 ]] && command -v cygpath >/dev/null 2>&1; then
      github_node_bin_dir="$shell_node_bin_dir"
      github_node_bin_dir="$(cygpath -w "$shell_node_bin_dir" 2>/dev/null || printf '%s' "$shell_node_bin_dir")"
    fi
    echo "$github_node_bin_dir" >> "$GITHUB_PATH"
  fi
  hash -r
}

openclaw_find_toolcache_node() {
  local requested_node="$1"
  local roots=()
  local root
  for root in \
    "${RUNNER_TOOL_CACHE:-}" \
    "${AGENT_TOOLSDIRECTORY:-}" \
    "${ACTIONS_RUNNER_TOOL_CACHE:-}" \
    "${OPENCLAW_CONTAINER_TOOL_CACHE:-/__t}" \
    "/opt/hostedtoolcache" \
    "/home/runner/_work/_tool" \
    "/Users/runner/hostedtoolcache" \
    "/c/hostedtoolcache/windows"
  do
    if [[ ! -d "$root" && "$root" == *\\* ]] && command -v cygpath >/dev/null 2>&1; then
      root="$(cygpath -u "$root" 2>/dev/null || printf '%s' "$root")"
    fi
    if [[ -d "$root/node" ]]; then
      roots+=("$root/node")
    elif [[ "$(basename "$root")" == "node" && -d "$root" ]]; then
      roots+=("$root")
    fi
  done

  local node_root candidate candidate_version
  for node_root in "${roots[@]}"; do
    while IFS= read -r candidate; do
      candidate_version="$("$candidate" -p 'process.versions.node' 2>/dev/null || true)"
      if openclaw_node_version_matches "$candidate_version" "$requested_node"; then
        printf '%s\n' "$candidate"
        return 0
      fi
    done < <(find "$node_root" \( -name node -o -name node.exe \) -type f 2>/dev/null | sort -r)
  done
  return 1
}

openclaw_resolve_node_download_version() {
  local requested_node="$1"
  if [[ "$requested_node" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    [[ "$requested_node" == v* ]] && printf '%s\n' "$requested_node" || printf 'v%s\n' "$requested_node"
    return 0
  fi

  local prefix="${requested_node#v}"
  prefix="${prefix%%[xX]*}"
  prefix="v${prefix}"
  [[ "$prefix" == *. ]] || prefix="${prefix}."
  curl -fsSL https://nodejs.org/dist/index.json |
    OPENCLAW_NODE_PREFIX="$prefix" python3 -c 'import json, os, sys
prefix = os.environ["OPENCLAW_NODE_PREFIX"]
for item in json.load(sys.stdin):
    version = item.get("version", "")
    if version.startswith(prefix):
        print(version)
        break
'
}

openclaw_node_download_platform() {
  local os_name arch_name
  os_name="$(uname -s)"
  arch_name="$(uname -m)"
  case "$os_name:$arch_name" in
    Linux:x86_64) printf 'linux-x64\n' ;;
    Linux:aarch64 | Linux:arm64) printf 'linux-arm64\n' ;;
    Darwin:x86_64) printf 'darwin-x64\n' ;;
    Darwin:arm64) printf 'darwin-arm64\n' ;;
    MINGW*:x86_64 | MSYS*:x86_64 | CYGWIN*:x86_64 | MINGW*:AMD64 | MSYS*:AMD64 | CYGWIN*:AMD64)
      printf 'win-x64\n'
      ;;
    MINGW*:aarch64 | MINGW*:arm64 | MSYS*:aarch64 | MSYS*:arm64 | CYGWIN*:aarch64 | CYGWIN*:arm64) printf 'win-arm64\n' ;;
    *)
      return 1
      ;;
  esac
}

openclaw_download_node() {
  local requested_node="$1"
  local version platform archive_url install_root temp_root
  version="$(openclaw_resolve_node_download_version "$requested_node")"
  platform="$(openclaw_node_download_platform)" || return 1
  temp_root="${RUNNER_TEMP:-/tmp}"
  if command -v cygpath >/dev/null 2>&1; then
    temp_root="$(cygpath -u "$temp_root" 2>/dev/null || printf '%s\n' "$temp_root")"
  fi
  install_root="${temp_root}/openclaw-node-${version}-${platform}"
  if [[ "$platform" == win-* ]]; then
    local archive_path ps_archive_path ps_install_root ps_bin_dir node_bin_dir
    archive_path="${temp_root}/node-${version}-${platform}.zip"
    archive_url="https://nodejs.org/dist/${version}/node-${version}-${platform}.zip"
    rm -rf "$install_root"
    mkdir -p "$install_root"
    echo "Downloading Node ${version} from ${archive_url}"
    curl -fsSL -o "$archive_path" "$archive_url"
    ps_archive_path="$archive_path"
    ps_install_root="$install_root"
    if command -v cygpath >/dev/null 2>&1; then
      ps_archive_path="$(cygpath -w "$archive_path")"
      ps_install_root="$(cygpath -w "$install_root")"
    fi
    ps_bin_dir="$ps_install_root\\node-${version}-${platform}"
    node_bin_dir="$install_root/node-${version}-${platform}"
    if command -v pwsh >/dev/null 2>&1; then
      pwsh -NoLogo -NoProfile -Command "Expand-Archive -LiteralPath '${ps_archive_path}' -DestinationPath '${ps_install_root}' -Force"
      openclaw_prepend_node_bin "$node_bin_dir" "$ps_bin_dir"
    elif command -v powershell.exe >/dev/null 2>&1; then
      powershell.exe -NoLogo -NoProfile -Command "Expand-Archive -LiteralPath '${ps_archive_path}' -DestinationPath '${ps_install_root}' -Force"
      openclaw_prepend_node_bin "$node_bin_dir" "$ps_bin_dir"
    else
      unzip -q "$archive_path" -d "$install_root"
      openclaw_prepend_node_bin "$node_bin_dir"
    fi
  else
    archive_url="https://nodejs.org/dist/${version}/node-${version}-${platform}.tar.xz"
    mkdir -p "$install_root"
    echo "Downloading Node ${version} from ${archive_url}"
    curl -fsSL "$archive_url" | tar -xJ -C "$install_root" --strip-components=1
    openclaw_prepend_node_bin "$install_root/bin"
  fi
}

openclaw_ensure_node() {
  local requested_node="${1:-}"
  requested_node="${requested_node#v}"
  if [[ -z "$requested_node" ]]; then
    return 0
  fi

  local active_node_version node_bin
  active_node_version="$(openclaw_active_node_version)"
  if openclaw_node_version_matches "$active_node_version" "$requested_node"; then
    echo "Using active Node ${active_node_version} at $(command -v node)"
    return 0
  fi

  node_bin="$(openclaw_find_toolcache_node "$requested_node" || true)"
  if [[ -n "$node_bin" ]]; then
    echo "Using Node $("$node_bin" -p 'process.versions.node') from $node_bin"
    openclaw_prepend_node_bin "$(dirname "$node_bin")"
  else
    openclaw_download_node "$requested_node" || true
  fi

  active_node_version="$(openclaw_active_node_version)"
  if ! openclaw_node_version_matches "$active_node_version" "$requested_node"; then
    echo "::error::Expected Node '${requested_node}', but active node is '${active_node_version:-missing}' at $(command -v node || true)"
    return 1
  fi
}
