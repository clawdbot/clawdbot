#!/bin/bash
set -euo pipefail

# OpenClaw Installer for macOS and Linux
# Usage: curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash

BOLD='\033[1m'
ACCENT='\033[38;2;255;77;77m'       # coral-bright  #ff4d4d
# shellcheck disable=SC2034
ACCENT_BRIGHT='\033[38;2;255;110;110m' # lighter coral
INFO='\033[38;2;136;146;176m'       # text-secondary #8892b0
SUCCESS='\033[38;2;0;229;204m'      # cyan-bright   #00e5cc
WARN='\033[38;2;255;176;32m'        # amber (no site equiv, keep warm)
ERROR='\033[38;2;230;57;70m'        # coral-mid     #e63946
MUTED='\033[38;2;90;100;128m'       # text-muted    #5a6480
NC='\033[0m' # No Color

DEFAULT_TAGLINE="All your chats, one OpenClaw."
NODE_DEFAULT_MAJOR=24
NODE_MIN_MAJOR=22
NODE_MIN_MINOR=14
NODE_MIN_VERSION="${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}"

ORIGINAL_PATH="${PATH:-}"

TMPFILES=()
cleanup_tmpfiles() {
    local f
    for f in "${TMPFILES[@]:-}"; do
        rm -rf "$f" 2>/dev/null || true
    done
}
trap cleanup_tmpfiles EXIT

mktempfile() {
    local f
    f="$(mktemp)"
    TMPFILES+=("$f")
    echo "$f"
}

DOWNLOADER=""
detect_downloader() {
    if command -v curl &> /dev/null; then
        DOWNLOADER="curl"
        return 0
    fi
    if command -v wget &> /dev/null; then
        DOWNLOADER="wget"
        return 0
    fi
    ui_error "Missing downloader (curl or wget required)"
    exit 1
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

run_remote_bash() {
    local url="$1"
    local tmp
    tmp="$(mktempfile)"
    download_file "$url" "$tmp"
    /bin/bash "$tmp"
}

GUM_VERSION="${OPENCLAW_GUM_VERSION:-0.17.0}"
GUM=""
GUM_STATUS="skipped"
GUM_REASON=""
LAST_NPM_INSTALL_CMD=""

is_non_interactive_shell() {
    if [[ "${NO_PROMPT:-0}" == "1" ]]; then
        return 0
    fi
    if [[ ! -t 0 || ! -t 1 ]]; then
        return 0
    fi
    return 1
}

gum_is_tty() {
    if [[ -n "${NO_COLOR:-}" ]]; then
        return 1
    fi
    if [[ "${TERM:-dumb}" == "dumb" ]]; then
        return 1
    fi
    if [[ -t 2 || -t 1 ]]; then
        return 0
    fi
    if [[ -r /dev/tty && -w /dev/tty ]]; then
        return 0
    fi
    return 1
}

gum_detect_os() {
    case "$(uname -s 2>/dev/null || true)" in
        Darwin) echo "Darwin" ;;
        Linux) echo "Linux" ;;
        *) echo "unsupported" ;;
    esac
}

gum_detect_arch() {
    case "$(uname -m 2>/dev/null || true)" in
        x86_64|amd64) echo "x86_64" ;;
        arm64|aarch64) echo "arm64" ;;
        i386|i686) echo "i386" ;;
        armv7l|armv7) echo "armv7" ;;
        armv6l|armv6) echo "armv6" ;;
        *) echo "unknown" ;;
    esac
}

verify_sha256sum_file() {
    local checksums="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum --ignore-missing -c "$checksums" >/dev/null 2>&1
        return $?
    fi
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 --ignore-missing -c "$checksums" >/dev/null 2>&1
        return $?
    fi
    return 1
}

bootstrap_gum_temp() {
    GUM=""
    GUM_STATUS="skipped"
    GUM_REASON=""

    if is_non_interactive_shell; then
        GUM_REASON="non-interactive shell (auto-disabled)"
        return 1
    fi

    if ! gum_is_tty; then
        GUM_REASON="terminal does not support gum UI"
        return 1
    fi

    if command -v gum >/dev/null 2>&1; then
        GUM="gum"
        GUM_STATUS="found"
        GUM_REASON="already installed"
        return 0
    fi

    if ! command -v tar >/dev/null 2>&1; then
        GUM_REASON="tar not found"
        return 1
    fi

    local os arch asset base gum_tmpdir gum_path
    os="$(gum_detect_os)"
    arch="$(gum_detect_arch)"
    if [[ "$os" == "unsupported" || "$arch" == "unknown" ]]; then
        GUM_REASON="unsupported os/arch ($os/$arch)"
        return 1
    fi

    asset="gum_${GUM_VERSION}_${os}_${arch}.tar.gz"
    base="https://github.com/charmbracelet/gum/releases/download/v${GUM_VERSION}"

    gum_tmpdir="$(mktemp -d)"
    TMPFILES+=("$gum_tmpdir")

    ui_info "Preparing spinner support"
    if ! download_file "${base}/${asset}" "$gum_tmpdir/$asset"; then
        GUM_REASON="download failed"
        return 1
    fi

    ui_info "Verifying spinner support download"
    if ! download_file "${base}/checksums.txt" "$gum_tmpdir/checksums.txt"; then
        GUM_REASON="checksum unavailable or failed"
        return 1
    fi

    if ! (cd "$gum_tmpdir" && verify_sha256sum_file "checksums.txt"); then
        GUM_REASON="checksum unavailable or failed"
        return 1
    fi

    if ! tar -xzf "$gum_tmpdir/$asset" -C "$gum_tmpdir" >/dev/null 2>&1; then
        GUM_REASON="extract failed"
        return 1
    fi

    gum_path="$(find "$gum_tmpdir" -type f -name gum 2>/dev/null | head -n1 || true)"
    if [[ -z "$gum_path" ]]; then
        GUM_REASON="gum binary missing after extract"
        return 1
    fi

    chmod +x "$gum_path" >/dev/null 2>&1 || true
    if [[ ! -x "$gum_path" ]]; then
        GUM_REASON="gum binary is not executable"
        return 1
    fi

    GUM="$gum_path"
    GUM_STATUS="installed"
    GUM_REASON="temp, verified"
    return 0
}

print_gum_status() {
    case "$GUM_STATUS" in
        found)
            ui_success "gum available (${GUM_REASON})"
            ;;
        installed)
            ui_success "gum bootstrapped (${GUM_REASON}, v${GUM_VERSION})"
            ;;
        *)
            if [[ -n "$GUM_REASON" && "$GUM_REASON" != "non-interactive shell (auto-disabled)" ]]; then
                ui_info "gum skipped (${GUM_REASON})"
            fi
            ;;
    esac
}

print_installer_banner() {
    if [[ -n "$GUM" ]]; then
        local title tagline hint card
        title="$("$GUM" style --foreground "#ff4d4d" --bold "🦞 OpenClaw Installer")"
        tagline="$("$GUM" style --foreground "#8892b0" "$TAGLINE")"
        hint="$("$GUM" style --foreground "#5a6480" "modern installer mode")"
        card="$(printf '%s\n%s\n%s' "$title" "$tagline" "$hint")"
        "$GUM" style --border rounded --border-foreground "#ff4d4d" --padding "1 2" "$card"
        echo ""
        return
    fi

    echo -e "${ACCENT}${BOLD}"
    echo "  🦞 OpenClaw Installer"
    echo -e "${NC}${INFO}  ${TAGLINE}${NC}"
    echo ""
}

