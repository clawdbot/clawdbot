#!/bin/sh
set -eu

if test "$#" -ne 1 || test -z "$1"; then
  echo "Usage: $0 <Xcode.app>" >&2
  exit 2
fi

xcode_app=$1
apple_team_id="59GAB85EFG"
failed=false

reject() {
  echo "$1" >&2
  failed=true
}

canonical_path() {
  /usr/bin/python3 -I -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

check_path_component_trust() {
  component=$1
  while :; do
    if test "$(/usr/bin/stat -f '%u' "$component" 2>/dev/null || echo missing)" != "0"; then
      reject "Xcode path component is not root-owned: $component"
    fi
    if /usr/bin/find "$component" -prune \( -perm -020 -o -perm -002 \) -print -quit | /usr/bin/grep -q .; then
      reject "Xcode path component is group/world writable: $component"
    fi
    if /usr/bin/find "$component" -prune -acl -print | /usr/bin/grep -q .; then
      reject "Xcode path component has an access-control list that cannot be trusted for root compilation: $component"
    fi
    test "$component" = "/" && break
    component=$(/usr/bin/dirname "$component")
  done
}

check_apple_signature() {
  target=$1
  expected_identifier=$2
  label=$3
  details=$(/usr/bin/mktemp /private/tmp/openclaw-xcode-signature.XXXXXX)
  if ! /usr/bin/codesign --verify --strict "$target" >/dev/null 2>&1 ||
     ! /usr/bin/codesign -dv --verbose=4 "$target" >"$details" 2>&1; then
    reject "$label is not signed by Apple: $target"
    /bin/rm -f "$details"
    return
  fi
  if ! /usr/bin/grep -qx "Identifier=$expected_identifier" "$details" ||
     ! /usr/bin/grep -qx "TeamIdentifier=$apple_team_id" "$details" ||
     ! /usr/bin/grep -Eq '^Authority=(Software Signing|Apple Mac OS Application Signing)$' "$details" ||
     ! /usr/bin/grep -qx 'Authority=Apple Code Signing Certification Authority' "$details" ||
     ! /usr/bin/grep -qx 'Authority=Apple Root CA' "$details"; then
    reject "$label does not have the required Apple signing identity: $target"
  fi
  /bin/rm -f "$details"
}

if ! test -d "$xcode_app" || test -L "$xcode_app"; then
  echo "Trusted Xcode is required as a real application at $xcode_app." >&2
  exit 1
fi

canonical_xcode=$(canonical_path "$xcode_app")
if test "$canonical_xcode" != "$xcode_app"; then
  reject "Xcode must use its canonical path, not a symlink or redirected path: $xcode_app"
fi

check_path_component_trust "$canonical_xcode"
if /usr/bin/find "$canonical_xcode" ! -user root -print -quit | /usr/bin/grep -q .; then
  reject "Xcode and every bundled tool must be root-owned. Reinstall Xcode from Apple into /Applications using an administrator-managed install."
fi
if /usr/bin/find "$canonical_xcode" \( -perm -020 -o -perm -002 \) -print -quit | /usr/bin/grep -q .; then
  reject "Xcode contains group/world-writable content. Reinstall Xcode from Apple; OpenClaw will not repair unsafe ownership or modes."
fi
if /usr/bin/find "$canonical_xcode" -acl -print -quit | /usr/bin/grep -q .; then
  reject "Xcode contains access-control lists that cannot be trusted for root compilation. Reinstall Xcode from Apple."
fi
if ! /usr/bin/codesign --verify --deep --strict "$canonical_xcode" >/dev/null 2>&1; then
  reject "The Xcode application seal is invalid. Reinstall Xcode from Apple before installing the FaceTime driver."
fi
check_apple_signature "$canonical_xcode" "com.apple.dt.Xcode" "Xcode"

for tool_spec in \
  "Contents/Developer/usr/bin/xcodebuild|com.apple.dt.xcodebuild|xcodebuild" \
  "Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang|com.apple.clang|clang" \
  "Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang++|com.apple.clang|clang++" \
  "Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/ld|com.apple.ld|ld" \
  "Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/libtool|com.apple.libtool|libtool"
do
  relative_path=${tool_spec%%|*}
  remainder=${tool_spec#*|}
  expected_identifier=${remainder%%|*}
  label=${remainder#*|}
  tool="$canonical_xcode/$relative_path"
  if ! test -x "$tool"; then
    reject "Required Apple Xcode tool is missing or not executable: $tool"
    continue
  fi
  canonical_tool=$(canonical_path "$tool")
  case "$canonical_tool" in
    "$canonical_xcode"/*) ;;
    *)
      reject "$label resolves outside the verified Xcode application: $tool"
      continue
      ;;
  esac
  check_path_component_trust "$canonical_tool"
  check_apple_signature "$canonical_tool" "$expected_identifier" "$label"
done

if test "$failed" = true; then
  exit 1
fi

printf 'Verified trusted Apple Xcode at %s\n' "$canonical_xcode"
