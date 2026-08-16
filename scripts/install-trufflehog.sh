#!/usr/bin/env bash
set -euo pipefail

trufflehog_version="3.95.9"
trufflehog_bin_dir="${OPENCLAW_TRUFFLEHOG_BIN_DIR:-/usr/local/bin}"

log() {
  printf 'trufflehog-install: %s\n' "$*" >&2
}

run_as_root() {
  local writable_ancestor="$trufflehog_bin_dir"
  while [[ ! -e "$writable_ancestor" && "$writable_ancestor" != "/" ]]; do
    writable_ancestor="$(dirname "$writable_ancestor")"
  done
  if [[ "$(id -u)" -eq 0 || -w "$trufflehog_bin_dir" || -w "$writable_ancestor" ]]; then
    "$@"
    return
  fi
  if ! command -v sudo >/dev/null 2>&1; then
    log "sudo is required to install into $trufflehog_bin_dir"
    return 1
  fi
  sudo "$@"
}

ensure_trufflehog_bin_dir() {
  if [[ -d "$trufflehog_bin_dir" ]]; then
    return 0
  fi
  if [[ -e "$trufflehog_bin_dir" ]]; then
    log "install path exists but is not a directory: $trufflehog_bin_dir"
    return 1
  fi
  run_as_root install -d -m 0755 "$trufflehog_bin_dir"
}

trufflehog_arch() {
  case "$1" in
    x86_64 | amd64) printf '%s\n' "amd64" ;;
    aarch64 | arm64) printf '%s\n' "arm64" ;;
    *)
      log "unsupported Linux architecture: $1"
      return 1
      ;;
  esac
}

trufflehog_sha256() {
  case "$1" in
    amd64) printf '%s\n' "f6d1106b85107d79527ed7a5b98b592beadd8b770dc3c9e8c1ad99e1b2cf127e" ;;
    arm64) printf '%s\n' "9d9c2ec4ea36a089a9c5aaafe1969d176013ddf9f44d68e8cd75291aed8c83ed" ;;
    *)
      log "unsupported TruffleHog architecture: $1"
      return 1
      ;;
  esac
}

trufflehog_binary_ready() {
  local binary="$1"
  [[ -x "$binary" ]] &&
    "$binary" --no-update --version 2>/dev/null |
      awk -v version="$trufflehog_version" '
        {
          for (field = 1; field <= NF; field++) {
            if ($field == version) {
              found = 1
            }
          }
        }
        END { exit found ? 0 : 1 }
      '
}

install_trufflehog() {
  local arch archive candidate checksum target tmp_dir url

  if [[ "$(uname -s)" != "Linux" ]]; then
    log "this installer supports Linux Testbox environments only"
    return 1
  fi

  target="$trufflehog_bin_dir/trufflehog"
  if trufflehog_binary_ready "$target"; then
    log "TruffleHog $trufflehog_version is already installed"
    return 0
  fi

  arch="$(trufflehog_arch "$(uname -m)")"
  checksum="$(trufflehog_sha256 "$arch")"
  archive="trufflehog_${trufflehog_version}_linux_${arch}.tar.gz"
  url="https://github.com/trufflesecurity/trufflehog/releases/download/v${trufflehog_version}/${archive}"
  tmp_dir="$(mktemp -d)"

  if ! curl -fsSL --retry 3 --output "$tmp_dir/$archive" "$url" ||
    ! (
      cd "$tmp_dir"
      printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -
    ) ||
    ! tar --no-same-owner -xzf "$tmp_dir/$archive" -C "$tmp_dir" trufflehog; then
    rm -rf "$tmp_dir"
    return 1
  fi

  ensure_trufflehog_bin_dir
  candidate="$(run_as_root mktemp "${target}.tmp.XXXXXX")"
  if ! run_as_root install -m 0755 "$tmp_dir/trufflehog" "$candidate" ||
    ! trufflehog_binary_ready "$candidate" ||
    ! run_as_root mv -f "$candidate" "$target"; then
    run_as_root rm -f "$candidate" || true
    rm -rf "$tmp_dir"
    return 1
  fi

  rm -rf "$tmp_dir"
  log "installed TruffleHog $trufflehog_version at $target"
}

if [[ "${OPENCLAW_TRUFFLEHOG_SOURCE_ONLY:-0}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

install_trufflehog
