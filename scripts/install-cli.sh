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

PREFIX="${OPENCLAW_PREFIX:-${HOME}/.openclaw}"
OPENCLAW_VERSION="${OPENCLAW_VERSION:-latest}"
NODE_VERSION="${OPENCLAW_NODE_VERSION:-22.22.0}"
SHARP_IGNORE_GLOBAL_LIBVIPS="${SHARP_IGNORE_GLOBAL_LIBVIPS:-1}"
NPM_LOGLEVEL="${OPENCLAW_NPM_LOGLEVEL:-error}"
INSTALL_METHOD="${OPENCLAW_INSTALL_METHOD:-npm}"
GIT_DIR="${OPENCLAW_GIT_DIR:-${HOME}/openclaw}"
GIT_UPDATE="${OPENCLAW_GIT_UPDATE:-1}"
JSON=0
RUN_ONBOARD=0
SET_NPM_PREFIX=0
PNPM_CMD=()

print_usage() {
  cat <<EOF
Usage: install-cli.sh [options]
  --json                              Emit NDJSON events (no human output)
  --prefix <path>                     Install prefix (default: ~/.openclaw)
  --install-method, --method npm|git  Install via npm (default) or from a git checkout
  --npm                               Shortcut for --install-method npm
  --git, --github                     Shortcut for --install-method git
  --git-dir, --dir <path>             Checkout directory (default: ~/openclaw)
  --version <ver>                     OpenClaw version (default: latest)
  --node-version <ver>                Node version (default: 22.22.0)
  --onboard                           Run "openclaw onboard" after install
  --no-onboard                        Skip onboarding (default)
  --set-npm-prefix                    Force npm prefix to ~/.npm-global if current prefix is not writable (Linux)

Environment variables:
  SHARP_IGNORE_GLOBAL_LIBVIPS=0|1    Default: 1 (avoid sharp building against global libvips)
  OPENCLAW_NPM_LOGLEVEL=error|warn|notice  Default: error (hide npm deprecation noise)
  OPENCLAW_INSTALL_METHOD=git|npm
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
  local repo_dir="${1:-${OPENCLAW_GIT_DIR:-${HOME}/openclaw}}"
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
        PREFIX="$2"
        shift 2
        ;;
      --version)
        OPENCLAW_VERSION="$2"
        shift 2
        ;;
      --node-version)
        NODE_VERSION="$2"
        shift 2
        ;;
      --install-method|--method)
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
    x86_64|amd64) echo "x64" ;;
    *) fail "Unsupported architecture: $arch" ;;
  esac
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
  if ! pnpm_cmd_is_ready; then
    ensure_pnpm
  fi
  "${PNPM_CMD[@]}" "$@"
}

install_node() {
  local os
  local arch
  local url
  local tmp
  local dir
  local current_major
  local base_url
  local tarball
  local expected_sha
  local actual_sha

  os="$(os_detect)"
  arch="$(arch_detect)"
  dir="$(node_dir)"

  if [[ -x "$(node_bin)" ]]; then
    current_major="$("$(node_bin)" -v 2>/dev/null | tr -d 'v' | cut -d'.' -f1 || echo "")"
    if [[ -n "$current_major" && "$current_major" -ge 22 ]]; then
      emit_json "{\"event\":\"step\",\"name\":\"node\",\"status\":\"skip\",\"path\":\"${dir//\"/\\\\\\\"}\"}"
      return
    fi
  fi

  emit_json "{\"event\":\"step\",\"name\":\"node\",\"status\":\"start\",\"version\":\"${NODE_VERSION}\"}"
  log "Installing Node ${NODE_VERSION} (user-space)..."

  mkdir -p "${PREFIX}/tools"
  tmp="$(mktemp -d)"
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

  if ! "$(node_bin)" -e "require('node:sqlite')" >/dev/null 2>&1; then
    fail "Installed Node ${NODE_VERSION} is missing node:sqlite; re-run with --node-version 22.22.0 (or newer)"
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
  SHARP_IGNORE_GLOBAL_LIBVIPS="$SHARP_IGNORE_GLOBAL_LIBVIPS" "$(npm_bin)" install -g --prefix "$PREFIX" pnpm@11
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

install_openclaw() {
  local requested="${OPENCLAW_VERSION:-latest}"
  local npm_args=(
    --loglevel "$NPM_LOGLEVEL"
    --no-fund
    --no-audit
  )
  emit_json "{\"event\":\"step\",\"name\":\"openclaw\",\"status\":\"start\",\"version\":\"${requested}\"}"
  log "Installing OpenClaw (${requested})..."
  if [[ "$SET_NPM_PREFIX" -eq 1 ]]; then
    fix_npm_prefix_if_needed
  fi

  if [[ "${requested}" == "latest" ]]; then
    if ! SHARP_IGNORE_GLOBAL_LIBVIPS="$SHARP_IGNORE_GLOBAL_LIBVIPS" "$(npm_bin)" install -g --prefix "$(node_dir)" "${npm_args[@]}" "openclaw@latest"; then
      log "npm install openclaw@latest failed; retrying openclaw@next"
      emit_json "{\"event\":\"step\",\"name\":\"openclaw\",\"status\":\"retry\",\"version\":\"next\"}"
      SHARP_IGNORE_GLOBAL_LIBVIPS="$SHARP_IGNORE_GLOBAL_LIBVIPS" "$(npm_bin)" install -g --prefix "$(node_dir)" "${npm_args[@]}" "openclaw@next"
      requested="next"
    fi
  else
    SHARP_IGNORE_GLOBAL_LIBVIPS="$SHARP_IGNORE_GLOBAL_LIBVIPS" "$(npm_bin)" install -g --prefix "$(node_dir)" "${npm_args[@]}" "openclaw@${requested}"
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

  if [[ "$GIT_UPDATE" == "1" ]]; then
    if [[ -z "$(git -C "$repo_dir" status --porcelain 2>/dev/null || true)" ]]; then
      git -C "$repo_dir" pull --rebase || true
    else
      log "Repo is dirty; skipping git pull"
    fi
  fi

  cleanup_legacy_submodules "$repo_dir"
  ensure_pnpm_git_prepare_allowlist "$repo_dir"

  SHARP_IGNORE_GLOBAL_LIBVIPS="$SHARP_IGNORE_GLOBAL_LIBVIPS" run_pnpm -C "$repo_dir" install

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
    log "Warning: gateway service restart failed; continuing."
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

  cleanup_legacy_submodules

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
