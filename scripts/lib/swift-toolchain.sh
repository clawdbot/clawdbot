#!/bin/bash

REQUIRED_SWIFT_TOOLS_MAJOR=6
REQUIRED_SWIFT_TOOLS_MINOR=3
REQUIRED_XCODE_MAJOR=26
REQUIRED_XCODE_MINOR=4

require_swift_toolchain() {
  local xcodebuild_version
  if ! xcodebuild_version="$(xcrun xcodebuild -version 2>&1)"; then
    printf '%s\n' "$xcodebuild_version" >&2
    echo "ERROR: OpenClaw macOS app packaging requires a full Xcode developer directory." >&2
    echo "       Command Line Tools do not include the required SwiftUI macro plugins." >&2
    echo "       Use: sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
    echo "       Or set: DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer" >&2
    return 1
  fi

  local swift_version
  if ! swift_version="$(swift --version 2>&1)"; then
    printf '%s\n' "$swift_version" >&2
    echo "ERROR: OpenClaw macOS app packaging requires Swift tools ${REQUIRED_SWIFT_TOOLS_MAJOR}.${REQUIRED_SWIFT_TOOLS_MINOR}+." >&2
    echo "       Install/select Xcode 26.4 or newer before running macOS packaging scripts." >&2
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
    echo "       Current Swift is ${major}.${minor}; install/select Xcode 26.4 or newer." >&2
    return 1
  fi

  local xcode_major_minor xcode_major xcode_minor
  xcode_major_minor="$(printf '%s\n' "$xcodebuild_version" | sed -nE 's/^Xcode ([0-9]+)\.([0-9]+).*/\1 \2/p' | head -n 1)"
  if [[ -z "$xcode_major_minor" ]]; then
    printf '%s\n' "$xcodebuild_version" >&2
    echo "ERROR: Could not parse selected Xcode version; OpenClaw macOS app packaging requires Xcode 26.4+." >&2
    return 1
  fi

  read -r xcode_major xcode_minor <<< "$xcode_major_minor"
  if (( xcode_major < REQUIRED_XCODE_MAJOR )) ||
    (( xcode_major == REQUIRED_XCODE_MAJOR && xcode_minor < REQUIRED_XCODE_MINOR )); then
    printf '%s\n' "$xcodebuild_version" >&2
    echo "ERROR: OpenClaw macOS app packaging requires Xcode 26.4+; current Xcode is ${xcode_major}.${xcode_minor}." >&2
    return 1
  fi
}