detect_os_or_die() {
    OS="unknown"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macos"
    elif [[ "$OSTYPE" == "linux-gnu"* ]] || [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
        OS="linux"
    fi

    if [[ "$OS" == "unknown" ]]; then
        ui_error "Unsupported operating system"
        echo "This installer supports macOS and Linux (including WSL)."
        echo "For Windows, use: iwr -useb https://openclaw.ai/install.ps1 | iex"
        exit 1
    fi

    ui_success "Detected: $OS"
}

ui_info() {
    local msg="$*"
    if [[ -n "$GUM" ]]; then
        "$GUM" log --level info "$msg"
    else
        echo -e "${MUTED}·${NC} ${msg}"
    fi
}

ui_warn() {
    local msg="$*"
    if [[ -n "$GUM" ]]; then
        "$GUM" log --level warn "$msg"
    else
        echo -e "${WARN}!${NC} ${msg}"
    fi
}

ui_success() {
    local msg="$*"
    if [[ -n "$GUM" ]]; then
        local mark
        mark="$("$GUM" style --foreground "#00e5cc" --bold "✓")"
        echo "${mark} ${msg}"
    else
        echo -e "${SUCCESS}✓${NC} ${msg}"
    fi
}

ui_error() {
    local msg="$*"
    if [[ -n "$GUM" ]]; then
        "$GUM" log --level error "$msg"
    else
        echo -e "${ERROR}✗${NC} ${msg}"
    fi
}

INSTALL_STAGE_TOTAL=3
INSTALL_STAGE_CURRENT=0

ui_section() {
    local title="$1"
    if [[ -n "$GUM" ]]; then
        "$GUM" style --bold --foreground "#ff4d4d" --padding "1 0" "$title"
    else
        echo ""
        echo -e "${ACCENT}${BOLD}${title}${NC}"
    fi
}

ui_stage() {
    local title="$1"
    INSTALL_STAGE_CURRENT=$((INSTALL_STAGE_CURRENT + 1))
    ui_section "[${INSTALL_STAGE_CURRENT}/${INSTALL_STAGE_TOTAL}] ${title}"
}

ui_kv() {
    local key="$1"
    local value="$2"
    if [[ -n "$GUM" ]]; then
        local key_part value_part
        key_part="$("$GUM" style --foreground "#5a6480" --width 20 "$key")"
        value_part="$("$GUM" style --bold "$value")"
        "$GUM" join --horizontal "$key_part" "$value_part"
    else
        echo -e "${MUTED}${key}:${NC} ${value}"
    fi
}

ui_panel() {
    local content="$1"
    if [[ -n "$GUM" ]]; then
        "$GUM" style --border rounded --border-foreground "#5a6480" --padding "0 1" "$content"
    else
        echo "$content"
    fi
}

show_install_plan() {
    local detected_checkout="$1"

    ui_section "Install plan"
    ui_kv "OS" "$OS"
    ui_kv "Install method" "$INSTALL_METHOD"
    ui_kv "Requested version" "$OPENCLAW_VERSION"
    if [[ "$USE_BETA" == "1" ]]; then
        ui_kv "Beta channel" "enabled"
    fi
    if [[ "$INSTALL_METHOD" == "git" ]]; then
        ui_kv "Git directory" "$GIT_DIR"
        ui_kv "Git update" "$GIT_UPDATE"
    fi
    if [[ -n "$detected_checkout" ]]; then
        ui_kv "Detected checkout" "$detected_checkout"
    fi
    if [[ "$DRY_RUN" == "1" ]]; then
        ui_kv "Dry run" "yes"
    fi
    if [[ "$NO_ONBOARD" == "1" ]]; then
        ui_kv "Onboarding" "skipped"
    fi
}

show_footer_links() {
    local faq_url="https://docs.openclaw.ai/start/faq"
    if [[ -n "$GUM" ]]; then
        local content
        content="$(printf '%s\n%s' "Need help?" "FAQ: ${faq_url}")"
        ui_panel "$content"
    else
        echo ""
        echo -e "FAQ: ${INFO}${faq_url}${NC}"
    fi
}

ui_celebrate() {
    local msg="$1"
    if [[ -n "$GUM" ]]; then
        "$GUM" style --bold --foreground "#00e5cc" "$msg"
    else
        echo -e "${SUCCESS}${BOLD}${msg}${NC}"
    fi
}

is_shell_function() {
    local name="${1:-}"
    [[ -n "$name" ]] && declare -F "$name" >/dev/null 2>&1
}

is_gum_raw_mode_failure() {
    local err_log="$1"
    [[ -s "$err_log" ]] || return 1
    grep -Eiq 'setrawmode|inappropriate ioctl' "$err_log"
}

run_with_spinner() {
    local title="$1"
    shift

    if [[ -n "$GUM" ]] && gum_is_tty && ! is_shell_function "${1:-}"; then
        local gum_err gum_out
        gum_err="$(mktempfile)"
        gum_out="$(mktempfile)"
        if "$GUM" spin --spinner dot --title "$title" -- "$@" >"$gum_out" 2>"$gum_err"; then
            if is_gum_raw_mode_failure "$gum_out" || is_gum_raw_mode_failure "$gum_err"; then
                GUM=""
                GUM_STATUS="skipped"
                GUM_REASON="gum raw mode unavailable"
                ui_warn "Spinner unavailable in this terminal; continuing without spinner"
                "$@"
                return $?
            fi
            if [[ -s "$gum_out" ]]; then
                cat "$gum_out"
            fi
            return 0
        fi
        local gum_status=$?
        if is_gum_raw_mode_failure "$gum_err" || is_gum_raw_mode_failure "$gum_out"; then
            GUM=""
            GUM_STATUS="skipped"
            GUM_REASON="gum raw mode unavailable"
            ui_warn "Spinner unavailable in this terminal; continuing without spinner"
            "$@"
            return $?
        fi
        if [[ -s "$gum_err" ]]; then
            cat "$gum_err" >&2
        fi
        return "$gum_status"
    fi

    "$@"
}

run_quiet_step() {
    local title="$1"
    shift

    if [[ "$VERBOSE" == "1" ]]; then
        run_with_spinner "$title" "$@"
        return $?
    fi

    local log
    log="$(mktempfile)"
    local showed_progress=false

    if [[ -n "$GUM" ]] && gum_is_tty && ! is_shell_function "${1:-}"; then
        local cmd_quoted=""
        local log_quoted=""
        printf -v cmd_quoted '%q ' "$@"
        printf -v log_quoted '%q' "$log"
        if run_with_spinner "$title" bash -c "${cmd_quoted}>${log_quoted} 2>&1"; then
            return 0
        fi
        showed_progress=true
    else
        # Keep users informed even when gum spinner cannot run (for example shell functions).
        ui_info "${title}"
        showed_progress=true
        if "$@" >"$log" 2>&1; then
            return 0
        fi
    fi

    if [[ "$showed_progress" == "false" ]]; then
        ui_info "${title}"
    fi

    ui_error "${title} failed — re-run with --verbose for details"
    if [[ -s "$log" ]]; then
        tail -n 80 "$log" >&2 || true
    fi
    return 1
}

cleanup_legacy_submodules() {
    local repo_dir="$1"
    local legacy_dir="$repo_dir/Peekaboo"
    if [[ -d "$legacy_dir" ]]; then
        ui_info "Removing legacy submodule checkout: ${legacy_dir}"
        rm -rf "$legacy_dir"
    fi
}

cleanup_npm_openclaw_paths() {
    local npm_root=""
    npm_root="$(npm root -g 2>/dev/null || true)"
    if [[ -z "$npm_root" || "$npm_root" != *node_modules* ]]; then
        return 1
    fi
    rm -rf "$npm_root"/.openclaw-* "$npm_root"/openclaw 2>/dev/null || true
}

extract_openclaw_conflict_path() {
    local log="$1"
    local path=""
    path="$(sed -n 's/.*File exists: //p' "$log" | head -n1)"
    if [[ -z "$path" ]]; then
        path="$(sed -n 's/.*EEXIST: file already exists, //p' "$log" | head -n1)"
    fi
    if [[ -n "$path" ]]; then
        echo "$path"
        return 0
    fi
    return 1
}

cleanup_openclaw_bin_conflict() {
    local bin_path="$1"
    if [[ -z "$bin_path" || ( ! -e "$bin_path" && ! -L "$bin_path" ) ]]; then
        return 1
    fi
    local npm_bin=""
    npm_bin="$(npm_global_bin_dir 2>/dev/null || true)"
    if [[ -n "$npm_bin" && "$bin_path" != "$npm_bin/openclaw" ]]; then
        case "$bin_path" in
            "/opt/homebrew/bin/openclaw"|"/usr/local/bin/openclaw")
                ;;
            *)
                return 1
                ;;
        esac
    fi
    if [[ -L "$bin_path" ]]; then
        local target=""
        target="$(readlink "$bin_path" 2>/dev/null || true)"
        if [[ "$target" == *"/node_modules/openclaw/"* ]]; then
            rm -f "$bin_path"
            ui_info "Removed stale openclaw symlink at ${bin_path}"
            return 0
        fi
        return 1
    fi
    local backup=""
    backup="${bin_path}.bak-$(date +%Y%m%d-%H%M%S)"
    if mv "$bin_path" "$backup"; then
        ui_info "Moved existing openclaw binary to ${backup}"
        return 0
    fi
    return 1
}

npm_log_indicates_missing_build_tools() {
    local log="$1"
    if [[ -z "$log" || ! -f "$log" ]]; then
        return 1
    fi

    grep -Eiq "(not found: make|make: command not found|cmake: command not found|CMAKE_MAKE_PROGRAM is not set|Could not find CMAKE|gyp ERR! find Python|no developer tools were found|is not able to compile a simple test program|Failed to build llama\\.cpp|It seems that \"make\" is not installed in your system|It seems that the used \"cmake\" doesn't work properly)" "$log"
}

# Detect Arch-based distributions (Arch Linux, Manjaro, EndeavourOS, etc.)
is_arch_linux() {
    if [[ -f /etc/os-release ]]; then
        local os_id
        os_id="$(grep -E '^ID=' /etc/os-release 2>/dev/null | cut -d'=' -f2 | tr -d '"' || true)"
        case "$os_id" in
            arch|manjaro|endeavouros|arcolinux|garuda|archarm|cachyos|archcraft)
                return 0
                ;;
        esac
        # Also check ID_LIKE for Arch derivatives
        local os_id_like
        os_id_like="$(grep -E '^ID_LIKE=' /etc/os-release 2>/dev/null | cut -d'=' -f2 | tr -d '"' || true)"
        if [[ "$os_id_like" == *arch* ]]; then
            return 0
        fi
    fi
    # Fallback: check for pacman
    if command -v pacman &> /dev/null; then
        return 0
    fi
    return 1
}

apt_get() {
    if is_root; then
        env DEBIAN_FRONTEND="${DEBIAN_FRONTEND:-noninteractive}" NEEDRESTART_MODE="${NEEDRESTART_MODE:-a}" apt-get "$@"
    else
        sudo env DEBIAN_FRONTEND="${DEBIAN_FRONTEND:-noninteractive}" NEEDRESTART_MODE="${NEEDRESTART_MODE:-a}" apt-get "$@"
    fi
}

apt_get_update() {
    apt_get update -qq
}

apt_get_install() {
    apt_get install -y -qq \
        -o Dpkg::Options::=--force-confdef \
        -o Dpkg::Options::=--force-confold \
        "$@"
}

install_build_tools_linux() {
    require_sudo

    if command -v apt-get &> /dev/null; then
        run_quiet_step "Updating package index" apt_get_update
        run_quiet_step "Installing build tools" apt_get_install build-essential python3 make g++ cmake
        return 0
    fi

    if command -v pacman &> /dev/null || is_arch_linux; then
        if is_root; then
            run_quiet_step "Installing build tools" pacman -Sy --noconfirm base-devel python make cmake gcc
        else
            run_quiet_step "Installing build tools" sudo pacman -Sy --noconfirm base-devel python make cmake gcc
        fi
        return 0
    fi

    if command -v dnf &> /dev/null; then
        if is_root; then
            run_quiet_step "Installing build tools" dnf install -y -q gcc gcc-c++ make cmake python3
        else
            run_quiet_step "Installing build tools" sudo dnf install -y -q gcc gcc-c++ make cmake python3
        fi
        return 0
    fi

    if command -v yum &> /dev/null; then
        if is_root; then
            run_quiet_step "Installing build tools" yum install -y -q gcc gcc-c++ make cmake python3
        else
            run_quiet_step "Installing build tools" sudo yum install -y -q gcc gcc-c++ make cmake python3
        fi
        return 0
    fi

    if command -v apk &> /dev/null; then
        if is_root; then
            run_quiet_step "Installing build tools" apk add --no-cache build-base python3 cmake
        else
            run_quiet_step "Installing build tools" sudo apk add --no-cache build-base python3 cmake
        fi
        return 0
    fi

    ui_warn "Could not detect package manager for auto-installing build tools"
    return 1
}

install_build_tools_macos() {
    local ok=true

    if ! xcode-select -p >/dev/null 2>&1; then
        ui_info "Installing Xcode Command Line Tools (required for make/clang)"
        xcode-select --install >/dev/null 2>&1 || true
        if ! xcode-select -p >/dev/null 2>&1; then
            ui_warn "Xcode Command Line Tools are not ready yet"
            ui_info "Complete the installer dialog, then re-run this installer"
            ok=false
        fi
    fi

    if ! command -v cmake >/dev/null 2>&1; then
        if command -v brew >/dev/null 2>&1; then
            run_quiet_step "Installing cmake" brew install cmake
        else
            ui_warn "Homebrew not available; cannot auto-install cmake"
            ok=false
        fi
    fi

    if ! command -v make >/dev/null 2>&1; then
        ui_warn "make is still unavailable"
        ok=false
    fi
    if ! command -v cmake >/dev/null 2>&1; then
        ui_warn "cmake is still unavailable"
        ok=false
    fi

    [[ "$ok" == "true" ]]
}

auto_install_build_tools_for_npm_failure() {
    local log="$1"
    if ! npm_log_indicates_missing_build_tools "$log"; then
        return 1
    fi

    ui_warn "Detected missing native build tools; attempting automatic setup"
    if [[ "$OS" == "linux" ]]; then
        install_build_tools_linux || return 1
    elif [[ "$OS" == "macos" ]]; then
        install_build_tools_macos || return 1
    else
        return 1
    fi
    ui_success "Build tools setup complete"
    return 0
}

run_npm_global_install() {
    local spec="$1"
    local log="$2"

    local -a cmd
    cmd=(env "SHARP_IGNORE_GLOBAL_LIBVIPS=$SHARP_IGNORE_GLOBAL_LIBVIPS" npm --loglevel "$NPM_LOGLEVEL")
    if [[ -n "$NPM_SILENT_FLAG" ]]; then
        cmd+=("$NPM_SILENT_FLAG")
    fi
    cmd+=(--no-fund --no-audit install -g "$spec")
    local cmd_display=""
    printf -v cmd_display '%q ' "${cmd[@]}"
    LAST_NPM_INSTALL_CMD="${cmd_display% }"

    if [[ "$VERBOSE" == "1" ]]; then
        "${cmd[@]}" 2>&1 | tee "$log"
        return $?
    fi

    if [[ -n "$GUM" ]] && gum_is_tty; then
        local cmd_quoted=""
        local log_quoted=""
        printf -v cmd_quoted '%q ' "${cmd[@]}"
        printf -v log_quoted '%q' "$log"
        run_with_spinner "Installing OpenClaw package" bash -c "${cmd_quoted}>${log_quoted} 2>&1"
        return $?
    fi

    "${cmd[@]}" >"$log" 2>&1
}

extract_npm_debug_log_path() {
    local log="$1"
    local path=""
    path="$(sed -n -E 's/.*A complete log of this run can be found in:[[:space:]]*//p' "$log" | tail -n1)"
    if [[ -n "$path" ]]; then
        echo "$path"
        return 0
    fi

    path="$(grep -Eo '/[^[:space:]]+_logs/[^[:space:]]+debug[^[:space:]]*\.log' "$log" | tail -n1 || true)"
    if [[ -n "$path" ]]; then
        echo "$path"
        return 0
    fi

    return 1
}

extract_first_npm_error_line() {
    local log="$1"
    grep -E 'npm (ERR!|error)|ERR!' "$log" | head -n1 || true
}

extract_npm_error_code() {
    local log="$1"
    sed -n -E 's/^npm (ERR!|error) code[[:space:]]+([^[:space:]]+).*$/\2/p' "$log" | head -n1
}

