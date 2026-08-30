#!/usr/bin/env bash
set -euo pipefail

# OpenClaw CLI installer (non-interactive, no onboarding)
# Usage: curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install-cli.sh | bash -s -- [--json] [--prefix <path>] [--version <ver>] [--node-version <ver>] [--onboard]

ensure_home_env() {
  if [[ -n "${HOME:-}" && "${HOME}" != "/" && -d "${HOME}" ]]; then
    return 0
  fi

  local user_name=""
  local home_dir=""
  user_name="$(id -un 2>/dev/null || true)"

  if [[ -n "$user_name" ]]; then
    if command -v getent >/dev/null 2>&1; then
      home_dir="$(getent passwd "$user_name" 2>/dev/null | awk -F: '{print $6; exit}' || true)"
    fi
    if [[ -z "$home_dir" && "$(uname -s 2>/dev/null || true)" == "Darwin" ]] && command -v dscl >/dev/null 2>&1; then
      home_dir="$(dscl . -read "/Users/${user_name}" NFSHomeDirectory 2>/dev/null | awk '{print $2; exit}' || true)"
    fi
  fi

  if [[ -n "$home_dir" && "$home_dir" != "/" && -d "$home_dir" ]]; then
    export HOME="$home_dir"
  fi
}

ensure_home_env

# Track temp paths so fail/exit paths do not leak mktemp dirs/files.
# Register paths in the caller: command substitutions run in a subshell, so
# array mutations inside a helper would not reach this shell.
TMPFILES=()
WRAPPER_BACKUP_TARGET=""
WRAPPER_BACKUP_PATH=""
cleanup_tmpfiles() {
  if [[ -n "$WRAPPER_BACKUP_PATH" && ( -e "$WRAPPER_BACKUP_PATH" || -L "$WRAPPER_BACKUP_PATH" ) ]]; then
    rm -f "$WRAPPER_BACKUP_TARGET" 2>/dev/null || true
    mv "$WRAPPER_BACKUP_PATH" "$WRAPPER_BACKUP_TARGET" 2>/dev/null || true
  fi
  local f
  for f in "${TMPFILES[@]:-}"; do
    rm -rf "$f" 2>/dev/null || true
  done
}
trap cleanup_tmpfiles EXIT

