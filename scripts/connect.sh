#!/usr/bin/env bash
set -eEuo pipefail

# Dormant fresh-machine session-host bootstrap. Public website activation is a
# separate release/publish step; this repository wrapper is safe to invoke directly.

umask 077

VERSION=""
PREFIX="${OPENCLAW_PREFIX:-}"
DISPLAY_NAME=""
JOIN_TARGET=""
TEMP_DIR=""
FAILURE_CONTEXT="Connect setup failed. Review the preceding output and retry."
ERROR_REPORTED=0

print_usage() {
  cat <<'EOF'
Usage: connect.sh --version <exact-version> [--prefix <path>] [--display-name <name>] <join-target>

Installs an exact OpenClaw CLI version, connects the machine as a worker-session
host, and installs the node service. The join target is handed to OpenClaw through
a private temporary file, never as a child-process argument.

Options:
  --version <exact-version>  Required exact version, for example 2026.8.1
  --prefix <path>            Install prefix (default: ~/.openclaw or $OPENCLAW_PREFIX)
  --display-name <name>      Override the node display name
  -h, --help                 Show this help

Environment:
  OPENCLAW_INSTALL_CLI_URL   HTTPS installer URL, file:// URL, or local installer path
EOF
}

cleanup() {
  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf -- "$TEMP_DIR"
  fi
}

on_exit() {
  local status=$?
  cleanup
  if [[ $status -ne 0 && $ERROR_REPORTED -eq 0 ]]; then
    printf 'ERROR: %s\n' "$FAILURE_CONTEXT" >&2
  fi
}
trap on_exit EXIT

fail() {
  ERROR_REPORTED=1
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

require_value() {
  local option="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    fail "${option} requires a value. Run connect.sh --help for usage."
  fi
}

is_exact_version() {
  local value="$1"
  local number='(0|[1-9][0-9]*)'
  local prerelease='(0|[1-9][0-9]*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)'
  local pattern="^${number}\\.${number}\\.${number}(-${prerelease}(\\.${prerelease})*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$"
  [[ "$value" =~ $pattern ]]
}

require_home_for_prefix() {
  local message="$1"
  local home="${HOME:-}"
  if [[ -z "$home" || "$home" == "/" || ! -d "$home" ]]; then
    fail "$message"
  fi
}

resolve_prefix() {
  case "$PREFIX" in
    \~)
      require_home_for_prefix "Cannot expand prefix '~': HOME is unavailable. Pass an absolute --prefix or set OPENCLAW_PREFIX."
      PREFIX="$HOME"
      ;;
    \~/*)
      require_home_for_prefix "Cannot expand prefix '${PREFIX}': HOME is unavailable. Pass an absolute --prefix or set OPENCLAW_PREFIX."
      PREFIX="${HOME}${PREFIX:1}"
      ;;
    /*) ;;
    *) PREFIX="${PWD}/${PREFIX}" ;;
  esac
}

download_installer() {
  local source="$1"
  local destination="$2"
  local local_path=""

  if [[ -f "$source" ]]; then
    cp -- "$source" "$destination"
    return
  fi
  case "$source" in
    file://*)
      local_path="${source#file://}"
      [[ -f "$local_path" ]] || fail "Installer override does not exist: ${local_path}"
      cp -- "$local_path" "$destination"
      ;;
    https://*)
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL --proto '=https' --tlsv1.2 \
          --speed-limit 1 --speed-time 30 \
          --retry 3 --retry-delay 1 --retry-connrefused \
          -o "$destination" -- "$source"
      elif command -v wget >/dev/null 2>&1; then
        wget -q --https-only --secure-protocol=TLSv1_2 --tries=3 --timeout=20 \
          -O "$destination" -- "$source"
      else
        fail "Missing downloader. Install curl or wget, then retry."
      fi
      ;;
    *)
      fail "OPENCLAW_INSTALL_CLI_URL must be HTTPS or a readable local installer path."
      ;;
  esac
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      require_value "$1" "${2:-}"
      VERSION="$2"
      shift 2
      ;;
    --prefix)
      require_value "$1" "${2:-}"
      PREFIX="$2"
      shift 2
      ;;
    --display-name)
      require_value "$1" "${2:-}"
      DISPLAY_NAME="$2"
      shift 2
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    --*)
      fail "Unknown option: $1. Run connect.sh --help for usage."
      ;;
    *)
      if [[ -n "$JOIN_TARGET" ]]; then
        fail "Exactly one join target is required. Run connect.sh --help for usage."
      fi
      JOIN_TARGET="$1"
      shift
      ;;
  esac
done

[[ -n "$VERSION" ]] || fail "--version is required and must name an exact published version."
if ! is_exact_version "$VERSION"; then
  fail "Invalid --version '${VERSION}'. Use an exact registry version such as 2026.8.1; leading v, moving tags, ranges, and wildcards are not allowed."
fi
[[ -n "$JOIN_TARGET" ]] || fail "A join target is required. Mint one with 'openclaw devices join-code' and retry."
if [[ -z "$PREFIX" ]]; then
  require_home_for_prefix "Cannot resolve the default install prefix: pass --prefix, set OPENCLAW_PREFIX, or provide an existing HOME directory."
  PREFIX="${HOME}/.openclaw"
fi

resolve_prefix
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-connect.XXXXXX")"
chmod 0700 "$TEMP_DIR"
INSTALLER_PATH="${TEMP_DIR}/install-cli.sh"
TARGET_FILE="${TEMP_DIR}/join-target"
INSTALLER_SOURCE="${OPENCLAW_INSTALL_CLI_URL:-https://openclaw.ai/install-cli.sh}"

FAILURE_CONTEXT="Could not obtain the OpenClaw CLI installer. Check network access or OPENCLAW_INSTALL_CLI_URL, then retry."
download_installer "$INSTALLER_SOURCE" "$INSTALLER_PATH"
[[ -s "$INSTALLER_PATH" ]] || fail "The OpenClaw CLI installer was empty. Check the installer source and retry."
chmod 0700 "$INSTALLER_PATH"

FAILURE_CONTEXT="OpenClaw CLI installation failed. Verify the exact version and install prefix, then retry."
bash "$INSTALLER_PATH" --version "$VERSION" --prefix "$PREFIX" --no-onboard

OPENCLAW_BIN="${PREFIX}/bin/openclaw"
[[ -x "$OPENCLAW_BIN" ]] || fail "Installed OpenClaw CLI is missing at ${OPENCLAW_BIN}. Check the installer output and retry."

: >"$TARGET_FILE"
chmod 0600 "$TARGET_FILE"
printf '%s\n' "$JOIN_TARGET" >"$TARGET_FILE"
JOIN_TARGET=""

CONNECT_ARGS=(connect --target-file "$TARGET_FILE" --service --session-host)
if [[ -n "$DISPLAY_NAME" ]]; then
  CONNECT_ARGS+=(--display-name "$DISPLAY_NAME")
fi

FAILURE_CONTEXT="OpenClaw could not connect or install the session-host service. Mint a fresh join target, verify Gateway reachability, and retry."
"$OPENCLAW_BIN" "${CONNECT_ARGS[@]}"

printf 'OpenClaw session-host service installed.\n'
