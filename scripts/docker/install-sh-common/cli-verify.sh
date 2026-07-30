#!/usr/bin/env bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./version-parse.sh
source "$SCRIPT_DIR/version-parse.sh"

verify_installed_cli() {
  local package_name="$1"
  local expected_version="$2"
  local cli_name="$package_name"
  local cmd_path=""
  local entry_path=""
  local npm_root=""
  local installed_version=""

  cmd_path="$(command -v "$cli_name" || true)"
  if [[ -z "$cmd_path" && -x "$HOME/.npm-global/bin/$package_name" ]]; then
    cmd_path="$HOME/.npm-global/bin/$package_name"
  fi

  if [[ -z "$cmd_path" ]]; then
    npm_root="$(quiet_npm root -g 2>/dev/null || true)"
    if [[ -n "$npm_root" && -f "$npm_root/$package_name/dist/entry.js" ]]; then
      entry_path="$npm_root/$package_name/dist/entry.js"
    fi
  fi

  if [[ -z "$cmd_path" && -z "$entry_path" ]]; then
    echo "ERROR: $package_name is not on PATH" >&2
    return 1
  fi

  if [[ -n "$cmd_path" ]]; then
    installed_version="$("$cmd_path" --version 2>/dev/null | head -n 1 | tr -d '\r')"
  else
    installed_version="$(node "$entry_path" --version 2>/dev/null | head -n 1 | tr -d '\r')"
  fi

  installed_version="$(extract_openclaw_semver "$installed_version")"

  echo "cli=$cli_name installed=$installed_version expected=$expected_version"
  # Some published packages carry a numeric npm repack suffix (for example
  # 2026.7.1-2) while the bundled CLI reports the underlying release version.
  # Preserve exact checks for prereleases such as -beta.4.
  local expected_cli_version="$expected_version"
  if [[ "$expected_cli_version" =~ ^([0-9]+\.[0-9]+\.[0-9]+)-[0-9]+$ ]]; then
    expected_cli_version="${BASH_REMATCH[1]}"
  fi
  if [[ "$installed_version" != "$expected_cli_version" ]]; then
    echo "ERROR: expected ${cli_name}@${expected_version}, got ${cli_name}@${installed_version}" >&2
    return 1
  fi

  echo "==> Sanity: CLI runs"
  if [[ -n "$cmd_path" ]]; then
    "$cmd_path" --help >/dev/null
  else
    node "$entry_path" --help >/dev/null
  fi
}