resolve_home_path() {
  local input="$1"
  case "$input" in
    \~) echo "$HOME" ;;
    \~/*) echo "${HOME}${input:1}" ;;
    *) echo "$input" ;;
  esac
}

INSTALLER_CWD="$(pwd -P)"
resolve_installer_path() {
  local input
  input="$(resolve_home_path "$1")"
  case "$input" in
    "") echo "" ;;
    /*) echo "$input" ;;
    *) echo "${INSTALLER_CWD}/${input}" ;;
  esac
}

OPENCLAW_EFFECTIVE_HOME="$(resolve_home_path "${OPENCLAW_HOME:-$HOME}")"
PREFIX="${OPENCLAW_PREFIX:-${HOME}/.openclaw}"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-latest}"
REQUIRED_COMPATIBLE_VERSION=""
DEFAULT_NODE_VERSION="24.19.0"
ARMV7_DEFAULT_NODE_VERSION="22.23.2"
NODE_VERSION="${OPENCLAW_NODE_VERSION:-${DEFAULT_NODE_VERSION}}"
NODE_VERSION_REQUESTED=0
if [[ -n "${OPENCLAW_NODE_VERSION:-}" ]]; then
  NODE_VERSION_REQUESTED=1
fi
MIN_NODE_22_VERSION="22.22.3"
MIN_NODE_24_VERSION="24.15.0"
MIN_NODE_25_VERSION="25.9.0"
SUPPORTED_NODE_VERSION_LABEL="Node 22.22.3+, Node 24.15.0+, or Node 25.9.0+"
NODE_RELEASE_VERSION_CORE=""
APK_NODE_BIN_DIR="/usr/bin"
NPM_LOGLEVEL="${OPENCLAW_NPM_LOGLEVEL:-error}"
INSTALL_METHOD="${OPENCLAW_INSTALL_METHOD:-npm}"
GIT_DIR="${OPENCLAW_GIT_DIR:-${OPENCLAW_EFFECTIVE_HOME}/openclaw}"
GIT_UPDATE="${OPENCLAW_GIT_UPDATE:-1}"
JSON=0
RUN_ONBOARD=0
SET_NPM_PREFIX=0
PNPM_CMD=()
GIT_REF_KIND=""
FRESH_GIT_MIN_FREE_KIB=$((6 * 1024 * 1024))

print_usage() {
  cat <<EOF
Usage: install-cli.sh [options]
  --json                              Emit NDJSON events (no human output)
  --prefix <path>                     Install prefix (default: ~/.openclaw; use \$OPENCLAW_PREFIX to override)
  --install-method, --method npm|git  Install via npm (default) or from a git checkout
  --npm                               Shortcut for --install-method npm
  --git, --github                     Shortcut for --install-method git
  --git-dir, --dir <path>             Checkout directory (default: ~/openclaw, or \$OPENCLAW_HOME/openclaw)
  --version <ver>                     OpenClaw version (default: latest)
  --compatible-with <ver>             Refuse a CLI that cannot modify config written by <ver>
  --node-version <ver>                Node version (default: 24.19.0; 22.23.2 on Linux ARMv7)
  --onboard                           Run "openclaw onboard" after install
  --no-onboard                        Skip onboarding (default)
  --set-npm-prefix                    Force npm prefix to ~/.npm-global if current prefix is not writable (Linux)

Environment variables:
  OPENCLAW_NPM_LOGLEVEL=error|warn|notice  Default: error (hide npm deprecation noise)
  OPENCLAW_INSTALL_METHOD=git|npm
  OPENCLAW_HOME=...
  OPENCLAW_PREFIX=...
  OPENCLAW_VERSION=latest|next|<semver>
  OPENCLAW_GIT_DIR=...
  OPENCLAW_GIT_UPDATE=0|1
EOF
}

log() {
  if [[ "$JSON" -eq 0 ]]; then
    echo "$@"
  fi
}

DOWNLOADER=""
detect_downloader() {
  if command -v curl >/dev/null 2>&1; then
    DOWNLOADER="curl"
    return 0
  fi
  if command -v wget >/dev/null 2>&1; then
    DOWNLOADER="wget"
    return 0
  fi
  fail "Missing downloader (curl or wget required)"
}

download_file() {
  local url="$1"
  local output="$2"
  if [[ -z "$DOWNLOADER" ]]; then
    detect_downloader
  fi
  if [[ "$DOWNLOADER" == "curl" ]]; then
    # Bound post-connect stalls without imposing a total download duration.
    curl -fsSL --proto '=https' --tlsv1.2 \
      --speed-limit 1 --speed-time 30 \
      --retry 3 --retry-delay 1 --retry-connrefused \
      -o "$output" "$url"
    return
  fi
  wget -q --https-only --secure-protocol=TLSv1_2 --tries=3 --timeout=20 -O "$output" "$url"
}

cleanup_legacy_submodules() {
  local repo_dir="${1:-${OPENCLAW_GIT_DIR:-${OPENCLAW_EFFECTIVE_HOME}/openclaw}}"
  local legacy_dir="${repo_dir}/Peekaboo"
  if [[ -d "$legacy_dir" ]]; then
    emit_json step name legacy-submodule status start path "$legacy_dir"
    log "Removing legacy submodule checkout: ${legacy_dir}"
    rm -rf "$legacy_dir"
    emit_json step name legacy-submodule status ok path "$legacy_dir"
  fi
}

sha256_file() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return 0
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return 0
  fi
  if command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$file" | awk '{print $NF}'
    return 0
  fi
  fail "Missing sha256 tool (need sha256sum, shasum, or openssl)"
}

JSON_STRING=""
quote_json_string() {
  local value="${1:-}"
  local char code escaped index
  # Byte iteration escapes every C0 control without rewriting valid UTF-8 bytes.
  # The final emitter can therefore guarantee one physical line per event.
  local LC_ALL=C

  JSON_STRING='"'
  for ((index = 0; index < ${#value}; index++)); do
    char="${value:index:1}"
    case "$char" in
      '"') JSON_STRING+='\"' ;;
      \\) JSON_STRING+="\\\\" ;;
      *)
        printf -v code '%d' "'$char"
        # Bash 3.2 reports high UTF-8 bytes as negative integers, not C0 controls.
        if ((code >= 0 && code < 32)); then
          printf -v escaped '\\u%04x' "$code"
          JSON_STRING+="$escaped"
        else
          JSON_STRING+="$char"
        fi
        ;;
    esac
  done
  JSON_STRING+='"'
}

emit_json() {
  if [[ "$JSON" -ne 1 ]]; then
    return 0
  fi

  local event="$1"
  local key value output
  shift
  quote_json_string "$event"
  output="{\"event\":${JSON_STRING}"
  # `ok` is the installer's only non-string event field and belongs to done.
  if [[ "$event" == "done" ]]; then
    output+=',"ok":true'
  fi
  while [[ $# -gt 0 ]]; do
    key="$1"
    value="$2"
    shift 2
    quote_json_string "$key"
    output+=",${JSON_STRING}:"
    quote_json_string "$value"
    output+="$JSON_STRING"
  done
  printf '%s}\n' "$output"
}

fail() {
  local msg="$1"
  emit_json error message "$msg"
  log "ERROR: $msg"
  exit 1
}

require_bin() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    fail "Missing required binary: $name"
  fi
}

available_disk_kib() {
  local target="$1"
  df -Pk "$target" 2>/dev/null | awk 'NR == 2 { print $4; exit }' || true
}

preflight_fresh_git_disk_space() {
  local repo_dir="$1"
  local ancestor
  local available_kib
  local available_gib

  if [[ -d "$repo_dir/.git" ]]; then
    return 0
  fi

  emit_json step name disk-space status start
  ancestor="$repo_dir"
  while [[ ! -e "$ancestor" ]]; do
    local parent
    parent="$(dirname "$ancestor")"
    if [[ "$parent" == "$ancestor" ]]; then
      break
    fi
    ancestor="$parent"
  done
  if [[ ! -d "$ancestor" ]]; then
    ancestor="$(dirname "$ancestor")"
  fi

  available_kib="$(available_disk_kib "$ancestor")"
  if [[ ! "$available_kib" =~ ^[0-9]+$ ]]; then
    emit_json step name disk-space status warn reason unreadable
    return 0
  fi
  if ((available_kib < FRESH_GIT_MIN_FREE_KIB)); then
    available_gib="$(awk -v kib="$available_kib" 'BEGIN { printf "%.1f", kib / 1048576 }')"
    fail "Fresh Git installs require at least 6 GiB of free disk space; only ${available_gib} GiB is available. Free disk space and retry."
  fi
  emit_json step name disk-space status ok
}

has_sudo() {
  command -v sudo >/dev/null 2>&1
}

is_root() {
  [[ "$(id -u)" -eq 0 ]]
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    emit_json step name git status ok
    return
  fi

  emit_json step name git status start
  log "Installing Git (required for npm installs)..."

  case "$(os_detect)" in
    linux)
      if command -v apt-get >/dev/null 2>&1; then
        if is_root; then
          apt-get update -y
          apt-get install -y git
        elif has_sudo; then
          sudo apt-get update -y
          sudo apt-get install -y git
        else
          fail "Git missing and sudo unavailable. Install git and retry."
        fi
      elif command -v dnf >/dev/null 2>&1; then
        if is_root; then
          dnf install -y git
        elif has_sudo; then
          sudo dnf install -y git
        else
          fail "Git missing and sudo unavailable. Install git and retry."
        fi
      elif command -v yum >/dev/null 2>&1; then
        if is_root; then
          yum install -y git
        elif has_sudo; then
          sudo yum install -y git
        else
          fail "Git missing and sudo unavailable. Install git and retry."
        fi
      elif command -v apk >/dev/null 2>&1; then
        if is_root; then
          apk add --no-cache git
        elif has_sudo; then
          sudo apk add --no-cache git
        else
          fail "Git missing and sudo unavailable. Install git and retry."
        fi
      else
        fail "Git missing and package manager not found. Install git and retry."
      fi
      ;;
    darwin)
      if command -v brew >/dev/null 2>&1; then
        brew install git
      else
        fail "Git missing. Install Xcode Command Line Tools or Homebrew Git, then retry."
      fi
      ;;
  esac

  if ! command -v git >/dev/null 2>&1; then
    fail "Git install failed. Install git manually and retry."
  fi

  emit_json step name git status ok
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --json)
        JSON=1
        shift
        ;;
      --prefix)
        if [[ $# -lt 2 || "${2:-}" == --* ]]; then
          fail "Missing value for $1"
        fi
        PREFIX="$2"
        shift 2
        ;;
      --version)
        if [[ $# -lt 2 || "${2:-}" == --* ]]; then
          fail "Missing value for $1"
        fi
        OPENCLAW_VERSION="$2"
        shift 2
        ;;
      --compatible-with)
        if [[ $# -lt 2 || "${2:-}" == --* ]]; then
          fail "Missing value for $1"
        fi
        REQUIRED_COMPATIBLE_VERSION="$2"
        shift 2
        ;;
      --node-version)
        if [[ $# -lt 2 || "${2:-}" == --* ]]; then
          fail "Missing value for $1"
        fi
        NODE_VERSION="$2"
        NODE_VERSION_REQUESTED=1
        shift 2
        ;;
      --install-method|--method)
        if [[ $# -lt 2 || "${2:-}" == --* ]]; then
          fail "Missing value for $1"
        fi
        INSTALL_METHOD="$2"
        shift 2
        ;;
      --npm)
        INSTALL_METHOD="npm"
        shift
        ;;
      --git|--github)
        INSTALL_METHOD="git"
        shift
        ;;
      --git-dir|--dir)
        if [[ $# -lt 2 || "${2:-}" == --* ]]; then
          fail "Missing value for $1"
        fi
        GIT_DIR="$2"
        shift 2
        ;;
      --no-git-update)
        GIT_UPDATE=0
        shift
        ;;
      --onboard)
        RUN_ONBOARD=1
        shift
        ;;
      --no-onboard)
        RUN_ONBOARD=0
        shift
        ;;
      --help|-h)
        print_usage
        exit 0
        ;;
      --set-npm-prefix)
        SET_NPM_PREFIX=1
        shift
        ;;
      *)
        fail "Unknown option: $1"
        ;;
    esac
  done
}

os_detect() {
  local os
  os="$(uname -s)"
  case "$os" in
    Darwin) echo "darwin" ;;
    Linux) echo "linux" ;;
    *) fail "Unsupported OS: $os" ;;
  esac
}

arch_detect() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    arm64|aarch64) echo "arm64" ;;
    armv7|armv7l) echo "armv7l" ;;
    x86_64|amd64) echo "x64" ;;
    *) fail "Unsupported architecture: $arch" ;;
  esac
}

select_node_version_for_platform() {
  local os="$1"
  local arch="$2"
  if [[ "$NODE_VERSION_REQUESTED" == "0" && "$os" == "linux" && "$arch" == "armv7l" ]]; then
    NODE_VERSION="$ARMV7_DEFAULT_NODE_VERSION"
  fi
  if [[ "$os" == "linux" && "$arch" == "armv7l" && "${NODE_VERSION%%.*}" != "22" ]]; then
    fail "Linux ARMv7 requires Node 22.22.3+ because official Node 24+ binaries are unavailable; use --node-version 22.23.2."
  fi
}

node_dir() {
  echo "${PREFIX}/tools/node-v${NODE_VERSION}"
}

node_bin() {
  echo "$(node_dir)/bin/node"
}

npm_bin() {
  echo "$(node_dir)/bin/npm"
}

command_path_without_node_prefix() {
  local name="$1"
  local path_entry
  local prefix_bin
  local filtered_path=""
  local separator=""
  local -a path_entries=()

  prefix_bin="$(node_dir)/bin"
  IFS=: read -r -a path_entries <<<"$PATH"
  for path_entry in "${path_entries[@]}"; do
    if [[ "$path_entry" == "$prefix_bin" ]]; then
      continue
    fi
    filtered_path="${filtered_path}${separator}${path_entry}"
    separator=":"
  done

  PATH="$filtered_path" command -v "$name" 2>/dev/null
}

is_musl_linux() {
  if [[ "$(os_detect)" != "linux" ]]; then
    return 1
  fi
  if [[ -f /etc/alpine-release ]]; then
    return 0
  fi
  ldd --version 2>&1 | grep -qi musl
}

link_node_runtime_paths() {
  local node_path="$1"
  local npm_path="$2"
  local dir
  local runtime_bin
  local resolved
  dir="$(node_dir)"
  runtime_bin="${node_path%/*}"

  mkdir -p "${dir}/bin" "${PREFIX}/tools"
  ln -sfn "$node_path" "${dir}/bin/node"
  ln -sfn "$npm_path" "${dir}/bin/npm"
  for name in npx corepack; do
    if [[ -x "${runtime_bin}/${name}" ]]; then
      ln -sfn "${runtime_bin}/${name}" "${dir}/bin/${name}"
      continue
    fi
    resolved="$(command_path_without_node_prefix "$name" || true)"
    if [[ -n "$resolved" && "$resolved" != "${dir}/bin/${name}" ]]; then
      ln -sfn "$resolved" "${dir}/bin/${name}"
    fi
  done
  ln -sfn "$dir" "${PREFIX}/tools/node"
}

linked_node_is_usable() {
  local candidate_bin
  local current_version
  local required_version

  if [[ ! -x "$(node_bin)" || ! -x "$(npm_bin)" ]]; then
    return 1
  fi

  current_version="$("$(node_bin)" -v 2>/dev/null || echo "")"
  required_version="$(required_node_version)"
  if ! node_release_version_is_supported "$current_version"; then
    return 1
  fi
  if ! semver_at_least "$NODE_RELEASE_VERSION_CORE" "$required_version"; then
    return 1
  fi
  candidate_bin="$(node_dir)/bin"
  if ! PATH="${candidate_bin}:${PATH}" "$(npm_bin)" --version >/dev/null 2>&1; then
    return 1
  fi

  "$(node_bin)" -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(":memory:");
    try {
      const value = db.prepare("SELECT sqlite_version() AS version").get()?.version;
      const match = typeof value === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(value) : null;
      const major = Number(match?.[1]);
      const minor = Number(match?.[2]);
      const patch = Number(match?.[3]);
      const safe =
        major > 3 ||
        (major === 3 &&
          (minor > 51 ||
            (minor === 51 && patch >= 3) ||
            (minor === 50 && patch >= 7) ||
            (minor === 44 && patch >= 6)));
      if (!safe) process.exitCode = 1;
    } finally {
      db.close();
    }
  ' >/dev/null 2>&1
}

linked_node_sqlite_version() {
  if [[ ! -x "$(node_bin)" ]]; then
    printf 'unavailable\n'
    return
  fi
  local version
  version="$("$(node_bin)" -e '
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(":memory:");
    try {
      process.stdout.write(String(db.prepare("SELECT sqlite_version() AS version").get()?.version ?? "unknown"));
    } finally {
      db.close();
    }
  ' 2>/dev/null || true)"
  printf '%s\n' "${version:-unavailable}"
}

semver_at_least() {
  local version="${1#v}"
  local required="${2#v}"
  local version_major version_minor version_patch
  local required_major required_minor required_patch

  IFS=. read -r version_major version_minor version_patch <<<"$version"
  IFS=. read -r required_major required_minor required_patch <<<"$required"
  version_minor="${version_minor:-0}"
  version_patch="${version_patch:-0}"
  required_minor="${required_minor:-0}"
  required_patch="${required_patch:-0}"

  for part in "$version_major" "$version_minor" "$version_patch" "$required_major" "$required_minor" "$required_patch"; do
    if [[ ! "$part" =~ ^[0-9]+$ ]]; then
      return 1
    fi
  done

  if ((version_major != required_major)); then
    ((version_major > required_major))
    return
  fi
  if ((version_minor != required_minor)); then
    ((version_minor > required_minor))
    return
  fi
  ((version_patch >= required_patch))
}

node_release_version_is_supported() {
  local version="$1"
  local major minor patch

  NODE_RELEASE_VERSION_CORE=""
  while [[ "$version" == [[:space:]]* ]]; do version="${version#?}"; done
  while [[ "$version" == *[[:space:]] ]]; do version="${version%?}"; done
  if [[ ! "$version" =~ ^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$ ]]; then
    return 1
  fi
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  patch="${BASH_REMATCH[3]}"
  for part in "$major" "$minor" "$patch"; do
    if ((${#part} > 16)) || ((${#part} == 16 && 10#$part > 9007199254740991)); then
      return 1
    fi
  done

  NODE_RELEASE_VERSION_CORE="${major}.${minor}.${patch}"
  node_version_is_supported "$NODE_RELEASE_VERSION_CORE"
}

# Download labels are plain numeric Node distribution versions. Installed
# runtimes use node_release_version_is_supported, which accepts canonical
# release labels with a leading v or build metadata.
node_version_is_supported() {
  local version="${1#v}"
  local major minor patch

  IFS=. read -r major minor patch <<<"$version"
  minor="${minor:-0}"
  patch="${patch:-0}"
  for part in "$major" "$minor" "$patch"; do
    if [[ ! "$part" =~ ^[0-9]+$ ]]; then
      return 1
    fi
  done

  if ((major == 22)); then
    semver_at_least "$version" "$MIN_NODE_22_VERSION"
    return
  fi
  if ((major == 24)); then
    semver_at_least "$version" "$MIN_NODE_24_VERSION"
    return
  fi
  if ((major == 25)); then
    semver_at_least "$version" "$MIN_NODE_25_VERSION"
    return
  fi
  ((major > 25))
}

required_node_version() {
  if [[ "$NODE_VERSION_REQUESTED" == "1" ]] && node_version_is_supported "$NODE_VERSION"; then
    printf '%s\n' "$NODE_VERSION"
    return
  fi
  printf '%s\n' "$MIN_NODE_22_VERSION"
}

try_link_usable_node_runtime_from_path() {
  local path_entry
  local prefix_bin
  local -a path_entries=()

  prefix_bin="$(node_dir)/bin"
  IFS=: read -r -a path_entries <<<"$PATH"
  for path_entry in "${path_entries[@]}"; do
    if [[ -z "$path_entry" ]]; then
      path_entry="."
    fi
    if [[ "$path_entry" == "$prefix_bin" ]]; then
      continue
    fi
    if [[ -x "${path_entry}/node" && -x "${path_entry}/npm" ]]; then
      link_node_runtime_paths "${path_entry}/node" "${path_entry}/npm"
      if linked_node_is_usable; then
        return 0
      fi
    fi
  done
  return 1
}

install_alpine_node() {
  local installed_version
  local required_version
  local sqlite_version

  emit_json step name node status start method apk
  if try_link_usable_node_runtime_from_path; then
    installed_version="$("$(node_bin)" -v 2>/dev/null || echo unknown)"
    emit_json step name node status ok method system version "$installed_version"
    return
  fi

  log "Installing Node via apk (Alpine Linux detected)..."
  if is_root; then
    apk add --no-cache nodejs npm
  elif has_sudo; then
    sudo apk add --no-cache nodejs npm
  else
    fail "Alpine Linux detected, but Node musl tarballs are unavailable and sudo is unavailable. Install nodejs and npm with apk, then retry."
  fi

  if [[ -x "${APK_NODE_BIN_DIR}/node" && -x "${APK_NODE_BIN_DIR}/npm" ]]; then
    link_node_runtime_paths "${APK_NODE_BIN_DIR}/node" "${APK_NODE_BIN_DIR}/npm"
  elif ! try_link_usable_node_runtime_from_path; then
    fail "apk Node install failed. Install nodejs and npm manually, then retry."
  fi

  if ! linked_node_is_usable; then
    installed_version="$("$(node_bin)" -v 2>/dev/null || echo unknown)"
    required_version="$(required_node_version)"
    sqlite_version="$(linked_node_sqlite_version)"
    fail "Alpine Node package must provide Node >= ${required_version} with WAL-reset-safe SQLite 3.51.3+, 3.50.7+ within 3.50.x, or 3.44.6+ within 3.44.x; found Node ${installed_version}, SQLite ${sqlite_version}."
  fi

  installed_version="$("$(node_bin)" -v 2>/dev/null || echo unknown)"
  emit_json step name node status ok method apk version "$installed_version"
}

set_pnpm_cmd() {
  PNPM_CMD=("$@")
}

run_pnpm() (
  local repo_dir="$PWD"
  if [[ "${1:-}" == "-C" ]]; then
    repo_dir="$2"
    shift 2
  fi
  cd "$repo_dir" || return 1
  # Pin nested commands and inherited roots only for this child. Corepack's
  # cold-cache prompt would otherwise wait invisibly in the version probe.
  env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 PATH="${PNPM_CMD[0]%/*}:$PATH" \
    NPM_CONFIG_WORKSPACE_DIR="$PWD" npm_config_workspace_dir="$PWD" \
    PNPM_CONFIG_LOCKFILE_DIR="$PWD" pnpm_config_lockfile_dir="$PWD" \
    "${PNPM_CMD[@]}" "$@"
)

should_prefer_offline_pnpm_install() {
  local project_dir="${1:-$PWD}"
  [[ -z "${PNPM_CONFIG_PREFER_OFFLINE+x}" && -z "${pnpm_config_prefer_offline+x}" ]] || return 1
  local configured=""
  configured="$(run_pnpm -C "$project_dir" config get prefer-offline 2>/dev/null)" || return 1
  [[ -z "$configured" || "$configured" == "undefined" || "$configured" == "null" ]]
}

to_lowercase_ascii() {
  printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'
}

is_openclaw_source_package_install_spec() {
  local value="${1:-}"
  local normalized_value=""
  normalized_value="$(to_lowercase_ascii "$value")"
  normalized_value="${normalized_value#openclaw@}"

  [[ "$normalized_value" == "main" ]] && return 0
  [[ "$normalized_value" =~ ^github:openclaw/openclaw($|[#/]) ]] && return 0

  normalized_value="${normalized_value#git+}"
  [[ "$normalized_value" =~ ^https?://github\.com/openclaw/openclaw(\.git)?($|[?#]) ]] && return 0
  [[ "$normalized_value" =~ ^ssh://git@github\.com[:/]openclaw/openclaw(\.git)?($|[?#]) ]] && return 0
  [[ "$normalized_value" =~ ^git://github\.com/openclaw/openclaw(\.git)?($|[?#]) ]] && return 0
  [[ "$normalized_value" =~ ^git@github\.com:openclaw/openclaw(\.git)?($|[?#]) ]] && return 0
  return 1
}

openclaw_version_is_compatible_with() {
  local candidate="$1"
  local config_writer="$2"

  "$(node_bin)" - "$candidate" "$config_writer" <<'NODE'
const candidateRaw = process.argv[2];
const writerRaw = process.argv[3];

function parse(raw) {
  let value = String(raw ?? "").trim();
  const legacyBeta = /^([vV]?\d+\.\d+\.\d+)\.beta(?:\.([0-9A-Za-z.-]+))?$/.exec(value);
  if (legacyBeta) {
    value = `${legacyBeta[1]}-beta${legacyBeta[2] ? `.${legacyBeta[2]}` : ""}`;
  }
  const match = /^[vV]?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/.exec(value);
  if (!match) return null;
  const parseIdentifiers = (rawIdentifiers) => {
    if (!rawIdentifiers) return [];
    const identifiers = rawIdentifiers.split(".");
    if (identifiers.some((identifier) => identifier.length === 0)) return null;
    return identifiers.map((identifier) => {
      if (!/^\d+$/.test(identifier)) return identifier;
      if (identifier.length > 1 && identifier.startsWith("0")) return null;
      return Number(identifier);
    });
  };
  const prerelease = parseIdentifiers(match[4]);
  const build = parseIdentifiers(match[5]);
  if (!prerelease || !build || prerelease.includes(null) || build.includes(null)) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease,
    build,
  };
}

function compareIdentifiers(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;
    if (typeof a === "number") return -1;
    if (typeof b === "number") return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

function isCorrection(version) {
  return version.prerelease.length === 1 && typeof version.prerelease[0] === "number";
}

function comparable(version) {
  if (!isCorrection(version)) return version;
  return { ...version, prerelease: [], build: [version.prerelease[0]] };
}

function compare(leftRaw, rightRaw) {
  const left = comparable(leftRaw);
  const right = comparable(rightRaw);
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] !== right.core[index]) {
      return left.core[index] < right.core[index] ? -1 : 1;
    }
  }
  if (left.prerelease.length === 0 && right.prerelease.length > 0) return 1;
  if (right.prerelease.length === 0 && left.prerelease.length > 0) return -1;
  const prereleaseOrder = compareIdentifiers(left.prerelease, right.prerelease);
  return prereleaseOrder === 0 ? compareIdentifiers(left.build, right.build) : prereleaseOrder;
}

const candidate = parse(candidateRaw);
const writer = parse(writerRaw);
if (!candidate || !writer) process.exit(2);
const sameCore = candidate.core.every((part, index) => part === writer.core[index]);
if (sameCore && (writer.prerelease.length === 0 || isCorrection(writer))) process.exit(0);
process.exit(compare(candidate, writer) < 0 ? 1 : 0);
NODE
}

require_openclaw_version_compatible() {
  local candidate="$1"
  local config_writer="${REQUIRED_COMPATIBLE_VERSION:-}"
  if [[ -z "$config_writer" ]]; then
    return 0
  fi

  if openclaw_version_is_compatible_with "$candidate" "$config_writer"; then
    return 0
  fi
  local status="$?"
  if [[ "$status" -eq 2 ]]; then
    fail "Cannot compare resolved OpenClaw version '${candidate}' with config writer '${config_writer}'."
  fi
  fail "OpenClaw ${candidate} is older than config writer ${config_writer}. Choose a newer CLI channel or retry after the channel is updated."
}

resolve_npm_openclaw_version() {
  local requested="$1"
  "$(npm_bin)" view "openclaw@${requested}" version 2>/dev/null | awk 'NF { value = $0 } END { print value }'
}

resolve_git_checkout_openclaw_version() {
  local repo_dir="$1"
  "$(node_bin)" -e '
    const fs = require("node:fs");
    const path = require("node:path");
    const value = JSON.parse(fs.readFileSync(path.join(process.argv[1], "package.json"), "utf8")).version;
    if (typeof value !== "string" || value.trim() === "") process.exit(1);
    process.stdout.write(value.trim());
  ' "$repo_dir"
}

resolve_git_openclaw_ref() {
  local requested="${OPENCLAW_VERSION:-latest}"
  local resolved_version=""

  case "$requested" in
    ""|latest)
      resolved_version="$("$(npm_bin)" view "openclaw" "dist-tags.${requested:-latest}" 2>/dev/null || true)"
      if [[ -n "$resolved_version" ]]; then
        echo "v${resolved_version}"
        return 0
      fi
      echo "main"
      return 0
      ;;
    next|beta)
      resolved_version="$("$(npm_bin)" view "openclaw" "dist-tags.${requested:-latest}" 2>/dev/null || true)"
      if [[ -n "$resolved_version" ]]; then
        echo "v${resolved_version}"
        return 0
      fi
      echo "$requested"
      return 0
      ;;
    main)
      echo "main"
      return 0
      ;;
    v[0-9]*)
      echo "$requested"
      return 0
      ;;
    [0-9]*.[0-9]*.[0-9]*)
      echo "v${requested}"
      return 0
      ;;
    *)
      echo "$requested"
      return 0
      ;;
  esac
}

verify_git_rebase_recovery() {
  local repo_dir="$1"
  local expected_head="$2"
  local expected_status="$3"
  local git_dir

  git_dir="$(git -C "$repo_dir" rev-parse --absolute-git-dir)" || return 1
  if [[ -d "$git_dir/rebase-merge" || -d "$git_dir/rebase-apply" ]]; then
    git -C "$repo_dir" rebase --abort >/dev/null 2>&1 || return 1
  fi

  [[ "$(git -C "$repo_dir" rev-parse --verify HEAD 2>/dev/null)" == "$expected_head" ]] &&
    [[ "$(git -C "$repo_dir" status --porcelain=v1 --untracked-files=all 2>/dev/null)" == "$expected_status" ]] &&
    [[ ! -d "$git_dir/rebase-merge" && ! -d "$git_dir/rebase-apply" ]]
}

checkout_git_openclaw_ref() {
  local repo_dir="$1"
  local ref="$2"
  local original_head=""
  local original_status=""
  local namespaces=(heads tags)

  GIT_REF_KIND=""

  if [[ -z "$ref" ]]; then
    return 0
  fi

  # Full commit IDs pin source bytes, even when a remote ref has the same name.
  # Bundled/existing checkouts already have the object and need no remote lookup.
  if [[ "$ref" =~ ^[[:xdigit:]]{40}$ ]]; then
    if ! git -C "$repo_dir" cat-file -e "$ref" 2>/dev/null; then
      git -C "$repo_dir" fetch --no-tags origin "$ref" ||
        fail "Could not fetch requested git commit: ${ref}"
    fi
    git -C "$repo_dir" rev-parse --verify --quiet "${ref}^{commit}" >/dev/null ||
      fail "Requested git version is not a commit: ${ref}"
    git -C "$repo_dir" checkout --detach "$ref"
    GIT_REF_KIND="immutable"
    return 0
  fi

  if [[ "$ref" == "main" ]]; then
    git -C "$repo_dir" fetch --no-tags origin "refs/heads/main:refs/remotes/origin/main"
    git -C "$repo_dir" checkout main
    if [[ "$GIT_UPDATE" == "1" ]]; then
      if ! original_head="$(git -C "$repo_dir" rev-parse --verify HEAD 2>/dev/null)"; then
        fail "Could not record repository state before updating from origin/main"
      fi
      if ! original_status="$(git -C "$repo_dir" status --porcelain=v1 --untracked-files=all 2>/dev/null)"; then
        fail "Could not record repository state before updating from origin/main"
      fi
      if ! git -C "$repo_dir" rebase origin/main; then
        if verify_git_rebase_recovery "$repo_dir" "$original_head" "$original_status"; then
          fail "Could not update repository from origin/main; the checkout was restored to its pre-update state"
        fi
        fail "Could not update repository from origin/main; checkout recovery was not verified. Run git -C \"$repo_dir\" rebase --abort and inspect the checkout before retrying"
      fi
    fi
    GIT_REF_KIND="moving"
    return 0
  fi

  # Normalized release selectors prefer immutable tags. A same-name branch
  # remains a fallback for operator-supplied v-prefixed branch names.
  if [[ "$ref" == v[0-9]* ]]; then
    namespaces=(tags heads)
  fi

  local namespace=""
  local probe_status=0
  for namespace in "${namespaces[@]}"; do
    if git -C "$repo_dir" ls-remote --exit-code origin "refs/${namespace}/${ref}" >/dev/null 2>&1; then
      if [[ "$namespace" == "heads" ]]; then
        git -C "$repo_dir" fetch --no-tags origin "refs/heads/${ref}:refs/remotes/origin/${ref}"
        git -C "$repo_dir" checkout -B "$ref" "origin/$ref"
        GIT_REF_KIND="moving"
      else
        git -C "$repo_dir" fetch --no-tags origin "refs/tags/${ref}:refs/tags/${ref}"
        git -C "$repo_dir" rev-parse --verify --quiet "refs/tags/${ref}^{commit}" >/dev/null ||
          fail "Requested git version is not a commit: ${ref}"
        git -C "$repo_dir" checkout --detach "refs/tags/${ref}"
        GIT_REF_KIND="immutable"
      fi
      return 0
    else
      probe_status=$?
    fi
    (( probe_status == 2 )) || fail "Could not resolve requested git ref: ${ref}"
  done

  fail "Requested git version not found: ${ref}"
}

git_install_lockfile_flag() {
  if [[ "$1" == "moving" ]]; then
    echo "--no-frozen-lockfile"
  else
    echo "--frozen-lockfile"
  fi
}

repo_pnpm_spec() {
  local repo_dir="$1"
  local package_json="${repo_dir}/package.json"

  if [[ ! -f "$package_json" ]]; then
    return 1
  fi

  "$(node_bin)" -e 'const fs = require("node:fs"); const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); if (typeof pkg.packageManager === "string") process.stdout.write(pkg.packageManager);' "$package_json"
}


install_node() {
  # Packaging provisions each requested architecture in a fresh private prefix.
  # It must execute that Node (Rosetta for x64 on ARM), never link the host runtime.
  local os="$1"
  local arch="$2"
  local url
  local tmp
  local dir
  local base_url
  local tarball
  local expected_sha
  local actual_sha

  select_node_version_for_platform "$os" "$arch"
  if ! node_version_is_supported "$NODE_VERSION"; then
    fail "Node ${NODE_VERSION} is unsupported; use ${SUPPORTED_NODE_VERSION_LABEL}."
  fi
  dir="$(node_dir)"

  if [[ "$os" == "linux" ]] && command -v apk >/dev/null 2>&1 && is_musl_linux; then
    install_alpine_node
    return
  fi

  if linked_node_is_usable; then
    emit_json step name node status skip path "$dir"
    return
  fi

  emit_json step name node status start version "$NODE_VERSION"
  log "Installing Node ${NODE_VERSION} (user-space)..."

  mkdir -p "${PREFIX}/tools"
  tmp="$(mktemp -d)"
  TMPFILES+=("$tmp")
  base_url="https://nodejs.org/dist/v${NODE_VERSION}"
  tarball="node-v${NODE_VERSION}-${os}-${arch}.tar.gz"
  url="${base_url}/${tarball}"

  detect_downloader
  require_bin tar

  download_file "${base_url}/SHASUMS256.txt" "$tmp/SHASUMS256.txt"
  expected_sha="$(grep "  ${tarball}$" "$tmp/SHASUMS256.txt" | awk '{print $1}' | head -n 1 || true)"
  if [[ -z "${expected_sha}" ]]; then
    fail "Failed to resolve Node shasum for ${tarball}"
  fi

  download_file "$url" "$tmp/node.tgz"
  actual_sha="$(sha256_file "$tmp/node.tgz")"
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    fail "Node tarball sha256 mismatch for ${tarball} (expected ${expected_sha}, got ${actual_sha})"
  fi

  rm -rf "$dir"
  mkdir -p "$dir"
  tar -xzf "$tmp/node.tgz" -C "$dir" --strip-components=1
  rm -rf "$tmp"

  ln -sfn "$dir" "${PREFIX}/tools/node"

  if ! linked_node_is_usable; then
    local installed_version
    local required_version
    local sqlite_version
    installed_version="$("$(node_bin)" -v 2>/dev/null || echo unknown)"
    required_version="$(required_node_version)"
    sqlite_version="$(linked_node_sqlite_version)"
    fail "Installed Node ${NODE_VERSION} must provide Node >= ${required_version} with WAL-reset-safe SQLite; found Node ${installed_version}, SQLite ${sqlite_version}. Re-run with --node-version 24.19.0 (or newer)"
  fi
  emit_json step name node status ok version "$NODE_VERSION"
}

ensure_pnpm() {
  local repo_dir="${1:-$PWD}"
  local spec version pnpm_dir corepack_cmd="" npm_cmd lifecycle_arg selected_version
  spec="$(repo_pnpm_spec "$repo_dir" || true)"
  [[ "$spec" == pnpm@* ]] || spec="pnpm@12.1.0"
  version="${spec#pnpm@}"
  version="${version%%+*}"
  pnpm_dir="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-pnpm.XXXXXX")" || return 1
  TMPFILES+=("$pnpm_dir")
  if [[ -x "$(node_dir)/bin/corepack" ]]; then
    corepack_cmd="$(node_dir)/bin/corepack"
  else
    corepack_cmd="$(command -v corepack || true)"
  fi
  if [[ -n "$corepack_cmd" ]]; then
    emit_json step name pnpm status start method corepack
    log "Selecting repo pnpm ${version} via Corepack..."
    set_pnpm_cmd "$pnpm_dir/pnpm"
    if "$corepack_cmd" enable --install-directory "$pnpm_dir" pnpm &&
      selected_version="$(run_pnpm -C "$repo_dir" --version 2>/dev/null)" &&
      [[ "$selected_version" == "$version" ]]; then
      emit_json step name pnpm status ok
      return 0
    fi
    log "Corepack could not provision pnpm; falling back to npm."
  fi

  emit_json step name pnpm status start method npm
  log "Installing pnpm ${version} via npm..."
  npm_cmd="$(npm_bin)"
  lifecycle_arg="$(npm_lifecycle_allow_arg "$npm_cmd" "pnpm@${version}" "$repo_dir" "pnpm@${version}")" || return 1
  # The explicit npm prefix owns this executable; never rediscover ambient pnpm.
  "$npm_cmd" install -g --prefix "$pnpm_dir/npm" "pnpm@${version}" ${lifecycle_arg:+"$lifecycle_arg"} || return 1
  set_pnpm_cmd "$pnpm_dir/npm/bin/pnpm"
  if [[ ! -x "${PNPM_CMD[0]}" ]] || ! selected_version="$(run_pnpm -C "$repo_dir" --version 2>/dev/null)" || [[ "$selected_version" != "$version" ]]; then
    fail "Could not provision pnpm ${version} for ${repo_dir}"
  fi
  emit_json step name pnpm status ok
}

fix_npm_prefix_if_needed() {
  # only meaningful on Linux, non-root installs
  if [[ "$(os_detect)" != "linux" ]]; then
    return
  fi

  local prefix
  prefix="$("$(npm_bin)" config get prefix 2>/dev/null || true)"
  if [[ -z "$prefix" ]]; then
    return
  fi

  if [[ -w "$prefix" || -w "${prefix}/lib" ]]; then
    return
  fi

  local target="${HOME}/.npm-global"
  mkdir -p "$target"
  "$(npm_bin)" config set prefix "$target"

  local path_line="export PATH=\\\"${target}/bin:\\$PATH\\\""
  for rc in "${HOME}/.bashrc" "${HOME}/.zshrc"; do
    if [[ -f "$rc" ]] && ! grep -q ".npm-global" "$rc"; then
      echo "$path_line" >> "$rc"
    fi
  done

  export PATH="${target}/bin:${PATH}"
  emit_json step name npm-prefix status ok prefix "$target"
  log "Configured npm prefix to ${target}"
}

resolve_npm_config_path() {
  local raw="$1"
  if [[ -z "$raw" || "$raw" == "null" || "$raw" == "undefined" ]]; then
    return 1
  fi
  if [[ "$raw" == \~/* && -n "${HOME:-}" ]]; then
    printf '%s\n' "${HOME}/${raw#"~/"}"
    return 0
  fi
  if [[ "$raw" == "\${HOME}/"* && -n "${HOME:-}" ]]; then
    printf '%s\n' "${HOME}/${raw#"\${HOME}/"}"
    return 0
  fi
  printf '%s\n' "$raw"
}

npm_config_file_has_key() {
  local file="$1"
  local key="$2"
  [[ -f "$file" ]] || return 1
  grep -Eiq "^[[:space:]]*${key}[[:space:]]*=" "$file"
}

npm_command_path() {
  local npm_cmd="$1"
  local npm_path="$npm_cmd"
  if [[ "$npm_path" != */* ]]; then
    npm_path="$(command -v "$npm_cmd" 2>/dev/null)" || return 1
  fi
  if command -v node >/dev/null 2>&1; then
    node -e 'const fs = require("node:fs"); console.log(fs.realpathSync(process.argv[1]));' "$npm_path" 2>/dev/null && return 0
  fi
  printf '%s\n' "$npm_path"
}