extract_npm_error_syscall() {
    local log="$1"
    sed -n -E 's/^npm (ERR!|error) syscall[[:space:]]+(.+)$/\2/p' "$log" | head -n1
}

extract_npm_error_errno() {
    local log="$1"
    sed -n -E 's/^npm (ERR!|error) errno[[:space:]]+(.+)$/\2/p' "$log" | head -n1
}

print_npm_failure_diagnostics() {
    local spec="$1"
    local log="$2"
    local debug_log=""
    local first_error=""
    local error_code=""
    local error_syscall=""
    local error_errno=""

    ui_warn "npm install failed for ${spec}"
    if [[ -n "${LAST_NPM_INSTALL_CMD}" ]]; then
        echo "  Command: ${LAST_NPM_INSTALL_CMD}"
    fi
    echo "  Installer log: ${log}"

    error_code="$(extract_npm_error_code "$log")"
    if [[ -n "$error_code" ]]; then
        echo "  npm code: ${error_code}"
    fi

    error_syscall="$(extract_npm_error_syscall "$log")"
    if [[ -n "$error_syscall" ]]; then
        echo "  npm syscall: ${error_syscall}"
    fi

    error_errno="$(extract_npm_error_errno "$log")"
    if [[ -n "$error_errno" ]]; then
        echo "  npm errno: ${error_errno}"
    fi

    debug_log="$(extract_npm_debug_log_path "$log" || true)"
    if [[ -n "$debug_log" ]]; then
        echo "  npm debug log: ${debug_log}"
    fi

    first_error="$(extract_first_npm_error_line "$log")"
    if [[ -n "$first_error" ]]; then
        echo "  First npm error: ${first_error}"
    fi
}

install_openclaw_npm() {
    local spec="$1"
    local log
    log="$(mktempfile)"
    if ! run_npm_global_install "$spec" "$log"; then
        local attempted_build_tool_fix=false
        if auto_install_build_tools_for_npm_failure "$log"; then
            attempted_build_tool_fix=true
            ui_info "Retrying npm install after build tools setup"
            if run_npm_global_install "$spec" "$log"; then
                ui_success "OpenClaw npm package installed"
                return 0
            fi
        fi

        print_npm_failure_diagnostics "$spec" "$log"

        if [[ "$VERBOSE" != "1" ]]; then
            if [[ "$attempted_build_tool_fix" == "true" ]]; then
                ui_warn "npm install still failed after build tools setup; showing last log lines"
            else
                ui_warn "npm install failed; showing last log lines"
            fi
            tail -n 80 "$log" >&2 || true
        fi

        if grep -q "ENOTEMPTY: directory not empty, rename .*openclaw" "$log"; then
            ui_warn "npm left stale directory; cleaning and retrying"
            cleanup_npm_openclaw_paths
            if run_npm_global_install "$spec" "$log"; then
                ui_success "OpenClaw npm package installed"
                return 0
            fi
            return 1
        fi
        if grep -q "EEXIST" "$log"; then
            local conflict=""
            conflict="$(extract_openclaw_conflict_path "$log" || true)"
            if [[ -n "$conflict" ]] && cleanup_openclaw_bin_conflict "$conflict"; then
                if run_npm_global_install "$spec" "$log"; then
                    ui_success "OpenClaw npm package installed"
                    return 0
                fi
                return 1
            fi
            ui_error "npm failed because an openclaw binary already exists"
            if [[ -n "$conflict" ]]; then
                ui_info "Remove or move ${conflict}, then retry"
            fi
            ui_info "Or rerun with: npm install -g --force ${spec}"
        fi
        return 1
    fi
    ui_success "OpenClaw npm package installed"
    return 0
}

TAGLINES=()
TAGLINES+=("Your terminal just grew claws—type something and let the bot pinch the busywork.")
TAGLINES+=("Welcome to the command line: where dreams compile and confidence segfaults.")
TAGLINES+=("I run on caffeine, JSON5, and the audacity of \"it worked on my machine.\"")
TAGLINES+=("Gateway online—please keep hands, feet, and appendages inside the shell at all times.")
TAGLINES+=("I speak fluent bash, mild sarcasm, and aggressive tab-completion energy.")
TAGLINES+=("One CLI to rule them all, and one more restart because you changed the port.")
TAGLINES+=("If it works, it's automation; if it breaks, it's a \"learning opportunity.\"")
TAGLINES+=("Pairing codes exist because even bots believe in consent—and good security hygiene.")
TAGLINES+=("Your .env is showing; don't worry, I'll pretend I didn't see it.")
TAGLINES+=("I'll do the boring stuff while you dramatically stare at the logs like it's cinema.")
TAGLINES+=("I'm not saying your workflow is chaotic... I'm just bringing a linter and a helmet.")
TAGLINES+=("Type the command with confidence—nature will provide the stack trace if needed.")
TAGLINES+=("I don't judge, but your missing API keys are absolutely judging you.")
TAGLINES+=("I can grep it, git blame it, and gently roast it—pick your coping mechanism.")
TAGLINES+=("Hot reload for config, cold sweat for deploys.")
TAGLINES+=("I'm the assistant your terminal demanded, not the one your sleep schedule requested.")
TAGLINES+=("I keep secrets like a vault... unless you print them in debug logs again.")
TAGLINES+=("Automation with claws: minimal fuss, maximal pinch.")
TAGLINES+=("I'm basically a Swiss Army knife, but with more opinions and fewer sharp edges.")
TAGLINES+=("If you're lost, run doctor; if you're brave, run prod; if you're wise, run tests.")
TAGLINES+=("Your task has been queued; your dignity has been deprecated.")
TAGLINES+=("I can't fix your code taste, but I can fix your build and your backlog.")
TAGLINES+=("I'm not magic—I'm just extremely persistent with retries and coping strategies.")
TAGLINES+=("It's not \"failing,\" it's \"discovering new ways to configure the same thing wrong.\"")
TAGLINES+=("Give me a workspace and I'll give you fewer tabs, fewer toggles, and more oxygen.")
TAGLINES+=("I read logs so you can keep pretending you don't have to.")
TAGLINES+=("If something's on fire, I can't extinguish it—but I can write a beautiful postmortem.")
TAGLINES+=("I'll refactor your busywork like it owes me money.")
TAGLINES+=("Say \"stop\" and I'll stop—say \"ship\" and we'll both learn a lesson.")
TAGLINES+=("I'm the reason your shell history looks like a hacker-movie montage.")
TAGLINES+=("I'm like tmux: confusing at first, then suddenly you can't live without me.")
TAGLINES+=("I can run local, remote, or purely on vibes—results may vary with DNS.")
TAGLINES+=("If you can describe it, I can probably automate it—or at least make it funnier.")
TAGLINES+=("Your config is valid, your assumptions are not.")
TAGLINES+=("I don't just autocomplete—I auto-commit (emotionally), then ask you to review (logically).")
TAGLINES+=("Less clicking, more shipping, fewer \"where did that file go\" moments.")
TAGLINES+=("Claws out, commit in—let's ship something mildly responsible.")
TAGLINES+=("I'll butter your workflow like a lobster roll: messy, delicious, effective.")
TAGLINES+=("Shell yeah—I'm here to pinch the toil and leave you the glory.")
TAGLINES+=("If it's repetitive, I'll automate it; if it's hard, I'll bring jokes and a rollback plan.")
TAGLINES+=("Because texting yourself reminders is so 2024.")
TAGLINES+=("WhatsApp, but make it ✨engineering✨.")
TAGLINES+=("Turning \"I'll reply later\" into \"my bot replied instantly\".")
TAGLINES+=("The only crab in your contacts you actually want to hear from. 🦞")
TAGLINES+=("Chat automation for people who peaked at IRC.")
TAGLINES+=("Because Siri wasn't answering at 3AM.")
TAGLINES+=("IPC, but it's your phone.")
TAGLINES+=("The UNIX philosophy meets your DMs.")
TAGLINES+=("curl for conversations.")
TAGLINES+=("WhatsApp Business, but without the business.")
TAGLINES+=("Meta wishes they shipped this fast.")
TAGLINES+=("End-to-end encrypted, Zuck-to-Zuck excluded.")
TAGLINES+=("The only bot Mark can't train on your DMs.")
TAGLINES+=("WhatsApp automation without the \"please accept our new privacy policy\".")
TAGLINES+=("Chat APIs that don't require a Senate hearing.")
TAGLINES+=("Because Threads wasn't the answer either.")
TAGLINES+=("Your messages, your servers, Meta's tears.")
TAGLINES+=("iMessage green bubble energy, but for everyone.")
TAGLINES+=("Siri's competent cousin.")
TAGLINES+=("Works on Android. Crazy concept, we know.")
TAGLINES+=("No \$999 stand required.")
TAGLINES+=("We ship features faster than Apple ships calculator updates.")
TAGLINES+=("Your AI assistant, now without the \$3,499 headset.")
TAGLINES+=("Think different. Actually think.")
TAGLINES+=("Ah, the fruit tree company! 🍎")

HOLIDAY_NEW_YEAR="New Year's Day: New year, new config—same old EADDRINUSE, but this time we resolve it like grown-ups."
HOLIDAY_LUNAR_NEW_YEAR="Lunar New Year: May your builds be lucky, your branches prosperous, and your merge conflicts chased away with fireworks."
HOLIDAY_CHRISTMAS="Christmas: Ho ho ho—Santa's little claw-sistant is here to ship joy, roll back chaos, and stash the keys safely."
HOLIDAY_EID="Eid al-Fitr: Celebration mode: queues cleared, tasks completed, and good vibes committed to main with clean history."
HOLIDAY_DIWALI="Diwali: Let the logs sparkle and the bugs flee—today we light up the terminal and ship with pride."
HOLIDAY_EASTER="Easter: I found your missing environment variable—consider it a tiny CLI egg hunt with fewer jellybeans."
HOLIDAY_HANUKKAH="Hanukkah: Eight nights, eight retries, zero shame—may your gateway stay lit and your deployments stay peaceful."
HOLIDAY_HALLOWEEN="Halloween: Spooky season: beware haunted dependencies, cursed caches, and the ghost of node_modules past."
HOLIDAY_THANKSGIVING="Thanksgiving: Grateful for stable ports, working DNS, and a bot that reads the logs so nobody has to."
HOLIDAY_VALENTINES="Valentine's Day: Roses are typed, violets are piped—I'll automate the chores so you can spend time with humans."

append_holiday_taglines() {
    local today
    local month_day
    today="$(date -u +%Y-%m-%d 2>/dev/null || date +%Y-%m-%d)"
    month_day="$(date -u +%m-%d 2>/dev/null || date +%m-%d)"

    case "$month_day" in
        "01-01") TAGLINES+=("$HOLIDAY_NEW_YEAR") ;;
        "02-14") TAGLINES+=("$HOLIDAY_VALENTINES") ;;
        "10-31") TAGLINES+=("$HOLIDAY_HALLOWEEN") ;;
        "12-25") TAGLINES+=("$HOLIDAY_CHRISTMAS") ;;
    esac

    case "$today" in
        "2025-01-29"|"2026-02-17"|"2027-02-06") TAGLINES+=("$HOLIDAY_LUNAR_NEW_YEAR") ;;
        "2025-03-30"|"2025-03-31"|"2026-03-20"|"2027-03-10") TAGLINES+=("$HOLIDAY_EID") ;;
        "2025-10-20"|"2026-11-08"|"2027-10-28") TAGLINES+=("$HOLIDAY_DIWALI") ;;
        "2025-04-20"|"2026-04-05"|"2027-03-28") TAGLINES+=("$HOLIDAY_EASTER") ;;
        "2025-11-27"|"2026-11-26"|"2027-11-25") TAGLINES+=("$HOLIDAY_THANKSGIVING") ;;
        "2025-12-15"|"2025-12-16"|"2025-12-17"|"2025-12-18"|"2025-12-19"|"2025-12-20"|"2025-12-21"|"2025-12-22"|"2026-12-05"|"2026-12-06"|"2026-12-07"|"2026-12-08"|"2026-12-09"|"2026-12-10"|"2026-12-11"|"2026-12-12"|"2027-12-25"|"2027-12-26"|"2027-12-27"|"2027-12-28"|"2027-12-29"|"2027-12-30"|"2027-12-31"|"2028-01-01") TAGLINES+=("$HOLIDAY_HANUKKAH") ;;
    esac
}

