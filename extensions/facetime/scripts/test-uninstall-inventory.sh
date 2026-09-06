#!/bin/sh
set -eu

root=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/openclaw-facetime-uninstall-test.XXXXXX")
cleanup() { /bin/rm -rf "$root"; }
trap cleanup EXIT
home="$root/home"
tmp="$root/tmp"
/bin/mkdir -p \
  "$home/Library/Caches/OpenClaw/FaceTime/driver/OpenClawBridge.driver" \
  "$home/Library/Application Support/OpenClaw/FaceTime" \
  "$home/Library/Containers/com.apple.FaceTime/Data/tmp" \
  "$home/Library/Containers/com.apple.mobilephone/Data/tmp" \
  "$tmp/openclaw-facetime-macabi"
/usr/bin/touch \
  "$home/Library/Application Support/OpenClaw/FaceTime/helper-ipc-key" \
  "$home/Library/Application Support/OpenClaw/FaceTime/helper-build.sha256" \
  "$home/Library/Containers/com.apple.FaceTime/Data/tmp/FaceTimeHelper.dylib" \
  "$home/Library/Containers/com.apple.mobilephone/Data/tmp/FaceTimeHelper-1.dylib" \
  "$home/Library/Containers/com.apple.FaceTime/Data/tmp/unrelated" \
  "$tmp/openclaw-facetime-macabi/FaceTimeHelper.dylib"

/bin/sh "$(dirname "$0")/remove-user-artifacts.sh" "$home" "$tmp"
test ! -e "$home/Library/Caches/OpenClaw/FaceTime/driver/OpenClawBridge.driver"
test ! -e "$home/Library/Application Support/OpenClaw/FaceTime/helper-ipc-key"
test ! -e "$home/Library/Application Support/OpenClaw/FaceTime/helper-build.sha256"
test ! -e "$home/Library/Containers/com.apple.FaceTime/Data/tmp/FaceTimeHelper.dylib"
test ! -e "$home/Library/Containers/com.apple.mobilephone/Data/tmp/FaceTimeHelper-1.dylib"
test ! -e "$tmp/openclaw-facetime-macabi"
test -e "$home/Library/Containers/com.apple.FaceTime/Data/tmp/unrelated"