npm_builtin_config_path() {
  local npm_cmd="$1"
  local npm_path
  npm_path="$(npm_command_path "$npm_cmd")" || return 1
  local npm_root
  npm_root="$(cd "$(dirname "$npm_path")/.." >/dev/null 2>&1 && pwd -P)" || return 1
  printf '%s\n' "${npm_root}/npmrc"
}

npm_config_has_raw_key() {
  local npm_cmd="$1"
  local key="$2"
  local project_dir="${3:-}"
  local raw=""
  local file=""
  local -a files=()

  if [[ -n "$project_dir" ]]; then
    files+=("${project_dir}/.npmrc")
  fi

  raw="${NPM_CONFIG_USERCONFIG:-${npm_config_userconfig:-}}"
  if [[ -n "$raw" ]]; then
    file="$(resolve_npm_config_path "$raw" 2>/dev/null || true)"
    [[ -n "$file" ]] && files+=("$file")
  elif [[ -n "${HOME:-}" ]]; then
    files+=("${HOME}/.npmrc")
  fi

  raw="${NPM_CONFIG_GLOBALCONFIG:-${npm_config_globalconfig:-}}"
  if [[ -n "$raw" ]]; then
    file="$(resolve_npm_config_path "$raw" 2>/dev/null || true)"
    [[ -n "$file" ]] && files+=("$file")
  fi

  raw="$(env -u NPM_CONFIG_BEFORE -u npm_config_before -u NPM_CONFIG_MIN_RELEASE_AGE -u npm_config_min_release_age -u npm_config_min-release-age "$npm_cmd" config get globalconfig --global 2>/dev/null || true)"
  file="$(resolve_npm_config_path "$raw" 2>/dev/null || true)"
  [[ -n "$file" ]] && files+=("$file")

  file="$(npm_builtin_config_path "$npm_cmd" 2>/dev/null || true)"
  [[ -n "$file" ]] && files+=("$file")

  for file in "${files[@]}"; do
    if npm_config_file_has_key "$file" "$key"; then
      return 0
    fi
  done
  return 1
}