pick_tagline() {
    append_holiday_taglines
    local count=${#TAGLINES[@]}
    if [[ "$count" -eq 0 ]]; then
        echo "$DEFAULT_TAGLINE"
        return
    fi
    if [[ -n "${OPENCLAW_TAGLINE_INDEX:-}" ]]; then
        if [[ "${OPENCLAW_TAGLINE_INDEX}" =~ ^[0-9]+$ ]]; then
            local idx=$((OPENCLAW_TAGLINE_INDEX % count))
            echo "${TAGLINES[$idx]}"
            return
        fi
    fi
    local idx=$((RANDOM % count))
    echo "${TAGLINES[$idx]}"
}

TAGLINE=$(pick_tagline)

NO_ONBOARD=${OPENCLAW_NO_ONBOARD:-0}
NO_PROMPT=${OPENCLAW_NO_PROMPT:-0}
DRY_RUN=${OPENCLAW_DRY_RUN:-0}
INSTALL_METHOD=${OPENCLAW_INSTALL_METHOD:-}
OPENCLAW_VERSION=${OPENCLAW_VERSION:-latest}
USE_BETA=${OPENCLAW_BETA:-0}
GIT_DIR_DEFAULT="${HOME}/openclaw"
GIT_DIR=${OPENCLAW_GIT_DIR:-$GIT_DIR_DEFAULT}
GIT_UPDATE=${OPENCLAW_GIT_UPDATE:-1}
SHARP_IGNORE_GLOBAL_LIBVIPS="${SHARP_IGNORE_GLOBAL_LIBVIPS:-1}"
NPM_LOGLEVEL="${OPENCLAW_NPM_LOGLEVEL:-error}"
NPM_SILENT_FLAG="--silent"
VERBOSE="${OPENCLAW_VERBOSE:-0}"
VERIFY_INSTALL="${OPENCLAW_VERIFY_INSTALL:-0}"
OPENCLAW_BIN=""
PNPM_CMD=()
HELP=0

print_usage() {
    cat <<EOF
OpenClaw installer (macOS + Linux)

Usage:
  curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- [options]

Options:
  --install-method, --method npm|git   Install via npm (default) or from a git checkout
  --npm                               Shortcut for --install-method npm
  --git, --github                     Shortcut for --install-method git
  --version <version|dist-tag|spec>    npm install target (default: latest; use "main" for GitHub main)
  --beta                               Use beta if available, else latest
  --git-dir, --dir <path>             Checkout directory (default: ~/openclaw)
  --no-git-update                      Skip git pull for existing checkout
  --no-onboard                          Skip onboarding (non-interactive)
  --no-prompt                           Disable prompts (required in CI/automation)
  --verify                              Run a post-install smoke verify
  --dry-run                             Print what would happen (no changes)
  --verbose                             Print debug output (set -x, npm verbose)
  --help, -h                            Show this help

Environment variables:
  OPENCLAW_INSTALL_METHOD=git|npm
  OPENCLAW_VERSION=latest|next|main|<semver>|<spec>
  OPENCLAW_BETA=0|1
  OPENCLAW_GIT_DIR=...
  OPENCLAW_GIT_UPDATE=0|1
  OPENCLAW_NO_PROMPT=1
  OPENCLAW_VERIFY_INSTALL=1
  OPENCLAW_DRY_RUN=1
  OPENCLAW_NO_ONBOARD=1
  OPENCLAW_VERBOSE=1
  OPENCLAW_NPM_LOGLEVEL=error|warn|notice  Default: error (hide npm deprecation noise)
  SHARP_IGNORE_GLOBAL_LIBVIPS=0|1    Default: 1 (avoid sharp building against global libvips)

Examples:
  curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash
  curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard
  curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --no-onboard --verify
  curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --version main
  curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method git --no-onboard
EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --no-onboard)
                NO_ONBOARD=1
                shift
                ;;
            --onboard)
                NO_ONBOARD=0
                shift
                ;;
            --dry-run)
                DRY_RUN=1
                shift
                ;;
            --verbose)
                VERBOSE=1
                shift
                ;;
            --verify)
                VERIFY_INSTALL=1
                shift
                ;;
            --no-prompt)
                NO_PROMPT=1
                shift
                ;;
            --help|-h)
                HELP=1
                shift
                ;;
            --install-method|--method)
                INSTALL_METHOD="$2"
                shift 2
                ;;
            --version)
                OPENCLAW_VERSION="$2"
                shift 2
                ;;
            --beta)
                USE_BETA=1
                shift
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
            *)
                shift
                ;;
        esac
    done
}

configure_verbose() {
    if [[ "$VERBOSE" != "1" ]]; then
        return 0
    fi
    if [[ "$NPM_LOGLEVEL" == "error" ]]; then
        NPM_LOGLEVEL="notice"
    fi
    NPM_SILENT_FLAG=""
    set -x
}

is_promptable() {
    if [[ "$NO_PROMPT" == "1" ]]; then
        return 1
    fi
    if [[ -r /dev/tty && -w /dev/tty ]]; then
        return 0
    fi
    return 1
}

prompt_choice() {
    local prompt="$1"
    local answer=""
    if ! is_promptable; then
        return 1
    fi
    echo -e "$prompt" > /dev/tty
    read -r answer < /dev/tty || true
    echo "$answer"
}

choose_install_method_interactive() {
    local detected_checkout="$1"

    if ! is_promptable; then
        return 1
    fi

    if [[ -n "$GUM" ]] && gum_is_tty; then
        local header selection
        header="Detected OpenClaw checkout in: ${detected_checkout}
Choose install method"
        selection="$("$GUM" choose \
            --header "$header" \
            --cursor-prefix "❯ " \
            "git  · update this checkout and use it" \
            "npm  · install globally via npm" < /dev/tty || true)"

        case "$selection" in
            git*)
                echo "git"
                return 0
                ;;
            npm*)
                echo "npm"
                return 0
                ;;
        esac
        return 1
    fi

    local choice=""
    choice="$(prompt_choice "$(cat <<EOF
${WARN}→${NC} Detected a OpenClaw source checkout in: ${INFO}${detected_checkout}${NC}
Choose install method:
  1) Update this checkout (git) and use it
  2) Install global via npm (migrate away from git)
Enter 1 or 2:
EOF
)" || true)"

    case "$choice" in
        1)
            echo "git"
            return 0
            ;;
        2)
            echo "npm"
            return 0
            ;;
    esac

    return 1
}

detect_openclaw_checkout() {
    local dir="$1"
    if [[ ! -f "$dir/package.json" ]]; then
        return 1
    fi
    if [[ ! -f "$dir/pnpm-workspace.yaml" ]]; then
        return 1
    fi
    if ! grep -q '"name"[[:space:]]*:[[:space:]]*"openclaw"' "$dir/package.json" 2>/dev/null; then
        return 1
    fi
    echo "$dir"
    return 0
}

# Check for Homebrew on macOS
is_macos_admin_user() {
    if [[ "$OS" != "macos" ]]; then
        return 0
    fi
    if is_root; then
        return 0
    fi
    id -Gn "$(id -un)" 2>/dev/null | grep -qw "admin"
}

print_homebrew_admin_fix() {
    local current_user
    current_user="$(id -un 2>/dev/null || echo "${USER:-current user}")"
    ui_error "Homebrew installation requires a macOS Administrator account"
    echo "Current user (${current_user}) is not in the admin group."
    echo "Fix options:"
    echo "  1) Use an Administrator account and re-run the installer."
    echo "  2) Ask an Administrator to grant admin rights, then sign out/in:"
    echo "     sudo dseditgroup -o edit -a ${current_user} -t user admin"
    echo "Then retry:"
    echo "  curl -fsSL https://openclaw.ai/install.sh | bash"
}

install_homebrew() {
    if [[ "$OS" == "macos" ]]; then
        if ! command -v brew &> /dev/null; then
            if ! is_macos_admin_user; then
                print_homebrew_admin_fix
                exit 1
            fi
            ui_info "Homebrew not found, installing"
            run_quiet_step "Installing Homebrew" run_remote_bash "https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"

            # Add Homebrew to PATH for this session
            if [[ -f "/opt/homebrew/bin/brew" ]]; then
                eval "$(/opt/homebrew/bin/brew shellenv)"
            elif [[ -f "/usr/local/bin/brew" ]]; then
                eval "$(/usr/local/bin/brew shellenv)"
            fi
            ui_success "Homebrew installed"
        else
            ui_success "Homebrew already installed"
        fi
    fi
}

# Check Node.js version
parse_node_version_components() {
    if ! command -v node &> /dev/null; then
        return 1
    fi
    local version major minor
    version="$(node -v 2>/dev/null || true)"
    major="${version#v}"
    major="${major%%.*}"
    minor="${version#v}"
    minor="${minor#*.}"
    minor="${minor%%.*}"

    if [[ ! "$major" =~ ^[0-9]+$ ]]; then
        return 1
    fi
    if [[ ! "$minor" =~ ^[0-9]+$ ]]; then
        return 1
    fi
    echo "${major} ${minor}"
    return 0
}

node_major_version() {
    local version_components major minor
    version_components="$(parse_node_version_components || true)"
    read -r major minor <<< "$version_components"
    if [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]]; then
        echo "$major"
        return 0
    fi
    return 1
}

node_is_at_least_required() {
    local version_components major minor
    version_components="$(parse_node_version_components || true)"
    read -r major minor <<< "$version_components"
    if [[ ! "$major" =~ ^[0-9]+$ || ! "$minor" =~ ^[0-9]+$ ]]; then
        return 1
    fi
    if [[ "$major" -gt "$NODE_MIN_MAJOR" ]]; then
        return 0
    fi
    if [[ "$major" -eq "$NODE_MIN_MAJOR" && "$minor" -ge "$NODE_MIN_MINOR" ]]; then
        return 0
    fi
    return 1
}

print_active_node_paths() {
    if ! command -v node &> /dev/null; then
        return 1
    fi
    local node_path node_version npm_path npm_version
    node_path="$(command -v node 2>/dev/null || true)"
    node_version="$(node -v 2>/dev/null || true)"
    ui_info "Active Node.js: ${node_version:-unknown} (${node_path:-unknown})"

    if command -v npm &> /dev/null; then
        npm_path="$(command -v npm 2>/dev/null || true)"
        npm_version="$(npm -v 2>/dev/null || true)"
        ui_info "Active npm: ${npm_version:-unknown} (${npm_path:-unknown})"
    fi
    return 0
}

ensure_macos_default_node_active() {
    if [[ "$OS" != "macos" ]]; then
        return 0
    fi

    local brew_node_prefix=""
    if command -v brew &> /dev/null; then
        brew_node_prefix="$(brew --prefix "node@${NODE_DEFAULT_MAJOR}" 2>/dev/null || true)"
        if [[ -n "$brew_node_prefix" && -x "${brew_node_prefix}/bin/node" ]]; then
            export PATH="${brew_node_prefix}/bin:$PATH"
            refresh_shell_command_cache
        fi
    fi

    local major=""
    major="$(node_major_version || true)"
    if [[ -n "$major" && "$major" -ge 22 ]]; then
        return 0
    fi

    local active_path active_version
    active_path="$(command -v node 2>/dev/null || echo "not found")"
    active_version="$(node -v 2>/dev/null || echo "missing")"

    if [[ -z "$brew_node_prefix" || ! -x "${brew_node_prefix}/bin/node" ]]; then
        ui_error "Homebrew node@${NODE_DEFAULT_MAJOR} is not installed on disk"
        echo "The previous 'brew install' step appears to have failed."
        echo "Re-run 'brew install node@${NODE_DEFAULT_MAJOR}' directly or rerun the installer with --verbose to see the underlying error."
        return 1
    fi

    ui_error "Node.js v${NODE_DEFAULT_MAJOR} was installed but this shell is using ${active_version} (${active_path})"
    echo "Add this to your shell profile and restart shell:"
    echo "  export PATH=\"${brew_node_prefix}/bin:\$PATH\""
    return 1
}

