#!/usr/bin/env bash

REQUIRED_SWIFT_TOOLS_MAJOR=6
REQUIRED_SWIFT_TOOLS_MINOR=2

require_swift_toolchain() {
  local swift_version
  if ! swift_version="$(swift --version 2>&1)"; then
    printf '%s\n' "$swift_version" >&2
    echo "ERROR: OpenClaw macOS app packaging requires Swift tools ${REQUIRED_SWIFT_TOOLS_MAJOR}.${REQUIRED_SWIFT_TOOLS_MINOR}+." >&2
    echo "       Install/select Xcode 26.x or newer before running macOS packaging scripts." >&2
    return 1
  fi

  local major_minor
  major_minor="$(printf '%s\n' "$swift_version" | sed -nE 's/.*Apple Swift version ([0-9]+)\.([0-9]+).*/\1 \2/p' | head -n 1)"
  if [[ -z "$major_minor" ]]; then
    printf '%s\n' "$swift_version" >&2
    echo "ERROR: Could not parse selected Swift toolchain version." >&2
    echo "       OpenClaw macOS app packaging requires Swift tools ${REQUIRED_SWIFT_TOOLS_MAJOR}.${REQUIRED_SWIFT_TOOLS_MINOR}+." >&2
    return 1
  fi

  local major minor
  read -r major minor <<< "$major_minor"
  if (( major < REQUIRED_SWIFT_TOOLS_MAJOR )) ||
    (( major == REQUIRED_SWIFT_TOOLS_MAJOR && minor < REQUIRED_SWIFT_TOOLS_MINOR )); then
    printf '%s\n' "$swift_version" >&2
    echo "ERROR: OpenClaw macOS app packaging requires Swift tools ${REQUIRED_SWIFT_TOOLS_MAJOR}.${REQUIRED_SWIFT_TOOLS_MINOR}+." >&2
    echo "       Current Swift is ${major}.${minor}; install/select Xcode 26.x or newer." >&2
    return 1
  fi
}