npm_lifecycle_allow_arg() {
  local npm_cmd="$1" spec="$2" npm_cwd="${3:-$PWD}" exact_identity="${4:-}" version="" output=""
  if ! version="$("$npm_cmd" --version 2>/dev/null)"; then
    log "ERROR: unable to determine npm version; no package changes were made"
    return 1
  fi
  output="$("$(node_bin)" - "$version" "$spec" "$npm_cwd" "$exact_identity" <<'NODE'
const path = require("node:path");
const [versionOutput, spec, cwd, exactIdentity] = process.argv.slice(2);
const version = versionOutput.trim().split(/\r?\n/).at(-1) ?? "";
const parsed = version.match(/^[vV]?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
const fail = (message) => { process.stderr.write(`${message}\n`); process.exit(1); };
if (!parsed) fail("Unable to determine npm version; no package changes were made.");
if (+parsed[1] < 12 && (+parsed[1] !== 11 || +parsed[2] < 16)) process.exit(0);
const normalized = spec.trim();
const unaliased = normalized.toLowerCase().startsWith("openclaw@") ? normalized.slice(9).trim() : normalized;
const explicit = (value) => /\.(?:tgz|tar\.gz)$/i.test(value) || value.includes("://") || value.includes("#") || /^(?:file|github|git\+(?:ssh|https|http|file)|npm):/i.test(value);
let identity = !normalized || explicit(normalized) || explicit(unaliased) || /^\.{1,2}(?:[\\/]|$)/.test(unaliased) || path.isAbsolute(normalized) || path.isAbsolute(unaliased) ? unaliased : "openclaw";
if (/^npm:/i.test(identity)) identity = /^npm:(@[^/]+\/[^@]+|[^@]+?)(?:@.*)?$/i.exec(identity)?.[1] ?? "";
const relative = cwd && path.isAbsolute(identity) ? path.relative(cwd, identity) || "." : "";
if (relative) identity = path.isAbsolute(relative) || relative === "." || relative === ".." || relative.startsWith(`..${path.sep}`) ? relative : `.${path.sep}${relative}`;
if (exactIdentity) identity = exactIdentity;
if (!identity || identity.includes(",")) fail(`npm cannot allow lifecycle scripts for install target '${spec}'.`);
process.stdout.write(`--allow-scripts=${identity}\n`);
NODE
)" || return 1
  printf '%s' "$output"
}

