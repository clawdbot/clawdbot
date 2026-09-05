#!/usr/bin/env bash
# Opt-in, timed AppKit E2E; requires a logged-in macOS desktop and Developer ID.
# Usage: bash apps/macos/Tests/Fixtures/TalkOverlay/run.sh '<Developer ID identity or SHA>'
set -euo pipefail

identity="${1:?Pass the matching Developer ID Application signing identity or certificate SHA}"
fixture_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$fixture_source/../../../../.." && pwd)"
fixture_dir="$(mktemp -d /tmp/openclaw-talk-overlay.XXXXXX)"
trap 'rm -rf -- "$fixture_dir"' EXIT
bundle="$fixture_dir/TalkOverlayFixture.app"
mkdir -p "$bundle/Contents/MacOS"
cat > "$bundle/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>ai.openclaw.talk-overlay-fixture</string>
<key>CFBundleExecutable</key><string>TalkOverlayFixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>
PLIST

cd -- "$repo_root"
sources=(
  apps/macos/Sources/OpenClaw/TalkOverlay.swift
  apps/macos/Sources/OpenClaw/OverlayPanelFactory.swift
  apps/macos/Tests/Fixtures/TalkOverlay/Fixture.swift
)
shasum -a 256 "${sources[@]}" apps/macos/Tests/Fixtures/TalkOverlay/run.sh
binary="$bundle/Contents/MacOS/TalkOverlayFixture"
xcrun swiftc -swift-version 6 -parse-as-library "${sources[@]}" -o "$binary"
codesign --force --sign "$identity" --timestamp=none "$bundle"
codesign --verify --strict "$bundle"
codesign -dv --verbose=4 "$bundle" 2>&1 | awk '
  /^Authority=Developer ID Application:/ { found = 1 }
  END { if (!found) { print "Expected Developer ID Application signature"; exit 1 } }
'
printf 'fixture_binary_sha256=%s\n' "$(shasum -a 256 "$binary" | cut -d ' ' -f 1)"
"$binary"