ensure_default_node_active_shell() {
    if node_is_at_least_required; then
        return 0
    fi

    local active_path active_version
    active_path="$(command -v node 2>/dev/null || echo "not found")"
    active_version="$(node -v 2>/dev/null || echo "missing")"

    ui_error "Active Node.js must be v${NODE_MIN_VERSION}+ but this shell is using ${active_version} (${active_path})"
    print_active_node_paths || true

    local nvm_detected=0
    if [[ -n "${NVM_DIR:-}" || "$active_path" == *"/.nvm/"* ]]; then
        nvm_detected=1
    fi
    if command -v nvm >/dev/null 2>&1; then
        nvm_detected=1
    fi

    if [[ "$nvm_detected" -eq 1 ]]; then
        echo "nvm appears to be managing Node for this shell."
        echo "Run:"
        echo "  nvm install ${NODE_DEFAULT_MAJOR}"
        echo "  nvm use ${NODE_DEFAULT_MAJOR}"
        echo "  nvm alias default ${NODE_DEFAULT_MAJOR}"
        echo "Then open a new shell and rerun:"
        echo "  curl -fsSL https://openclaw.ai/install.sh | bash"
    else
        echo "Install/select Node.js ${NODE_DEFAULT_MAJOR} (or Node ${NODE_MIN_VERSION}+ minimum) and ensure it is first on PATH, then rerun installer."
    fi

    return 1
}

load_nvm_for_node_detection() {
    local nvm_dir="${NVM_DIR:-}"
    if [[ -n "$nvm_dir" && ! -s "$nvm_dir/nvm.sh" ]]; then
        nvm_dir=""
    fi
    if [[ -z "$nvm_dir" && -s "$HOME/.nvm/nvm.sh" ]]; then
        nvm_dir="$HOME/.nvm"
    fi
    if [[ -z "$nvm_dir" || ! -s "$nvm_dir/nvm.sh" ]]; then
        return 0
    fi

    export NVM_DIR="$nvm_dir"
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh" --no-use >/dev/null 2>&1 || . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
    if command -v nvm >/dev/null 2>&1; then
        nvm use default --silent >/dev/null 2>&1 || nvm use node --silent >/dev/null 2>&1 || true
    fi
    refresh_shell_command_cache
}

check_node() {
    if command -v node &> /dev/null; then
        NODE_VERSION="$(node_major_version || true)"
        if node_is_at_least_required; then
            ui_success "Node.js v$(node -v | cut -d'v' -f2) found"
            print_active_node_paths || true
            return 0
        else
            if [[ -n "$NODE_VERSION" ]]; then
                ui_info "Node.js $(node -v) found, upgrading to v${NODE_MIN_VERSION}+"
            else
                ui_info "Node.js found but version could not be parsed; reinstalling v${NODE_MIN_VERSION}+"
            fi
            return 1
        fi
    else
        ui_info "Node.js not found, installing it now"
        return 1
    fi
}

# Install Node.js
install_node() {
    if [[ "$OS" == "macos" ]]; then
        ui_info "Installing Node.js via Homebrew"
        if ! run_quiet_step "Installing node@${NODE_DEFAULT_MAJOR}" brew install "node@${NODE_DEFAULT_MAJOR}"; then
            echo "Re-run with --verbose or run 'brew install node@${NODE_DEFAULT_MAJOR}' directly, then rerun the installer."
            exit 1
        fi
        brew link "node@${NODE_DEFAULT_MAJOR}" --overwrite --force 2>/dev/null || true
        if ! ensure_macos_default_node_active; then
            exit 1
        fi
        ui_success "Node.js installed"
        print_active_node_paths || true
    elif [[ "$OS" == "linux" ]]; then
        require_sudo

        ui_info "Installing Linux build tools (make/g++/cmake/python3)"
        if install_build_tools_linux; then
            ui_success "Build tools installed"
        else
            ui_warn "Continuing without auto-installing build tools"
        fi

        # Arch-based distros: use pacman with official repos
        if command -v pacman &> /dev/null || is_arch_linux; then
            ui_info "Installing Node.js via pacman (Arch-based distribution detected)"
            if is_root; then
                run_quiet_step "Installing Node.js" pacman -Sy --noconfirm nodejs npm
            else
                run_quiet_step "Installing Node.js" sudo pacman -Sy --noconfirm nodejs npm
            fi
            ui_success "Node.js v${NODE_DEFAULT_MAJOR} installed"
            print_active_node_paths || true
            return 0
        fi

        ui_info "Installing Node.js via NodeSource"
        if command -v apt-get &> /dev/null; then
            local tmp
            tmp="$(mktempfile)"
            run_quiet_step "Downloading NodeSource setup script" download_file "https://deb.nodesource.com/setup_${NODE_DEFAULT_MAJOR}.x" "$tmp"
            if is_root; then
                run_quiet_step "Configuring NodeSource repository" bash "$tmp"
                run_quiet_step "Installing Node.js" apt_get_install nodejs
            else
                run_quiet_step "Configuring NodeSource repository" sudo -E bash "$tmp"
                run_quiet_step "Installing Node.js" apt_get_install nodejs
            fi
        elif command -v dnf &> /dev/null; then
            local tmp
            tmp="$(mktempfile)"
            run_quiet_step "Downloading NodeSource setup script" download_file "https://rpm.nodesource.com/setup_${NODE_DEFAULT_MAJOR}.x" "$tmp"
            if is_root; then
                run_quiet_step "Configuring NodeSource repository" bash "$tmp"
                run_quiet_step "Installing Node.js" dnf install -y -q nodejs
            else
                run_quiet_step "Configuring NodeSource repository" sudo bash "$tmp"
                run_quiet_step "Installing Node.js" sudo dnf install -y -q nodejs
            fi
        elif command -v yum &> /dev/null; then
            local tmp
            tmp="$(mktempfile)"
            run_quiet_step "Downloading NodeSource setup script" download_file "https://rpm.nodesource.com/setup_${NODE_DEFAULT_MAJOR}.x" "$tmp"
            if is_root; then
                run_quiet_step "Configuring NodeSource repository" bash "$tmp"
                run_quiet_step "Installing Node.js" yum install -y -q nodejs
            else
                run_quiet_step "Configuring NodeSource repository" sudo bash "$tmp"
                run_quiet_step "Installing Node.js" sudo yum install -y -q nodejs
            fi
        else
            ui_error "Could not detect package manager"
            echo "Please install Node.js ${NODE_DEFAULT_MAJOR} manually (or Node ${NODE_MIN_VERSION}+ minimum): https://nodejs.org"
            exit 1
        fi

        ui_success "Node.js v${NODE_DEFAULT_MAJOR} installed"
        print_active_node_paths || true
    fi
}

# Check Git
check_git() {
    if command -v git &> /dev/null; then
        ui_success "Git already installed"
        return 0
    fi
    ui_info "Git not found, installing it now"
    return 1
}

is_root() {
    [[ "$(id -u)" -eq 0 ]]
}

# Run a command with sudo only if not already root
maybe_sudo() {
    if is_root; then
        # Skip -E flag when root (env is already preserved)
        if [[ "${1:-}" == "-E" ]]; then
            shift
        fi
        "$@"
    else
        sudo "$@"
    fi
}

require_sudo() {
    if [[ "$OS" != "linux" ]]; then
        return 0
    fi
    if is_root; then
        return 0
    fi
    if command -v sudo &> /dev/null; then
        if ! sudo -n true >/dev/null 2>&1; then
            ui_info "Administrator privileges required; enter your password"
            sudo -v
        fi
        return 0
    fi
    ui_error "sudo is required for system installs on Linux"
    echo "  Install sudo or re-run as root."
    exit 1
}

install_git() {
    if [[ "$OS" == "macos" ]]; then
        run_quiet_step "Installing Git" brew install git
    elif [[ "$OS" == "linux" ]]; then
        require_sudo
        if command -v apt-get &> /dev/null; then
            run_quiet_step "Updating package index" apt_get_update
            run_quiet_step "Installing Git" apt_get_install git
        elif command -v pacman &> /dev/null || is_arch_linux; then
            if is_root; then
                run_quiet_step "Installing Git" pacman -Sy --noconfirm git
            else
                run_quiet_step "Installing Git" sudo pacman -Sy --noconfirm git
            fi
        elif command -v dnf &> /dev/null; then
            if is_root; then
                run_quiet_step "Installing Git" dnf install -y -q git
            else
                run_quiet_step "Installing Git" sudo dnf install -y -q git
            fi
        elif command -v yum &> /dev/null; then
            if is_root; then
                run_quiet_step "Installing Git" yum install -y -q git
            else
                run_quiet_step "Installing Git" sudo yum install -y -q git
            fi
        else
            ui_error "Could not detect package manager for Git"
            exit 1
        fi
    fi
    ui_success "Git installed"
}

# Fix npm permissions for global installs (Linux)
fix_npm_permissions() {
    if [[ "$OS" != "linux" ]]; then
        return 0
    fi

    local npm_prefix
    npm_prefix="$(npm config get prefix 2>/dev/null || true)"
    if [[ -z "$npm_prefix" ]]; then
        return 0
    fi

    if [[ -w "$npm_prefix" || -w "$npm_prefix/lib" ]]; then
        return 0
    fi

    ui_info "Configuring npm for user-local installs"
    mkdir -p "$HOME/.npm-global"
    npm config set prefix "$HOME/.npm-global"

    # shellcheck disable=SC2016
    local path_line='export PATH="$HOME/.npm-global/bin:$PATH"'
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
        if [[ -f "$rc" ]] && ! grep -q ".npm-global" "$rc"; then
            echo "$path_line" >> "$rc"
        fi
    done

    export PATH="$HOME/.npm-global/bin:$PATH"
    ui_success "npm configured for user installs"
}

ensure_openclaw_bin_link() {
    local npm_root=""
    npm_root="$(npm root -g 2>/dev/null || true)"
    if [[ -z "$npm_root" || ! -d "$npm_root/openclaw" ]]; then
        return 1
    fi
    local npm_bin=""
    npm_bin="$(npm_global_bin_dir || true)"
    if [[ -z "$npm_bin" ]]; then
        return 1
    fi
    mkdir -p "$npm_bin"
    if [[ ! -x "${npm_bin}/openclaw" ]]; then
        ln -sf "$npm_root/openclaw/dist/entry.js" "${npm_bin}/openclaw"
        ui_info "Created openclaw bin link at ${npm_bin}/openclaw"
    fi
    return 0
}

# Check for existing OpenClaw installation
check_existing_openclaw() {
    if [[ -n "$(type -P openclaw 2>/dev/null || true)" ]]; then
        ui_info "Existing OpenClaw installation detected, upgrading"
        return 0
    fi
    return 1
}

set_pnpm_cmd() {
    PNPM_CMD=("$@")
}