publish_executable_wrapper() {
  local target="$1" target_dir="" temp="" backup=""
  target_dir="${target%/*}"
  mkdir -p "$target_dir"
  temp="$(mktemp "${target_dir}/.openclaw-wrapper.XXXXXX")" || return 1
  TMPFILES+=("$temp")
  cat > "$temp"
  chmod +x "$temp"
  if [[ -z "$WRAPPER_BACKUP_PATH" && ( -e "$target" || -L "$target" ) ]]; then
    backup="$(mktemp "${target}.backup.XXXXXX")" || return 1
    rm -f "$backup" || return 1
    mv "$target" "$backup" || return 1
    WRAPPER_BACKUP_TARGET="$target"
    WRAPPER_BACKUP_PATH="$backup"
  fi
  mv -f "$temp" "$target"
}

commit_wrapper_backup() {
  [[ -z "$WRAPPER_BACKUP_PATH" ]] || rm -f "$WRAPPER_BACKUP_PATH" || return 1
  WRAPPER_BACKUP_TARGET=""
  WRAPPER_BACKUP_PATH=""
}

install_openclaw() {
  local requested="${OPENCLAW_VERSION:-latest}"
  if is_openclaw_source_package_install_spec "$requested"; then
    fail "npm installs do not support OpenClaw GitHub source targets like '${requested}'. Use --install-method git --version main, latest, beta, an exact version, or a built .tgz package."
  fi
  local freshness_flag="--min-release-age=0"
  local min_release_age=""
  min_release_age="$(env -u NPM_CONFIG_BEFORE -u npm_config_before "$(npm_bin)" config get min-release-age --global 2>/dev/null || true)"
  if npm_config_has_raw_key "$(npm_bin)" "min-release-age"; then
    freshness_flag="--min-release-age=0"
  elif [[ -z "$min_release_age" || "$min_release_age" == "null" || "$min_release_age" == "undefined" ]]; then
    local before_value=""
    before_value="$(env -u NPM_CONFIG_MIN_RELEASE_AGE -u npm_config_min_release_age -u npm_config_min-release-age "$(npm_bin)" config get before --global 2>/dev/null || true)"
    if [[ -n "$before_value" && "$before_value" != "null" && "$before_value" != "undefined" ]]; then
      freshness_flag="--before=$(date -u '+%Y-%m-%dT%H:%M:%S.000Z')"
    fi
  fi
  local npm_args=(
    --loglevel "$NPM_LOGLEVEL"
    --no-fund
    --no-audit
    "$freshness_flag"
  )
  local resolved_requested="$requested"
  if [[ -n "${REQUIRED_COMPATIBLE_VERSION:-}" ]]; then
    resolved_requested="$(resolve_npm_openclaw_version "$requested")"
    if [[ -z "$resolved_requested" ]]; then
      fail "Could not resolve OpenClaw ${requested} before compatibility checking."
    fi
    require_openclaw_version_compatible "$resolved_requested"
  fi
  local install_spec="openclaw@${resolved_requested}"
  if [[ "$resolved_requested" == *"://"* || "$resolved_requested" == /* || "$resolved_requested" == ./* || "$resolved_requested" == ../* || "$resolved_requested" =~ ^(file|github|git\+|npm): || "$resolved_requested" =~ \.(tgz|tar\.gz)$ ]]; then
    install_spec="$resolved_requested"
  fi
  local npm_cmd="" lifecycle_arg=""
  npm_cmd="$(npm_bin)"
  local npm_cwd="$PWD"
  lifecycle_arg="$(npm_lifecycle_allow_arg "$npm_cmd" "$install_spec" "$npm_cwd")" || return 1
  emit_json step name openclaw status start version "$requested"
  log "Installing OpenClaw (${requested})..."
  if [[ "$SET_NPM_PREFIX" -eq 1 ]]; then
    fix_npm_prefix_if_needed
  fi

  local installed_entry install_guard
  installed_entry="$(node_dir)/lib/node_modules/openclaw/dist/entry.js"
  install_guard="$(node_dir)/lib/node_modules/openclaw/dist/openclaw-install-guard"
  local npm_install_args=(install -g --prefix "$(node_dir)" "${npm_args[@]}")
  [[ -z "$lifecycle_arg" ]] || npm_install_args+=("$lifecycle_arg")
  npm_install_args+=("$install_spec")
  if ! env -u NPM_CONFIG_BEFORE -u npm_config_before -u NPM_CONFIG_MIN_RELEASE_AGE -u npm_config_min_release_age -u npm_config_min-release-age "$npm_cmd" "${npm_install_args[@]}" || [[ ! -f "$installed_entry" || -e "$install_guard" ]]; then
    log "npm install openclaw@${resolved_requested} did not produce a usable package; retrying once"
    if ! env -u NPM_CONFIG_BEFORE -u npm_config_before -u NPM_CONFIG_MIN_RELEASE_AGE -u npm_config_min_release_age -u npm_config_min-release-age "$npm_cmd" "${npm_install_args[@]}" || [[ ! -f "$installed_entry" || -e "$install_guard" ]]; then
      emit_json error message "npm install did not produce a usable OpenClaw package"
      log "ERROR: npm install did not produce a usable OpenClaw package"
      return 1
    fi
  fi

  mkdir -p "${PREFIX}/bin"
  publish_executable_wrapper "${PREFIX}/bin/openclaw" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "${PREFIX}/tools/node/bin/node" "$(node_dir)/lib/node_modules/openclaw/dist/entry.js" "\$@"
EOF
  emit_json step name openclaw status ok version "$requested"
}

ensure_pnpm_git_prepare_allowlist() {
  local repo_dir="$1"
  local workspace_file="${repo_dir}/pnpm-workspace.yaml"
  local dep="@tloncorp/api"
  local tmp

  if [[ -f "$workspace_file" ]] && ! grep -Fq "\"${dep}\"" "$workspace_file" && ! grep -Fq "${dep}:" "$workspace_file" && ! grep -Fq -- "- ${dep}" "$workspace_file"; then
    tmp="$(mktemp)"
    TMPFILES+=("$tmp")
    if grep -q '^allowBuilds:[[:space:]]*$' "$workspace_file"; then
      awk -v dep="$dep" '
        BEGIN { inserted = 0 }
        {
          print
          if (!inserted && $0 ~ /^allowBuilds:[[:space:]]*$/) {
            print "  \"" dep "\": true"
            inserted = 1
          }
        }
      ' "$workspace_file" >"$tmp"
    else
      cat "$workspace_file" >"$tmp"
      printf '\nallowBuilds:\n  "%s": true\n' "$dep" >>"$tmp"
    fi
    mv "$tmp" "$workspace_file"
  elif [[ ! -f "$workspace_file" ]]; then
    printf 'allowBuilds:\n  "%s": true\n' "$dep" >"$workspace_file"
  fi

  log "Updated pnpm allowlist for git-hosted build dependency: ${dep}"
}

clone_git_checkout_transactionally() {
  local repo_url="$1"
  local repo_dir="$2"

  local parent_dir staging_dir clone_status=0 preserve_repo_dir=0
  parent_dir="$(dirname "$repo_dir")"
  mkdir -p "$parent_dir"
  parent_dir="$(cd "$parent_dir" && pwd -P)"
  if [[ -d "$repo_dir" && -z "$(ls -A "$repo_dir" 2>/dev/null || true)" ]]; then
    preserve_repo_dir=1
    repo_dir="$(cd "$repo_dir" && pwd -P)"
    staging_dir="$(mktemp -d "${repo_dir}/.openclaw-clone.XXXXXX")"
  else
    repo_dir="${parent_dir}/$(basename "$repo_dir")"
    staging_dir="$(mktemp -d "${parent_dir}/.openclaw-clone.XXXXXX")"
  fi
  TMPFILES+=("$staging_dir")

  # Blobless partial clone: the dev checkout only needs current files plus pullable
  # history refs; full multi-gigabyte blob history would dominate install time.
  git clone --filter=blob:none "$repo_url" "$staging_dir" || clone_status=$?
  if [[ "$clone_status" -ne 0 ]]; then
    return "$clone_status"
  fi

  if ! node - "$staging_dir" "$repo_dir" "$preserve_repo_dir" <<'NODE'
const fs = require("node:fs");
const [source, target, preserveTarget] = process.argv.slice(2);
if (preserveTarget === "0") {
  try {
    fs.lstatSync(target);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    fs.renameSync(source, target);
    process.exit(0);
  }
  throw new Error(`Git install dir appeared while cloning: ${target}`);
}
const expected = preserveTarget === "1" ? [source.slice(source.lastIndexOf("/") + 1)] : [];
if (!fs.statSync(target).isDirectory() || fs.readdirSync(target).sort().join("\0") !== expected.sort().join("\0")) {
  throw new Error(`Git install dir appeared while cloning: ${target}`);
}
const entries = fs.readdirSync(source).sort((a, b) => (a === ".git" ? 1 : b === ".git" ? -1 : 0));
const moved = [];
try {
  for (const entry of entries) {
    fs.renameSync(`${source}/${entry}`, `${target}/${entry}`);
    moved.push(entry);
  }
  fs.rmdirSync(source);
} catch (error) {
  const rollbackErrors = [];
  for (const entry of moved.reverse()) {
    try {
      fs.renameSync(`${target}/${entry}`, `${source}/${entry}`);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
  }
  if (rollbackErrors.length > 0) {
    let recovery = source;
    try {
      recovery = `${source}.recovery`;
      fs.renameSync(source, recovery);
    } catch (recoveryError) {
      rollbackErrors.push(recoveryError);
      recovery = source;
    }
    throw new AggregateError(
      [error, ...rollbackErrors],
      `Could not publish or fully roll back the cloned checkout at ${target}; recovery files remain at ${recovery}`,
    );
  }
  throw error;
}
NODE
  then
    fail "Could not publish the cloned checkout: ${repo_dir}. Inspect the destination for partial files, move it or choose another --git-dir, then retry."
  fi
}

install_openclaw_from_git() {
  local repo_dir="$1"
  local repo_url="https://github.com/openclaw/openclaw.git"
  local fresh_checkout=0

  if [[ -z "$repo_dir" ]]; then
    fail "Git install dir cannot be empty"
  fi
  mkdir -p "$(dirname "$repo_dir")"
  if [[ -d "$repo_dir" ]]; then
    repo_dir="$(cd "$repo_dir" && pwd -P)"
  else
    repo_dir="$(cd "$(dirname "$repo_dir")" && pwd -P)/$(basename "$repo_dir")"
  fi

  emit_json step name openclaw status start method git repo "$repo_url"
  if [[ -d "$repo_dir/.git" ]]; then
    log "Installing Openclaw from git checkout: ${repo_dir}"
  else
    log "Installing Openclaw from GitHub (${repo_url})..."
  fi

  emit_json step name git-tools status start
  ensure_git
  emit_json step name git-tools status ok

  if [[ -d "$repo_dir/.git" ]] &&
    ! git --git-dir="$repo_dir/.git" --work-tree="$repo_dir" rev-parse --verify --quiet 'HEAD^{commit}' >/dev/null 2>&1; then
    fail "Git checkout has no commit: ${repo_dir}. Move or remove this incomplete checkout, then retry."
  fi

  if [[ -d "$repo_dir/.git" ]]; then
    :
  elif [[ -d "$repo_dir" ]]; then
    if [[ -z "$(ls -A "$repo_dir" 2>/dev/null || true)" ]]; then
      emit_json step name git-clone status start
      clone_git_checkout_transactionally "$repo_url" "$repo_dir"
      emit_json step name git-clone status ok
      fresh_checkout=1
    else
      fail "Git install dir exists but is not a git repo: ${repo_dir}"
    fi
  else
    emit_json step name git-clone status start
    clone_git_checkout_transactionally "$repo_url" "$repo_dir"
    emit_json step name git-clone status ok
    fresh_checkout=1
  fi

  local git_ref
  git_ref="$(resolve_git_openclaw_ref)"
  if [[ -z "$(git -C "$repo_dir" status --porcelain 2>/dev/null || true)" ]]; then
    log "Using git ref: ${git_ref}"
    if [[ "$fresh_checkout" -eq 0 ]]; then
      emit_json step name git-update status start
    fi
    checkout_git_openclaw_ref "$repo_dir" "$git_ref"
    if [[ "$fresh_checkout" -eq 0 ]]; then
      emit_json step name git-update status ok
    fi
  else
    log "Repo is dirty; skipping git checkout/update"
    emit_json step name git-update status warn reason dirty
    if git -C "$repo_dir" symbolic-ref --quiet HEAD >/dev/null; then
      GIT_REF_KIND="moving"
    else
      GIT_REF_KIND="immutable"
    fi
  fi

  if [[ -n "${REQUIRED_COMPATIBLE_VERSION:-}" ]]; then
    local resolved_version
    resolved_version="$(resolve_git_checkout_openclaw_version "$repo_dir" 2>/dev/null || true)"
    if [[ -z "$resolved_version" ]]; then
      fail "Could not resolve the Git checkout version before compatibility checking."
    fi
    require_openclaw_version_compatible "$resolved_version"
  fi

  cleanup_legacy_submodules "$repo_dir"
  ensure_pnpm_git_prepare_allowlist "$repo_dir"
  ensure_pnpm "$repo_dir"

  local install_lockfile_flag
  install_lockfile_flag="$(git_install_lockfile_flag "$GIT_REF_KIND")"
  local -a pnpm_prefer_offline_args=()
  if should_prefer_offline_pnpm_install "$repo_dir"; then
    pnpm_prefer_offline_args=(--prefer-offline)
  fi
  emit_json step name dependencies status start
  CI="${CI:-true}" run_pnpm -C "$repo_dir" install "${pnpm_prefer_offline_args[@]}" "$install_lockfile_flag"
  emit_json step name dependencies status ok

  emit_json step name control-ui status start
  if ! run_pnpm -C "$repo_dir" ui:build; then
    log "UI build failed; continuing (CLI may still work)"
    emit_json step name control-ui status warn
  else
    emit_json step name control-ui status ok
  fi
  emit_json step name cli-build status start
  run_pnpm -C "$repo_dir" build
  emit_json step name cli-build status ok

  mkdir -p "${PREFIX}/bin"
  publish_executable_wrapper "${PREFIX}/bin/openclaw" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "${PREFIX}/tools/node/bin/node" "${repo_dir}/dist/entry.js" "\$@"
EOF
  emit_json step name openclaw status ok method git
}

is_gateway_daemon_loaded() {
  local claw="$1"
  if [[ -z "$claw" || ! -x "$claw" ]]; then
    return 1
  fi

  local status_json=""
  # Unlike daemon status, gateway status reports service.loaded during pending migrations.
  status_json="$("$claw" gateway status --json 2>/dev/null || true)"
  if [[ -z "$status_json" ]]; then
    return 1
  fi

  # Managed installs must parse with their provisioned Node even when the system has none.
  local node_bin="${PREFIX}/tools/node/bin/node"
  if [[ ! -x "$node_bin" ]]; then
    if command -v node >/dev/null 2>&1; then
      node_bin="$(command -v node)"
    else
      # Approximate POSIX-safe fallback when neither managed nor system Node is available.
      printf '%s\n' "$status_json" | grep -Eq '"loaded"[[:space:]]*:[[:space:]]*true'
      return
    fi
  fi

  printf '%s' "$status_json" | "$node_bin" -e '
const fs = require("fs");
const raw = fs.readFileSync(0, "utf8").trim();
if (!raw) process.exit(1);
try {
  const data = JSON.parse(raw);
  process.exit(data?.service?.loaded ? 0 : 1);
} catch {
  process.exit(1);
}
' >/dev/null 2>&1
}

refresh_gateway_service_if_loaded() {
  local claw="${PREFIX}/bin/openclaw" refresh_output
  if [[ ! -x "$claw" ]]; then
    return 0
  fi

  if ! is_gateway_daemon_loaded "$claw"; then
    emit_json step name gateway-service status skip reason not-loaded
    return 0
  fi

  emit_json step name gateway-service status start
  log "Refreshing loaded gateway service..."

  if ! refresh_output="$({ set +x; "$claw" gateway install --force; } 2>&1 | sed -n -e 's/.*SERVICE_DEFINITION_SEALED:.*/ask the privileged deployment owner to manually repair it/p' -e 's/.*SERVICE_DEFINITION_UNKNOWN:.*/inspect service-definition access and manually repair it/p')"; then
    if [[ -n "$refresh_output" ]]; then
      emit_json step name gateway-service status warn reason definition-mutation-denied
      printf '%s\n' "Code installed; gateway service definition left unchanged; ${refresh_output}." >&2
      printf '%s\n' "Run openclaw gateway status --deep, verify the installation owner, and restart it manually if needed." >&2
      return 0
    fi
    emit_json step name gateway-service status warn reason install-failed
    log "Warning: gateway service refresh failed; continuing."
    return 0
  fi

  # `gateway install --force` activates the replacement service. A second
  # restart can kill startup migrations and strand their lock until expiry.
  "$claw" gateway status --probe --json >/dev/null 2>&1 || true
  emit_json step name gateway-service status ok
}

main() {
  parse_args "$@"
  PREFIX="$(resolve_installer_path "$PREFIX")"
  GIT_DIR="$(resolve_installer_path "$GIT_DIR")"

  if [[ "${OPENCLAW_NO_ONBOARD:-0}" == "1" ]]; then
    RUN_ONBOARD=0
  fi

  if [[ "$INSTALL_METHOD" == "git" ]]; then
    preflight_fresh_git_disk_space "$GIT_DIR"
  fi

  select_node_version_for_platform "$(os_detect)" "$(arch_detect)"
  PATH="$(node_dir)/bin:${PREFIX}/bin:${PATH}"
  export PATH

  install_node "$(os_detect)" "$(arch_detect)"
  if [[ "$INSTALL_METHOD" == "git" ]]; then
    install_openclaw_from_git "$GIT_DIR"
  elif [[ "$INSTALL_METHOD" == "npm" ]]; then
    ensure_git
    if [[ "$SET_NPM_PREFIX" -eq 1 ]]; then
      fix_npm_prefix_if_needed
    fi
    install_openclaw
  else
    fail "Unknown install method: ${INSTALL_METHOD} (use npm or git)"
  fi

  local installed_version
  if ! installed_version="$("${PREFIX}/bin/openclaw" --version 2>/dev/null | head -n 1 | tr -d '\r')" ||
    [[ -z "$installed_version" ]]; then
    fail "Installed OpenClaw CLI did not return a version successfully from ${PREFIX}/bin/openclaw."
  fi
  commit_wrapper_backup

  refresh_gateway_service_if_loaded
  emit_json "done" version "$installed_version"
  log "OpenClaw installed (${installed_version})."

  if [[ "$RUN_ONBOARD" -eq 1 ]]; then
    "${PREFIX}/bin/openclaw" onboard
  fi
}

if [[ "${OPENCLAW_INSTALL_CLI_SH_NO_RUN:-0}" != "1" ]]; then
  main "$@"
fi
