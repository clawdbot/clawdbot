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
cleanup_tmpfiles() {
  local f
  for f in "${TMPFILES[@]:-}"; do
    rm -rf "$f" 2>/dev/null || true
  done
}
trap cleanup_tmpfiles EXIT

resolve_openclaw_effective_home() {
  local openclaw_home="${OPENCLAW_HOME:-}"
  if [[ -z "$openclaw_home" ]]; then
    echo "$HOME"
    return 0
  fi

  case "$openclaw_home" in
    \~)
      echo "$HOME"
      ;;
    \~/*)
      echo "${HOME}/${openclaw_home#~/}"
      ;;
    *)
      echo "$openclaw_home"
      ;;
  esac
}

OPENCLAW_EFFECTIVE_HOME="$(resolve_openclaw_effective_home)"
PREFIX="${OPENCLAW_PREFIX:-${HOME}/.openclaw}"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-latest}"
DEFAULT_NODE_VERSION="24.15.0"
ARMV7_DEFAULT_NODE_VERSION="22.22.3"
NODE_VERSION="${OPENCLAW_NODE_VERSION:-${DEFAULT_NODE_VERSION}}"
NODE_VERSION_REQUESTED=0
if [[ -n "${OPENCLAW_NODE_VERSION:-}" ]]; then
  NODE_VERSION_REQUESTED=1
fi
MIN_NODE_22_VERSION="22.22.3"
MIN_NODE_24_VERSION="24.15.0"
MIN_NODE_25_VERSION="25.9.0"
SUPPORTED_NODE_VERSION_LABEL="Node 22.22.3+, Node 24.15.0+, or Node 25.9.0+"
APK_NODE_BIN_DIR="/usr/bin"
NPM_LOGLEVEL="${OPENCLAW_NPM_LOGLEVEL:-error}"
INSTALL_METHOD="${OPENCLAW_INSTALL_METHOD:-npm}"
GIT_DIR="${OPENCLAW_GIT_DIR:-${OPENCLAW_EFFECTIVE_HOME}/openclaw}"
GIT_UPDATE="${OPENCLAW_GIT_UPDATE:-1}"
JSON=0
RUN_ONBOARD=0
SET_NPM_PREFIX=0
PNPM_CMD=()

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
  --node-version <ver>                Node version (default: 24.15.0; 22.22.3 on Linux ARMv7)
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
    curl -fsSL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 1 --retry-connrefused -o "$output" "$url"
    return
  fi
  wget -q --https-only --secure-protocol=TLSv1_2 --tries=3 --timeout=20 -O "$output" "$url"
}

cleanup_legacy_submodules() {
  local repo_dir="${1:-${OPENCLAW_GIT_DIR:-${OPENCLAW_EFFECTIVE_HOME}/openclaw}}"
  local legacy_dir="${repo_dir}/Peekaboo"
  if [[ -d "$legacy_dir" ]]; then
    emit_json "{\"event\":\"step\",\"name\":\"legacy-submodule\",\"status\":\"start\",\"path\":\"${legacy_dir//\"/\\\"}\"}"
    log "Removing legacy submodule checkout: ${legacy_dir}"
    rm -rf "$legacy_dir"
    emit_json "{\"event\":\"step\",\"name\":\"legacy-submodule\",\"status\":\"ok\",\"path\":\"${legacy_dir//\"/\\\"}\"}"
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

emit_json() {
  if [[ "$JSON" -eq 1 ]]; then
    printf '%s\n' "$1"
  fi
}

fail() {
  local msg="$1"
  emit_json "{\"event\":\"error\",\"message\":\"${msg//\"/\\\"}\"}"
  log "ERROR: $msg"
  exit 1
}

require_bin() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    fail "Missing required binary: $name"
  fi
}

has_sudo() {
  command -v sudo >/dev/null 2>&1
}

is_root() {
  [[ "$(id -u)" -eq 0 ]]
}

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    emit_json '{"event":"step","name":"git","status":"ok"}'
    return
  fi

  emit_json '{"event":"step","name":"git","status":"start"}'
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

  emit_json '{"event":"step","name":"git","status":"ok"}'
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
    fail "Linux ARMv7 requires Node 22.22.3+ because official Node 24+ binaries are unavailable; use --node-version 22.22.3."
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
  local current_version
  local required_version

  if [[ ! -x "$(node_bin)" || ! -x "$(npm_bin)" ]]; then
    return 1
  fi

  current_version="$("$(node_bin)" -v 2>/dev/null || echo "")"
  required_version="$(required_node_version)"
  if ! node_version_is_supported "$current_version"; then
    return 1
  fi
  if ! semver_at_least "$current_version" "$required_version"; then
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

  emit_json "{\"event\":\"step\",\"name\":\"node\",\"status\":\"start\",\"method\":\"apk\"}"
  if try_link_usable_node_runtime_from_path; then
    installed_version="$("$(node_bin)" -v 2>/dev/null || echo unknown)"
    emit_json "{\"event\":\"step\",\"name\":\"node\",\"status\":\"ok\",\"method\":\"system\",\"version\":\"${installed_version}\"}"
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
    fail "Alpine Node package must provide Node >= ${required_version} with WAL-reset-safe SQLite 3.51.3+ (or patched 3.50.7+/3.44.6+); found Node ${installed_version}, SQLite ${sqlite_version}."
  fi

  installed_version="$("$(node_bin)" -v 2>/dev/null || echo unknown)"
  emit_json "{\"event\":\"step\",\"name\":\"node\",\"status\":\"ok\",\"method\":\"apk\",\"version\":\"${installed_version}\"}"
}

set_pnpm_cmd() {
  PNPM_CMD=("$@")
}

pnpm_cmd_is_ready() {
  if [[ ${#PNPM_CMD[@]} -eq 0 ]]; then
    return 1
  fi
  "${PNPM_CMD[@]}" --version >/dev/null 2>&1
}

detect_pnpm_cmd() {
  if [[ -x "${PREFIX}/bin/pnpm" ]]; then
    set_pnpm_cmd "${PREFIX}/bin/pnpm"
    return 0
  fi
  if command -v pnpm >/dev/null 2>&1; then
    set_pnpm_cmd pnpm
    return 0
  fi
  if [[ -x "$(node_dir)/bin/corepack" ]] && "$(node_dir)/bin/corepack" pnpm --version >/dev/null 2>&1; then
    set_pnpm_cmd "$(node_dir)/bin/corepack" pnpm
    return 0
  fi
  return 1
}

ensure_pnpm_binary_for_scripts() {
  if command -v pnpm >/dev/null 2>&1; then
    return 0
  fi

  if [[ ${#PNPM_CMD[@]} -eq 2 && "${PNPM_CMD[1]}" == "pnpm" ]] && [[ "$(basename "${PNPM_CMD[0]}")" == "corepack" ]]; then
    mkdir -p "${PREFIX}/bin"
    cat > "${PREFIX}/bin/pnpm" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "${PNPM_CMD[0]}" pnpm "\$@"
EOF
    chmod +x "${PREFIX}/bin/pnpm"
    export PATH="${PREFIX}/bin:${PATH}"
    hash -r 2>/dev/null || true
  fi

  if command -v pnpm >/dev/null 2>&1; then
    return 0
  fi

  fail "pnpm command not available on PATH"
}

run_pnpm() {
  if [[ ${#PNPM_CMD[@]} -eq 2 && "${PNPM_CMD[1]}" == "pnpm" ]] && [[ "${1:-}" == "-C" && -n "${2:-}" ]]; then
    local repo_dir="$2"
    shift 2
    if ! (cd "$repo_dir" && "${PNPM_CMD[@]}" --version >/dev/null 2>&1); then
      ensure_pnpm
    fi
    (cd "$repo_dir" && "${PNPM_CMD[@]}" "$@")
    return
  fi
  if ! pnpm_cmd_is_ready; then
    ensure_pnpm
  fi
  "${PNPM_CMD[@]}" "$@"
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

checkout_git_openclaw_ref() {
  local repo_dir="$1"
  local ref="$2"

  if [[ -z "$ref" ]]; then
    return 0
  fi

  if [[ "$ref" == "main" ]]; then
    git -C "$repo_dir" fetch --no-tags origin main
    git -C "$repo_dir" checkout main
    if [[ "$GIT_UPDATE" == "1" ]]; then
      git -C "$repo_dir" pull --rebase --no-tags || true
    fi
    return 0
  fi

  if git -C "$repo_dir" ls-remote --exit-code --heads origin "$ref" >/dev/null 2>&1; then
    git -C "$repo_dir" fetch --no-tags origin "refs/heads/${ref}:refs/remotes/origin/${ref}"
    git -C "$repo_dir" checkout -B "$ref" "origin/$ref"
    if [[ "$GIT_UPDATE" == "1" ]]; then
      git -C "$repo_dir" pull --rebase --no-tags || true
    fi
    return 0
  fi

  git -C "$repo_dir" fetch --tags origin

  if git -C "$repo_dir" rev-parse --verify --quiet "refs/tags/${ref}^{commit}" >/dev/null; then
    git -C "$repo_dir" checkout --detach "$ref"
    return 0
  fi

  if git -C "$repo_dir" rev-parse --verify --quiet "${ref}^{commit}" >/dev/null; then
    git -C "$repo_dir" checkout --detach "$ref"
    return 0
  fi

  fail "Requested git version not found: ${ref}"
}

git_install_lockfile_flag() {
  local repo_dir="$1"
  local ref="$2"

  if [[ "$ref" == "main" ]] || git -C "$repo_dir" ls-remote --exit-code --heads origin "$ref" >/dev/null 2>&1; then
    echo "--no-frozen-lockfile"
    return 0
  fi

  echo "--frozen-lockfile"
}

repo_pnpm_spec() {
  local repo_dir="$1"
  local package_json="${repo_dir}/package.json"

  if [[ ! -f "$package_json" ]]; then
    return 1
  fi

  sed -n -E 's/^[[:space:]]*"packageManager"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$package_json" | head -n1
}

activate_repo_pnpm_version() {
  local repo_dir="$1"
  local spec
  local version
  local corepack_cmd=""

  spec="$(repo_pnpm_spec "$repo_dir" || true)"
  if [[ "$spec" != pnpm@* ]]; then
    return 0
  fi

  version="${spec#pnpm@}"
  version="${version%%+*}"
  if [[ -z "$version" ]]; then
    return 0
  fi

  if [[ -x "$(node_dir)/bin/corepack" ]]; then
    corepack_cmd="$(node_dir)/bin/corepack"
  elif command -v corepack >/dev/null 2>&1; then
    corepack_cmd="$(command -v corepack)"
  fi

  if [[ -n "$corepack_cmd" ]]; then
    log "Activating repo pnpm ${version}"
    "$corepack_cmd" prepare "pnpm@${version}" --activate >/dev/null 2>&1 || true
    if [[ "$(cd "$repo_dir" && "$corepack_cmd" pnpm --version 2>/dev/null || true)" == "$version" ]]; then
      set_pnpm_cmd "$corepack_cmd" pnpm
      return 0
    fi
    detect_pnpm_cmd || true
  fi
}

install_node() {
  local os
  local arch
  local url
  local tmp
  local dir
  local base_url
  local tarball
  local expected_sha
  local actual_sha

  os="$(os_detect)"
  arch="$(arch_detect)"
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
    emit_json "{\"event\":\"step\",\"name\":\"node\",\"status\":\"skip\",\"path\":\"${dir//\"/\\\\\\\"}\"}"
    return
  fi

  emit_json "{\"event\":\"step\",\"name\":\"node\",\"status\":\"start\",\"version\":\"${NODE_VERSION}\"}"
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
    fail "Installed Node ${NODE_VERSION} must provide Node >= ${required_version} with WAL-reset-safe SQLite; found Node ${installed_version}, SQLite ${sqlite_version}. Re-run with --node-version 24.15.0 (or newer)"
  fi
  emit_json "{\"event\":\"step\",\"name\":\"node\",\"status\":\"ok\",\"version\":\"${NODE_VERSION}\"}"
}

ensure_pnpm() {
  if detect_pnpm_cmd && pnpm_cmd_is_ready; then
    local current_version
    current_version="$("${PNPM_CMD[@]}" --version 2>/dev/null || true)"
    if [[ "$current_version" =~ ^11\. ]]; then
      return 0
    fi
    log "Found pnpm ${current_version:-unknown}; upgrading to pnpm@11..."
  fi

  if [[ -x "$(node_dir)/bin/corepack" ]]; then
    emit_json "{\"event\":\"step\",\"name\":\"pnpm\",\"status\":\"start\",\"method\":\"corepack\"}"
    log "Installing pnpm via Corepack..."
    "$(node_dir)/bin/corepack" enable >/dev/null 2>&1 || true
    "$(node_dir)/bin/corepack" prepare pnpm@11 --activate
    if detect_pnpm_cmd && pnpm_cmd_is_ready && [[ "$("${PNPM_CMD[@]}" --version 2>/dev/null || true)" =~ ^11\. ]]; then
      emit_json "{\"event\":\"step\",\"name\":\"pnpm\",\"status\":\"ok\"}"
      return 0
    fi
  fi

  emit_json "{\"event\":\"step\",\"name\":\"pnpm\",\"status\":\"start\",\"method\":\"npm\"}"
  log "Installing pnpm via npm..."
  "$(npm_bin)" install -g --prefix "$PREFIX" pnpm@11
  detect_pnpm_cmd || true
  emit_json "{\"event\":\"step\",\"name\":\"pnpm\",\"status\":\"ok\"}"
  return 0
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
  emit_json "{\"event\":\"step\",\"name\":\"npm-prefix\",\"status\":\"ok\",\"prefix\":\"${target//\"/\\\"}\"}"
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
  local raw=""
  local file=""
  local -a files=()

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
  emit_json "{\"event\":\"step\",\"name\":\"openclaw\",\"status\":\"start\",\"version\":\"${requested}\"}"
  log "Installing OpenClaw (${requested})..."
  if [[ "$SET_NPM_PREFIX" -eq 1 ]]; then
    fix_npm_prefix_if_needed
  fi

  if [[ "${requested}" == "latest" ]]; then
    if ! env -u NPM_CONFIG_BEFORE -u npm_config_before -u NPM_CONFIG_MIN_RELEASE_AGE -u npm_config_min_release_age -u npm_config_min-release-age "$(npm_bin)" install -g --prefix "$(node_dir)" "${npm_args[@]}" "openclaw@latest"; then
      log "npm install openclaw@latest failed; retrying openclaw@next"
      emit_json "{\"event\":\"step\",\"name\":\"openclaw\",\"status\":\"retry\",\"version\":\"next\"}"
      env -u NPM_CONFIG_BEFORE -u npm_config_before -u NPM_CONFIG_MIN_RELEASE_AGE -u npm_config_min_release_age -u npm_config_min-release-age "$(npm_bin)" install -g --prefix "$(node_dir)" "${npm_args[@]}" "openclaw@next"
      requested="next"
    fi
  else
    env -u NPM_CONFIG_BEFORE -u npm_config_before -u NPM_CONFIG_MIN_RELEASE_AGE -u npm_config_min_release_age -u npm_config_min-release-age "$(npm_bin)" install -g --prefix "$(node_dir)" "${npm_args[@]}" "openclaw@${requested}"
  fi

  mkdir -p "${PREFIX}/bin"
  rm -f "${PREFIX}/bin/openclaw"
  cat > "${PREFIX}/bin/openclaw" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "${PREFIX}/tools/node/bin/node" "$(node_dir)/lib/node_modules/openclaw/dist/entry.js" "\$@"
EOF
  chmod +x "${PREFIX}/bin/openclaw"
  emit_json "{\"event\":\"step\",\"name\":\"openclaw\",\"status\":\"ok\",\"version\":\"${requested}\"}"
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

install_openclaw_from_git() {
  local repo_dir="$1"
  local repo_url="https://github.com/openclaw/openclaw.git"

  if [[ -z "$repo_dir" ]]; then
    fail "Git install dir cannot be empty"
  fi
  if [[ "$repo_dir" != /* ]]; then
    repo_dir="$(pwd)/$repo_dir"
  fi
  mkdir -p "$(dirname "$repo_dir")"
  repo_dir="$(cd "$(dirname "$repo_dir")" && pwd)/$(basename "$repo_dir")"

  emit_json "{\"event\":\"step\",\"name\":\"openclaw\",\"status\":\"start\",\"method\":\"git\",\"repo\":\"${repo_url//\"/\\\"}\"}"
  if [[ -d "$repo_dir/.git" ]]; then
    log "Installing Openclaw from git checkout: ${repo_dir}"
  else
    log "Installing Openclaw from GitHub (${repo_url})..."
  fi

  ensure_git
  ensure_pnpm
  ensure_pnpm_binary_for_scripts

  if [[ -d "$repo_dir/.git" ]]; then
    :
  elif [[ -d "$repo_dir" ]]; then
    if [[ -z "$(ls -A "$repo_dir" 2>/dev/null || true)" ]]; then
      git clone "$repo_url" "$repo_dir"
    else
      fail "Git install dir exists but is not a git repo: ${repo_dir}"
    fi
  else
    git clone "$repo_url" "$repo_dir"
  fi

  local git_ref
  git_ref="$(resolve_git_openclaw_ref)"
  if [[ -z "$(git -C "$repo_dir" status --porcelain 2>/dev/null || true)" ]]; then
    log "Using git ref: ${git_ref}"
    checkout_git_openclaw_ref "$repo_dir" "$git_ref"
  else
    log "Repo is dirty; skipping git checkout/update"
  fi

  cleanup_legacy_submodules "$repo_dir"
  ensure_pnpm_git_prepare_allowlist "$repo_dir"
  activate_repo_pnpm_version "$repo_dir"

  local install_lockfile_flag
  install_lockfile_flag="$(git_install_lockfile_flag "$repo_dir" "$git_ref")"
  CI="${CI:-true}" run_pnpm -C "$repo_dir" install "$install_lockfile_flag"

  if ! run_pnpm -C "$repo_dir" ui:build; then
    log "UI build failed; continuing (CLI may still work)"
  fi
  run_pnpm -C "$repo_dir" build

  mkdir -p "${PREFIX}/bin"
  cat > "${PREFIX}/bin/openclaw" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "${PREFIX}/tools/node/bin/node" "${repo_dir}/dist/entry.js" "\$@"
EOF
  chmod +x "${PREFIX}/bin/openclaw"
  emit_json "{\"event\":\"step\",\"name\":\"openclaw\",\"status\":\"ok\",\"method\":\"git\"}"
}

resolve_openclaw_version() {
  local version=""
  if [[ -x "${PREFIX}/bin/openclaw" ]]; then
    version="$("${PREFIX}/bin/openclaw" --version 2>/dev/null | head -n 1 | tr -d '\r')"
  fi
  echo "$version"
}

is_gateway_daemon_loaded() {
  local claw="$1"
  if [[ -z "$claw" || ! -x "$claw" ]]; then
    return 1
  fi

  local status_json=""
  status_json="$("$claw" daemon status --json 2>/dev/null || true)"
  if [[ -z "$status_json" ]]; then
    return 1
  fi

  printf '%s' "$status_json" | node -e '
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
  local claw="${PREFIX}/bin/openclaw"
  if [[ ! -x "$claw" ]]; then
    return 0
  fi

  if ! is_gateway_daemon_loaded "$claw"; then
    emit_json '{"event":"step","name":"gateway-service","status":"skip","reason":"not-loaded"}'
    return 0
  fi

  emit_json '{"event":"step","name":"gateway-service","status":"start"}'
  log "Refreshing loaded gateway service..."

  if ! "$claw" gateway install --force >/dev/null 2>&1; then
    emit_json '{"event":"step","name":"gateway-service","status":"warn","reason":"install-failed"}'
    log "Warning: gateway service refresh failed; continuing."
    return 0
  fi

  if ! "$claw" gateway restart >/dev/null 2>&1; then
    emit_json '{"event":"step","name":"gateway-service","status":"warn","reason":"restart-failed"}'
    log "Warning: gateway service restart failed; continuing. Run: openclaw gateway restart"
    return 0
  fi

  "$claw" gateway status --probe --json >/dev/null 2>&1 || true
  emit_json '{"event":"step","name":"gateway-service","status":"ok"}'
}

main() {
  parse_args "$@"

  if [[ "${OPENCLAW_NO_ONBOARD:-0}" == "1" ]]; then
    RUN_ONBOARD=0
  fi

  select_node_version_for_platform "$(os_detect)" "$(arch_detect)"
  PATH="$(node_dir)/bin:${PREFIX}/bin:${PATH}"
  export PATH

  install_node
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

  refresh_gateway_service_if_loaded

  local installed_version
  installed_version="$(resolve_openclaw_version)"
  if [[ -n "$installed_version" ]]; then
    emit_json "{\"event\":\"done\",\"ok\":true,\"version\":\"${installed_version//\"/\\\"}\"}"
    log "OpenClaw installed (${installed_version})."
  else
    emit_json "{\"event\":\"done\",\"ok\":true}"
    log "OpenClaw installed."
  fi

  if [[ "$RUN_ONBOARD" -eq 1 ]]; then
    "${PREFIX}/bin/openclaw" onboard
  fi
}

if [[ "${OPENCLAW_INSTALL_CLI_SH_NO_RUN:-0}" != "1" ]]; then
  main "$@"
fi
