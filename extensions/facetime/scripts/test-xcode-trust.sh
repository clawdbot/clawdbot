#!/bin/sh
set -eu

root=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/openclaw-xcode-trust-test.XXXXXX")
cleanup() {
  /bin/rm -rf "$root"
}
trap cleanup EXIT

verifier="$(dirname "$0")/verify-xcode-trust.sh"
fake_xcode="$root/Xcode.app"
/bin/mkdir -p \
  "$fake_xcode/Contents/MacOS" \
  "$fake_xcode/Contents/Developer/usr/bin" \
  "$fake_xcode/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin"
/bin/cp /usr/bin/true "$fake_xcode/Contents/MacOS/Xcode"
/bin/cp /usr/bin/true "$fake_xcode/Contents/Developer/usr/bin/xcodebuild"
for tool in clang clang++ ld libtool; do
  /bin/cp /usr/bin/true \
    "$fake_xcode/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/$tool"
done
/usr/bin/plutil -create xml1 "$fake_xcode/Contents/Info.plist"
/usr/bin/plutil -insert CFBundleIdentifier -string com.apple.dt.Xcode \
  "$fake_xcode/Contents/Info.plist"
/usr/bin/plutil -insert CFBundleExecutable -string Xcode "$fake_xcode/Contents/Info.plist"
/usr/bin/plutil -insert CFBundlePackageType -string APPL "$fake_xcode/Contents/Info.plist"
/bin/chmod -R go-w "$fake_xcode"
/usr/bin/codesign --force --deep --sign - "$fake_xcode" >/dev/null 2>&1

assert_rejected() {
  name=$1
  expected=$2
  output="$root/$name.log"
  if /bin/sh "$verifier" "$fake_xcode" >"$output" 2>&1; then
    echo "unsafe $name Xcode unexpectedly passed trust verification" >&2
    exit 1
  fi
  if ! /usr/bin/grep -E "$expected" "$output" >/dev/null; then
    echo "unsafe $name Xcode failed for the wrong reason" >&2
    /bin/cat "$output" >&2
    exit 1
  fi
}

# These invoke the production verifier against an executable fake toolchain;
# no source-text assertion or test-only installer flag stands in for the check.
assert_rejected user-owned 'must be root-owned'
/bin/chmod g+w "$fake_xcode/Contents/Developer/usr/bin/xcodebuild"
assert_rejected writable 'Xcode contains group/world-writable content'
/bin/chmod g-w "$fake_xcode/Contents/Developer/usr/bin/xcodebuild"
assert_rejected non-apple 'required Apple signing identity'