pnpm_cmd_pretty() {
    if [[ ${#PNPM_CMD[@]} -eq 0 ]]; then
        echo ""
        return 1
    fi
    printf '%s' "${PNPM_CMD[*]}"
    return 0
}

pnpm_cmd_is_ready() {
    if [[ ${#PNPM_CMD[@]} -eq 0 ]]; then
        return 1
    fi
    "${PNPM_CMD[@]}" --version >/dev/null 2>&1
}

detect_pnpm_cmd() {
    if command -v pnpm &> /dev/null; then
        set_pnpm_cmd pnpm
        return 0
    fi
    if command -v corepack &> /dev/null; then
        if corepack pnpm --version >/dev/null 2>&1; then
            set_pnpm_cmd corepack pnpm
            return 0
        fi
    fi
    return 1
}

ensure_pnpm() {
    if detect_pnpm_cmd && pnpm_cmd_is_ready; then
        ui_success "pnpm ready ($(pnpm_cmd_pretty))"
        return 0
    fi

    if command -v corepack &> /dev/null; then
        ui_info "Configuring pnpm via Corepack"
        corepack enable >/dev/null 2>&1 || true
        if ! run_quiet_step "Activating pnpm" corepack prepare pnpm@10 --activate; then
            ui_warn "Corepack pnpm activation failed; falling back"
        fi
        refresh_shell_command_cache
        if detect_pnpm_cmd && pnpm_cmd_is_ready; then
            if [[ "${PNPM_CMD[*]}" == "corepack pnpm" ]]; then
                ui_warn "pnpm shim not on PATH; using corepack pnpm fallback"
            fi
            ui_success "pnpm ready ($(pnpm_cmd_pretty))"
            return 0
        fi
    fi

    ui_info "Installing pnpm via npm"
    fix_npm_permissions
    run_quiet_step "Installing pnpm" npm install -g pnpm@10
    refresh_shell_command_cache
    if detect_pnpm_cmd && pnpm_cmd_is_ready; then
        ui_success "pnpm ready ($(pnpm_cmd_pretty))"
        return 0
    fi

    ui_error "pnpm installation failed"
    return 1
}

ensure_pnpm_binary_for_scripts() {
    if command -v pnpm >/dev/null 2>&1; then
        return 0
    fi

    if command -v corepack >/dev/null 2>&1; then
        ui_info "Ensuring pnpm command is available"
        corepack enable >/dev/null 2>&1 || true
        corepack prepare pnpm@10 --activate >/dev/null 2>&1 || true
        refresh_shell_command_cache
        if command -v pnpm >/dev/null 2>&1; then
            ui_success "pnpm command enabled via Corepack"
            return 0
        fi
    fi

    if [[ "${PNPM_CMD[*]}" == "corepack pnpm" ]] && command -v corepack >/dev/null 2>&1; then
        ensure_user_local_bin_on_path
        local user_pnpm="${HOME}/.local/bin/pnpm"
        cat >"${user_pnpm}" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec corepack pnpm "$@"
EOF
        chmod +x "${user_pnpm}"
        refresh_shell_command_cache

        if command -v pnpm >/dev/null 2>&1; then
            ui_warn "pnpm shim not on PATH; installed user-local wrapper at ${user_pnpm}"
            return 0
        fi
    fi

    ui_error "pnpm command not available on PATH"
    ui_info "Install pnpm globally (npm install -g pnpm@10) and retry"
    return 1
}

run_pnpm() {
    if ! pnpm_cmd_is_ready; then
        ensure_pnpm
    fi
    "${PNPM_CMD[@]}" "$@"
}

ensure_user_local_bin_on_path() {
    local target="$HOME/.local/bin"
    mkdir -p "$target"

    export PATH="$target:$PATH"

    # shellcheck disable=SC2016
    local path_line='export PATH="$HOME/.local/bin:$PATH"'
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
        if [[ -f "$rc" ]] && ! grep -q ".local/bin" "$rc"; then
            echo "$path_line" >> "$rc"
        fi
    done
}

npm_global_bin_dir() {
    local prefix=""
    prefix="$(npm prefix -g 2>/dev/null || true)"
    if [[ -n "$prefix" ]]; then
        if [[ "$prefix" == /* ]]; then
            echo "${prefix%/}/bin"
            return 0
        fi
    fi

    prefix="$(npm config get prefix 2>/dev/null || true)"
    if [[ -n "$prefix" && "$prefix" != "undefined" && "$prefix" != "null" ]]; then
        if [[ "$prefix" == /* ]]; then
            echo "${prefix%/}/bin"
            return 0
        fi
    fi

    echo ""
    return 1
}

canonicalize_dir() {
    local dir="$1"
    if [[ -z "$dir" || ! -d "$dir" ]]; then
        return 1
    fi
    (cd "$dir" 2>/dev/null && pwd -P) || return 1
}

openclaw_package_version() {
    local package_json="$1"
    if [[ ! -f "$package_json" ]]; then
        echo "unknown"
        return 0
    fi

    local version=""
    if command -v node >/dev/null 2>&1; then
        version="$(node -e 'const fs = require("fs"); const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(pkg.version || "unknown"));' "$package_json" 2>/dev/null || true)"
    fi
    if [[ -z "$version" ]]; then
        version="$(sed -n -E 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' "$package_json" | head -n1)"
    fi
    echo "${version:-unknown}"
}

emit_npm_root_candidate() {
    local root="${1%/}"
    if [[ -n "$root" && "$root" == /* ]]; then
        echo "$root"
    fi
}

collect_openclaw_npm_root_candidates() {
    local root=""
    root="$(npm root -g 2>/dev/null || true)"
    emit_npm_root_candidate "$root"

    local npm_cmd=""
    while IFS= read -r npm_cmd; do
        [[ -n "$npm_cmd" ]] || continue
        root="$("$npm_cmd" root -g 2>/dev/null || true)"
        emit_npm_root_candidate "$root"
    done < <(type -aP npm 2>/dev/null | awk '!seen[$0]++' || true)

    local extra_root=""
    local old_ifs="$IFS"
    IFS=":"
    for extra_root in ${OPENCLAW_INSTALL_EXTRA_NPM_ROOTS:-}; do
        emit_npm_root_candidate "$extra_root"
    done
    IFS="$old_ifs"

    emit_npm_root_candidate "/opt/homebrew/lib/node_modules"
    emit_npm_root_candidate "/usr/local/lib/node_modules"
    emit_npm_root_candidate "/usr/lib/node_modules"

    local manager_dir=""
    local candidate=""
    for manager_dir in "${NVM_DIR:-}" "$HOME/.nvm"; do
        [[ -n "$manager_dir" && -d "$manager_dir" ]] || continue
        for candidate in "$manager_dir"/versions/node/*/lib/node_modules; do
            [[ -d "$candidate" ]] && emit_npm_root_candidate "$candidate"
        done
    done

    for manager_dir in "${FNM_DIR:-}" "$HOME/.fnm" "$HOME/.local/share/fnm"; do
        [[ -n "$manager_dir" && -d "$manager_dir" ]] || continue
        for candidate in "$manager_dir"/node-versions/*/installation/lib/node_modules; do
            [[ -d "$candidate" ]] && emit_npm_root_candidate "$candidate"
        done
    done

    for manager_dir in "${VOLTA_HOME:-}" "$HOME/.volta"; do
        [[ -n "$manager_dir" && -d "$manager_dir" ]] || continue
        for candidate in "$manager_dir"/tools/image/node/*/lib/node_modules; do
            [[ -d "$candidate" ]] && emit_npm_root_candidate "$candidate"
        done
    done
}

find_openclaw_global_installs() {
    local seen="|"
    local npm_root=""
    while IFS= read -r npm_root; do
        [[ -n "$npm_root" ]] || continue
        local package_dir="${npm_root%/}/openclaw"
        local package_json="${package_dir}/package.json"
        [[ -f "$package_json" ]] || continue

        local real_package_dir=""
        real_package_dir="$(canonicalize_dir "$package_dir" || true)"
        [[ -n "$real_package_dir" ]] || real_package_dir="$package_dir"
        case "$seen" in
            *"|${real_package_dir}|"*) continue ;;
        esac
        seen="${seen}${real_package_dir}|"

        local version=""
        version="$(openclaw_package_version "$package_json")"
        printf '%s\t%s\t%s\n' "$version" "$real_package_dir" "$npm_root"
    done < <(collect_openclaw_npm_root_candidates)
}

warn_duplicate_openclaw_global_installs() {
    local installs=()
    local line=""
    while IFS= read -r line; do
        [[ -n "$line" ]] && installs+=("$line")
    done < <(find_openclaw_global_installs)

    if [[ "${#installs[@]}" -le 1 ]]; then
        return 0
    fi

    ui_warn "Multiple OpenClaw global installs detected"
    echo "  Different Node/npm environments can run different OpenClaw versions."

    local active_node active_npm active_openclaw
    active_node="$(command -v node 2>/dev/null || true)"
    active_npm="$(command -v npm 2>/dev/null || true)"
    active_openclaw="${OPENCLAW_BIN:-}"
    if [[ -z "$active_openclaw" ]]; then
        active_openclaw="$(type -P openclaw 2>/dev/null || true)"
    fi
    echo -e "  Active node: ${INFO}${active_node:-none}${NC}"
    echo -e "  Active npm: ${INFO}${active_npm:-none}${NC}"
    echo -e "  Active openclaw: ${INFO}${active_openclaw:-none}${NC}"
    echo ""
    echo "  Found installs:"

    local install version package_dir npm_root
    for install in "${installs[@]}"; do
        IFS=$'\t' read -r version package_dir npm_root <<< "$install"
        echo -e "    - ${INFO}${version:-unknown}${NC}  ${package_dir}"
        echo -e "      npm root: ${MUTED}${npm_root}${NC}"
    done

    echo ""
    echo "  Keep one install source, then remove stale installs with that environment's npm:"
    echo "    npm uninstall -g openclaw"
}

refresh_shell_command_cache() {
    hash -r 2>/dev/null || true
}

path_has_dir() {
    local path="$1"
    local dir="${2%/}"
    if [[ -z "$dir" ]]; then
        return 1
    fi
    case ":${path}:" in
        *":${dir}:"*) return 0 ;;
        *) return 1 ;;
    esac
}

warn_shell_path_missing_dir() {
    local dir="${1%/}"
    local label="$2"
    if [[ -z "$dir" ]]; then
        return 0
    fi
    if path_has_dir "$ORIGINAL_PATH" "$dir"; then
        return 0
    fi

    echo ""
    ui_warn "PATH missing ${label}: ${dir}"
    echo "  This can make openclaw show as \"command not found\" in new terminals."
    echo "  Fix (zsh: ~/.zshrc, bash: ~/.bashrc):"
    echo "    export PATH=\"${dir}:\$PATH\""
}

ensure_npm_global_bin_on_path() {
    local bin_dir=""
    bin_dir="$(npm_global_bin_dir || true)"
    if [[ -n "$bin_dir" ]]; then
        export PATH="${bin_dir}:$PATH"
    fi
}

maybe_nodenv_rehash() {
    if command -v nodenv &> /dev/null; then
        nodenv rehash >/dev/null 2>&1 || true
    fi
}

warn_openclaw_not_found() {
    ui_warn "Installed, but openclaw is not discoverable on PATH in this shell"
    echo "  Try: hash -r (bash) or rehash (zsh), then retry."
    local t=""
    t="$(type -t openclaw 2>/dev/null || true)"
    if [[ "$t" == "alias" || "$t" == "function" ]]; then
        ui_warn "Found a shell ${t} named openclaw; it may shadow the real binary"
    fi
    if command -v nodenv &> /dev/null; then
        echo -e "Using nodenv? Run: ${INFO}nodenv rehash${NC}"
    fi

    local npm_prefix=""
    npm_prefix="$(npm prefix -g 2>/dev/null || true)"
    local npm_bin=""
    npm_bin="$(npm_global_bin_dir 2>/dev/null || true)"
    if [[ -n "$npm_prefix" ]]; then
        echo -e "npm prefix -g: ${INFO}${npm_prefix}${NC}"
    fi
    if [[ -n "$npm_bin" ]]; then
        echo -e "npm bin -g: ${INFO}${npm_bin}${NC}"
        echo -e "If needed: ${INFO}export PATH=\"${npm_bin}:\\$PATH\"${NC}"
    fi
}

resolve_openclaw_bin() {
    refresh_shell_command_cache
    local resolved=""
    resolved="$(type -P openclaw 2>/dev/null || true)"
    if [[ -n "$resolved" && -x "$resolved" ]]; then
        echo "$resolved"
        return 0
    fi

    ensure_npm_global_bin_on_path
    refresh_shell_command_cache
    resolved="$(type -P openclaw 2>/dev/null || true)"
    if [[ -n "$resolved" && -x "$resolved" ]]; then
        echo "$resolved"
        return 0
    fi

    local npm_bin=""
    npm_bin="$(npm_global_bin_dir || true)"
    if [[ -n "$npm_bin" && -x "${npm_bin}/openclaw" ]]; then
        echo "${npm_bin}/openclaw"
        return 0
    fi

    maybe_nodenv_rehash
    refresh_shell_command_cache
    resolved="$(type -P openclaw 2>/dev/null || true)"
    if [[ -n "$resolved" && -x "$resolved" ]]; then
        echo "$resolved"
        return 0
    fi

    if [[ -n "$npm_bin" && -x "${npm_bin}/openclaw" ]]; then
        echo "${npm_bin}/openclaw"
        return 0
    fi

    echo ""
    return 1
}

install_openclaw_from_git() {
    local repo_dir="$1"
    local repo_url="https://github.com/openclaw/openclaw.git"

    if [[ -d "$repo_dir/.git" ]]; then
        ui_info "Installing OpenClaw from git checkout: ${repo_dir}"
    else
        ui_info "Installing OpenClaw from GitHub (${repo_url})"
    fi

    if ! check_git; then
        install_git
    fi

    ensure_pnpm
    ensure_pnpm_binary_for_scripts

    if [[ ! -d "$repo_dir" ]]; then
        run_quiet_step "Cloning OpenClaw" git clone "$repo_url" "$repo_dir"
    fi

    if [[ "$GIT_UPDATE" == "1" ]]; then
        if [[ -z "$(git -C "$repo_dir" status --porcelain 2>/dev/null || true)" ]]; then
            run_quiet_step "Updating repository" git -C "$repo_dir" pull --rebase || true
        else
            ui_info "Repo has local changes; skipping git pull"
        fi
    fi

    cleanup_legacy_submodules "$repo_dir"

    SHARP_IGNORE_GLOBAL_LIBVIPS="$SHARP_IGNORE_GLOBAL_LIBVIPS" run_quiet_step "Installing dependencies" run_pnpm -C "$repo_dir" install

    if ! run_quiet_step "Building UI" run_pnpm -C "$repo_dir" ui:build; then
        ui_warn "UI build failed; continuing (CLI may still work)"
    fi
    run_quiet_step "Building OpenClaw" run_pnpm -C "$repo_dir" build

    ensure_user_local_bin_on_path

    cat > "$HOME/.local/bin/openclaw" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec node "${repo_dir}/dist/entry.js" "\$@"
EOF
    chmod +x "$HOME/.local/bin/openclaw"
    ui_success "OpenClaw wrapper installed to \$HOME/.local/bin/openclaw"
    ui_info "This checkout uses pnpm — run pnpm install (or corepack pnpm install) for deps"
}

# Install OpenClaw
resolve_beta_version() {
    local beta=""
    beta="$(npm view openclaw dist-tags.beta 2>/dev/null || true)"
    if [[ -z "$beta" || "$beta" == "undefined" || "$beta" == "null" ]]; then
        return 1
    fi
    echo "$beta"
}

to_lowercase_ascii() {
    # macOS still ships Bash 3.2, so avoid `${value,,}` here.
    printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]'
}

is_explicit_package_install_spec() {
    local value="${1:-}"
    [[ "$value" == *"://"* || "$value" == *"#"* || "$value" =~ ^(file|github|git\+ssh|git\+https|git\+http|git\+file|npm): ]]
}

can_resolve_registry_package_version() {
    local value="${1:-}"
    local normalized_value=""
    normalized_value="$(to_lowercase_ascii "$value")"
    if [[ -z "$value" ]]; then
        return 0
    fi
    if [[ "$normalized_value" == "main" ]]; then
        return 1
    fi
    if is_explicit_package_install_spec "$value"; then
        return 1
    fi
    return 0
}

resolve_package_install_spec() {
    local package_name="$1"
    local value="$2"
    local normalized_value=""
    normalized_value="$(to_lowercase_ascii "$value")"
    if [[ "$normalized_value" == "main" ]]; then
        echo "github:openclaw/openclaw#main"
        return 0
    fi
    if is_explicit_package_install_spec "$value"; then
        echo "$value"
        return 0
    fi
    if [[ "$value" == "latest" ]]; then
        echo "${package_name}@latest"
        return 0
    fi
    echo "${package_name}@${value}"
}

install_openclaw() {
    local package_name="openclaw"
    if [[ "$USE_BETA" == "1" ]]; then
        local beta_version=""
        beta_version="$(resolve_beta_version || true)"
        if [[ -n "$beta_version" ]]; then
            OPENCLAW_VERSION="$beta_version"
            ui_info "Beta tag detected (${beta_version})"
            package_name="openclaw"
        else
            OPENCLAW_VERSION="latest"
            ui_info "No beta tag found; using latest"
        fi
    fi

    if [[ -z "${OPENCLAW_VERSION}" ]]; then
        OPENCLAW_VERSION="latest"
    fi

    local resolved_version=""
    if can_resolve_registry_package_version "${OPENCLAW_VERSION}"; then
        resolved_version="$(npm view "${package_name}@${OPENCLAW_VERSION}" version 2>/dev/null || true)"
    fi
    if [[ -n "$resolved_version" ]]; then
        ui_info "Installing OpenClaw v${resolved_version}"
    else
        ui_info "Installing OpenClaw (${OPENCLAW_VERSION})"
    fi
    local install_spec=""
    install_spec="$(resolve_package_install_spec "${package_name}" "${OPENCLAW_VERSION}")"

    if ! install_openclaw_npm "${install_spec}"; then
        ui_warn "npm install failed; retrying"
        cleanup_npm_openclaw_paths
        install_openclaw_npm "${install_spec}"
    fi

    if [[ "${OPENCLAW_VERSION}" == "latest" && "${package_name}" == "openclaw" ]]; then
        if ! resolve_openclaw_bin &> /dev/null; then
            ui_warn "npm install openclaw@latest failed; retrying openclaw@next"
            cleanup_npm_openclaw_paths
            install_openclaw_npm "openclaw@next"
        fi
    fi

    ensure_openclaw_bin_link || true

    ui_success "OpenClaw installed"
}

# Run doctor for migrations (safe, non-interactive)
run_doctor() {
    ui_info "Running doctor to migrate settings"
    local claw="${OPENCLAW_BIN:-}"
    if [[ -z "$claw" ]]; then
        claw="$(resolve_openclaw_bin || true)"
    fi
    if [[ -z "$claw" ]]; then
        ui_info "Skipping doctor (openclaw not on PATH yet)"
        warn_openclaw_not_found
        return 0
    fi
    run_quiet_step "Running doctor" "$claw" doctor --non-interactive || true
    ui_success "Doctor complete"
}

maybe_open_dashboard() {
    local claw="${OPENCLAW_BIN:-}"
    if [[ -z "$claw" ]]; then
        claw="$(resolve_openclaw_bin || true)"
    fi
    if [[ -z "$claw" ]]; then
        return 0
    fi
    if ! "$claw" dashboard --help >/dev/null 2>&1; then
        return 0
    fi
    "$claw" dashboard || true
}

resolve_workspace_dir() {
    local profile="${OPENCLAW_PROFILE:-default}"
    if [[ "${profile}" != "default" ]]; then
        echo "${HOME}/.openclaw/workspace-${profile}"
    else
        echo "${HOME}/.openclaw/workspace"
    fi
}

run_bootstrap_onboarding_if_needed() {
    if [[ "${NO_ONBOARD}" == "1" ]]; then
        return
    fi

    local config_path="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
    if [[ -f "${config_path}" || -f "$HOME/.clawdbot/clawdbot.json" ]]; then
        return
    fi

    local workspace
    workspace="$(resolve_workspace_dir)"
    local bootstrap="${workspace}/BOOTSTRAP.md"

    if [[ ! -f "${bootstrap}" ]]; then
        return
    fi

    if [[ ! -r /dev/tty || ! -w /dev/tty ]]; then
        ui_info "BOOTSTRAP.md found but no TTY; run openclaw onboard to finish setup"
        return
    fi

    ui_info "BOOTSTRAP.md found; starting onboarding"
    local claw="${OPENCLAW_BIN:-}"
    if [[ -z "$claw" ]]; then
        claw="$(resolve_openclaw_bin || true)"
    fi
    if [[ -z "$claw" ]]; then
        ui_info "BOOTSTRAP.md found but openclaw not on PATH; skipping onboarding"
        warn_openclaw_not_found
        return
    fi

    "$claw" onboard || {
        ui_error "Onboarding failed; run openclaw onboard to retry"
        return
    }
}

load_install_version_helpers() {
    local source_path="${BASH_SOURCE[0]-}"
    local script_dir=""
    local helper_path=""
    if [[ -z "$source_path" || ! -f "$source_path" ]]; then
        return 0
    fi
    script_dir="$(cd "$(dirname "$source_path")" && pwd 2>/dev/null || true)"
    helper_path="${script_dir}/docker/install-sh-common/version-parse.sh"
    if [[ -n "$script_dir" && -r "$helper_path" ]]; then
        # shellcheck source=docker/install-sh-common/version-parse.sh
        source "$helper_path"
    fi
}

load_install_version_helpers

if ! declare -F extract_openclaw_semver >/dev/null 2>&1; then
# Inline fallback when version-parse.sh could not be sourced (for example, stdin install).
extract_openclaw_semver() {
    local raw="${1:-}"
    raw="${raw//$'\r'/}"
    if [[ "$raw" =~ v?([0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?(\+[0-9A-Za-z.-]+)?) ]]; then
        printf '%s' "${BASH_REMATCH[1]}"
    fi
}
fi

resolve_openclaw_version() {
    local version=""
    local raw_version_output=""
    local claw="${OPENCLAW_BIN:-}"
    if [[ -z "$claw" ]] && command -v openclaw &> /dev/null; then
        claw="$(command -v openclaw)"
    fi
    if [[ -n "$claw" ]]; then
        raw_version_output=$("$claw" --version 2>/dev/null || true)
        raw_version_output="${raw_version_output%%$'\n'*}"
        raw_version_output="${raw_version_output//$'\r'/}"
        version="$(extract_openclaw_semver "$raw_version_output")"
        if [[ -z "$version" ]]; then
            version="$raw_version_output"
        fi
    fi
    if [[ -z "$version" ]]; then
        local npm_root=""
        npm_root=$(npm root -g 2>/dev/null || true)
        if [[ -n "$npm_root" && -f "$npm_root/openclaw/package.json" ]]; then
            version=$(node -e "console.log(require('${npm_root}/openclaw/package.json').version)" 2>/dev/null || true)
        fi
    fi
    echo "$version"
}

is_gateway_daemon_loaded() {
    local claw="$1"
    if [[ -z "$claw" ]]; then
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
    local claw="${OPENCLAW_BIN:-}"
    if [[ -z "$claw" ]]; then
        claw="$(resolve_openclaw_bin || true)"
    fi
    if [[ -z "$claw" ]]; then
        return 0
    fi

    if ! is_gateway_daemon_loaded "$claw"; then
        return 0
    fi

    ui_info "Refreshing loaded gateway service"
    if run_quiet_step "Refreshing gateway service" "$claw" gateway install --force; then
        ui_success "Gateway service metadata refreshed"
    else
        ui_warn "Gateway service refresh failed; continuing"
        return 0
    fi

    if run_quiet_step "Restarting gateway service" "$claw" gateway restart; then
        ui_success "Gateway service restarted"
    else
        ui_warn "Gateway service restart failed; continuing"
        return 0
    fi

    run_quiet_step "Probing gateway service" "$claw" gateway status --deep || true
}

verify_installation() {
    if [[ "${VERIFY_INSTALL}" != "1" ]]; then
        return 0
    fi

    ui_stage "Verifying installation"
    local claw="${OPENCLAW_BIN:-}"
    if [[ -z "$claw" ]]; then
        claw="$(resolve_openclaw_bin || true)"
    fi
    if [[ -z "$claw" ]]; then
        ui_error "Install verify failed: openclaw not on PATH yet"
        warn_openclaw_not_found
        return 1
    fi

    run_quiet_step "Checking OpenClaw version" "$claw" --version || return 1

    if is_gateway_daemon_loaded "$claw"; then
        run_quiet_step "Checking gateway service" "$claw" gateway status --deep || {
            ui_error "Install verify failed: gateway service unhealthy"
            ui_info "Run: openclaw gateway status --deep"
            return 1
        }
    else
        ui_info "Gateway service not loaded; skipping gateway deep probe"
    fi

    ui_success "Install verify complete"
}

# Main installation flow
main() {
    if [[ "$HELP" == "1" ]]; then
        print_usage
        return 0
    fi

    # bootstrap_gum_temp may perform network downloads before any spinner is available.
    echo -e "${INFO}Preparing installer interface...${NC}"
    bootstrap_gum_temp || true
    print_installer_banner
    print_gum_status
    detect_os_or_die

    if [[ "$OS" == "linux" ]]; then
        export DEBIAN_FRONTEND="${DEBIAN_FRONTEND:-noninteractive}"
        export NEEDRESTART_MODE="${NEEDRESTART_MODE:-a}"
    fi

    local detected_checkout=""
    detected_checkout="$(detect_openclaw_checkout "$PWD" || true)"

    if [[ -z "$INSTALL_METHOD" && -n "$detected_checkout" ]]; then
        if ! is_promptable; then
            ui_info "Found OpenClaw checkout but no TTY; defaulting to npm install"
            INSTALL_METHOD="npm"
        else
            local selected_method=""
            selected_method="$(choose_install_method_interactive "$detected_checkout" || true)"
            case "$selected_method" in
                git|npm)
                    INSTALL_METHOD="$selected_method"
                    ;;
                *)
                    ui_error "no install method selected"
                    echo "Re-run with: --install-method git|npm (or set OPENCLAW_INSTALL_METHOD)."
                    exit 2
                    ;;
            esac
        fi
    fi

    if [[ -z "$INSTALL_METHOD" ]]; then
        INSTALL_METHOD="npm"
    fi

    if [[ "$INSTALL_METHOD" != "npm" && "$INSTALL_METHOD" != "git" ]]; then
        ui_error "invalid --install-method: ${INSTALL_METHOD}"
        echo "Use: --install-method npm|git"
        exit 2
    fi

    show_install_plan "$detected_checkout"

    if [[ "$DRY_RUN" == "1" ]]; then
        ui_success "Dry run complete (no changes made)"
        return 0
    fi

    # Check for existing installation
    local is_upgrade=false
    if check_existing_openclaw; then
        is_upgrade=true
    fi
    local should_open_dashboard=false
    local skip_onboard=false

    ui_stage "Preparing environment"

    # Step 1: Homebrew (macOS only)
    install_homebrew

    # Step 2: Node.js
    load_nvm_for_node_detection
    if ! check_node; then
        install_node
    fi
    if ! ensure_default_node_active_shell; then
        exit 1
    fi

    ui_stage "Installing OpenClaw"

    local final_git_dir=""
    if [[ "$INSTALL_METHOD" == "git" ]]; then
        # Clean up npm global install if switching to git
        if npm list -g openclaw &>/dev/null; then
            ui_info "Removing npm global install (switching to git)"
            npm uninstall -g openclaw 2>/dev/null || true
            ui_success "npm global install removed"
        fi

        local repo_dir="$GIT_DIR"
        if [[ -n "$detected_checkout" ]]; then
            repo_dir="$detected_checkout"
        fi
        final_git_dir="$repo_dir"
        install_openclaw_from_git "$repo_dir"
    else
        # Clean up git wrapper if switching to npm
        if [[ -x "$HOME/.local/bin/openclaw" ]]; then
            ui_info "Removing git wrapper (switching to npm)"
            rm -f "$HOME/.local/bin/openclaw"
            ui_success "git wrapper removed"
        fi

        # Step 3: Git (required for npm installs that may fetch from git or apply patches)
        if ! check_git; then
            install_git
        fi

        # Step 4: npm permissions (Linux)
        fix_npm_permissions

        # Step 5: OpenClaw
        install_openclaw
    fi

    ui_stage "Finalizing setup"

    OPENCLAW_BIN="$(resolve_openclaw_bin || true)"
    warn_duplicate_openclaw_global_installs || true

    # PATH warning: installs can succeed while the user's login shell still lacks npm's global bin dir.
    local npm_bin=""
    npm_bin="$(npm_global_bin_dir || true)"
    if [[ "$INSTALL_METHOD" == "npm" ]]; then
        warn_shell_path_missing_dir "$npm_bin" "npm global bin dir"
    fi
    if [[ "$INSTALL_METHOD" == "git" ]]; then
        if [[ -x "$HOME/.local/bin/openclaw" ]]; then
            warn_shell_path_missing_dir "$HOME/.local/bin" "user-local bin dir (~/.local/bin)"
        fi
    fi

    refresh_gateway_service_if_loaded

    # Step 6: Run doctor for migrations on upgrades and git installs
    local run_doctor_after=false
    if [[ "$is_upgrade" == "true" || "$INSTALL_METHOD" == "git" ]]; then
        run_doctor_after=true
    fi
    if [[ "$run_doctor_after" == "true" ]]; then
        run_doctor
        should_open_dashboard=true
    fi

    # Step 7: If BOOTSTRAP.md is still present in the workspace, resume onboarding
    run_bootstrap_onboarding_if_needed

    local installed_version
    installed_version=$(resolve_openclaw_version)

    echo ""
    if [[ -n "$installed_version" ]]; then
        ui_celebrate "🦞 OpenClaw installed successfully (${installed_version})!"
    else
        ui_celebrate "🦞 OpenClaw installed successfully!"
    fi
    if [[ "$is_upgrade" == "true" ]]; then
        local update_messages=(
            "Leveled up! New skills unlocked. You're welcome."
            "Fresh code, same lobster. Miss me?"
            "Back and better. Did you even notice I was gone?"
            "Update complete. I learned some new tricks while I was out."
            "Upgraded! Now with 23% more sass."
            "I've evolved. Try to keep up. 🦞"
            "New version, who dis? Oh right, still me but shinier."
            "Patched, polished, and ready to pinch. Let's go."
            "The lobster has molted. Harder shell, sharper claws."
            "Update done! Check the changelog or just trust me, it's good."
            "Reborn from the boiling waters of npm. Stronger now."
            "I went away and came back smarter. You should try it sometime."
            "Update complete. The bugs feared me, so they left."
            "New version installed. Old version sends its regards."
            "Firmware fresh. Brain wrinkles: increased."
            "I've seen things you wouldn't believe. Anyway, I'm updated."
            "Back online. The changelog is long but our friendship is longer."
            "Upgraded! Peter fixed stuff. Blame him if it breaks."
            "Molting complete. Please don't look at my soft shell phase."
            "Version bump! Same chaos energy, fewer crashes (probably)."
        )
        local update_message
        update_message="${update_messages[RANDOM % ${#update_messages[@]}]}"
        echo -e "${MUTED}${update_message}${NC}"
    else
        local completion_messages=(
            "Ahh nice, I like it here. Got any snacks? "
            "Home sweet home. Don't worry, I won't rearrange the furniture."
            "I'm in. Let's cause some responsible chaos."
            "Installation complete. Your productivity is about to get weird."
            "Settled in. Time to automate your life whether you're ready or not."
            "Cozy. I've already read your calendar. We need to talk."
            "Finally unpacked. Now point me at your problems."
            "cracks claws Alright, what are we building?"
            "The lobster has landed. Your terminal will never be the same."
            "All done! I promise to only judge your code a little bit."
        )
        local completion_message
        completion_message="${completion_messages[RANDOM % ${#completion_messages[@]}]}"
        echo -e "${MUTED}${completion_message}${NC}"
    fi
    echo ""

    if [[ "$INSTALL_METHOD" == "git" && -n "$final_git_dir" ]]; then
        ui_section "Source install details"
        ui_kv "Checkout" "$final_git_dir"
        ui_kv "Wrapper" "$HOME/.local/bin/openclaw"
        ui_kv "Update command" "openclaw update"
        ui_kv "Switch to npm" "curl -fsSL --proto '=https' --tlsv1.2 https://openclaw.ai/install.sh | bash -s -- --install-method npm"
    elif [[ "$is_upgrade" == "true" ]]; then
        ui_info "Upgrade complete"
        if [[ -r /dev/tty && -w /dev/tty ]]; then
            local claw="${OPENCLAW_BIN:-}"
            if [[ -z "$claw" ]]; then
                claw="$(resolve_openclaw_bin || true)"
            fi
            if [[ -z "$claw" ]]; then
                ui_info "Skipping doctor (openclaw not on PATH yet)"
                warn_openclaw_not_found
                return 0
            fi
            local -a doctor_args=()
            if [[ "$NO_ONBOARD" == "1" || "$NO_PROMPT" == "1" ]]; then
                doctor_args+=("--non-interactive")
            fi
            ui_info "Running openclaw doctor"
            local doctor_ok=0
            if (( ${#doctor_args[@]} )); then
                OPENCLAW_UPDATE_IN_PROGRESS=1 "$claw" doctor "${doctor_args[@]}" </dev/null && doctor_ok=1
            else
                OPENCLAW_UPDATE_IN_PROGRESS=1 "$claw" doctor </dev/tty && doctor_ok=1
            fi
            if (( doctor_ok )); then
                ui_info "Updating plugins"
                OPENCLAW_UPDATE_IN_PROGRESS=1 "$claw" plugins update --all || true
            else
                ui_warn "Doctor failed; skipping plugin updates"
            fi
        else
            ui_info "No TTY; run openclaw doctor and openclaw plugins update --all manually"
        fi
    else
        if [[ "$NO_ONBOARD" == "1" || "$skip_onboard" == "true" ]]; then
            ui_info "Skipping onboard (requested); run openclaw onboard later"
        else
            local config_path="${OPENCLAW_CONFIG_PATH:-$HOME/.openclaw/openclaw.json}"
            if [[ -f "${config_path}" || -f "$HOME/.clawdbot/clawdbot.json" ]]; then
                ui_info "Config already present; running doctor"
                run_doctor
                should_open_dashboard=true
                ui_info "Config already present; skipping onboarding"
                skip_onboard=true
            fi
            ui_info "Starting setup"
            echo ""
            if [[ -r /dev/tty && -w /dev/tty ]]; then
                local claw="${OPENCLAW_BIN:-}"
                if [[ -z "$claw" ]]; then
                    claw="$(resolve_openclaw_bin || true)"
                fi
                if [[ -z "$claw" ]]; then
                    ui_info "Skipping onboarding (openclaw not on PATH yet)"
                    warn_openclaw_not_found
                    return 0
                fi
                exec </dev/tty
                exec "$claw" onboard
            fi
            ui_info "No TTY; run openclaw onboard to finish setup"
            return 0
        fi
    fi

    if command -v openclaw &> /dev/null; then
        local claw="${OPENCLAW_BIN:-}"
        if [[ -z "$claw" ]]; then
            claw="$(resolve_openclaw_bin || true)"
        fi
        if [[ -n "$claw" ]] && is_gateway_daemon_loaded "$claw"; then
            if [[ "$DRY_RUN" == "1" ]]; then
                ui_info "Gateway daemon detected; would restart (openclaw daemon restart)"
            else
                ui_info "Gateway daemon detected; restarting"
                if OPENCLAW_UPDATE_IN_PROGRESS=1 "$claw" daemon restart >/dev/null 2>&1; then
                    ui_success "Gateway restarted"
                else
                    ui_warn "Gateway restart failed; try: openclaw daemon restart"
                fi
            fi
        fi
    fi

    if ! verify_installation; then
        exit 1
    fi

    if [[ "$should_open_dashboard" == "true" ]]; then
        maybe_open_dashboard
    fi

    show_footer_links
}

if [[ "${OPENCLAW_INSTALL_SH_NO_RUN:-0}" != "1" ]]; then
    parse_args "$@"
    configure_verbose
    main
fi
