#!/bin/sh
set -eu
umask 077

version="0.7.1"
archive_sha256="e9de179da54ed55ff27876990f3a2dcfefa66e6bd6cfcba448a8564eabdf3e89"
factory_uuid="A11C0A17-6F8E-4D72-9AF4-0A1D10B21D6E"
blackhole_factory_uuid="e395c745-4eea-4d94-bb92-46224221047c"
plugin_type_uuid="443ABAB8-E7B3-491A-B985-BEB9187030DB"
recipe="facetime-paired-v2"
bundle_id="ai.openclaw.BlackHoleBridge"
installed_driver="/Library/Audio/Plug-Ins/HAL/OpenClawBridge.driver"
driver_parent="/Library/Audio/Plug-Ins/HAL"
xcode_app="/Applications/Xcode.app"
xcode_developer="$xcode_app/Contents/Developer"
xcodebuild="$xcode_developer/usr/bin/xcodebuild"
toolchain="$xcode_developer/Toolchains/XcodeDefault.xctoolchain/usr/bin"
clang="$toolchain/clang"
clangxx="$toolchain/clang++"
linker="$toolchain/ld"
libtool="$toolchain/libtool"
script_dir=$(CDPATH='' cd -- "$(/usr/bin/dirname -- "$0")" && pwd)
trust_verifier="$script_dir/verify-xcode-trust.sh"
transaction="$script_dir/commit-driver-transaction.sh"
stage=""
work_dir=""

remove_tree() {
  target=$1
  if test -x /usr/bin/trash; then
    /usr/bin/trash "$target"
  else
    /usr/bin/python3 -I -c 'import os, shutil, sys; p=sys.argv[1]; shutil.rmtree(p) if os.path.isdir(p) and not os.path.islink(p) else (os.unlink(p) if os.path.lexists(p) else None)' "$target"
  fi
}

cleanup() {
  if test -n "$stage" && test -e "$stage"; then
    remove_tree "$stage" >/dev/null 2>&1 || true
  fi
  if test -n "$work_dir" && test -e "$work_dir"; then
    remove_tree "$work_dir" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

restart_core_audio() {
  for pid in $(/usr/bin/pgrep -x coreaudiod || true); do
    /bin/kill -9 "$pid"
  done
}

verify_driver() {
  driver=$1
  test -d "$driver"
  test ! -L "$driver"
  if /usr/bin/find "$driver" ! -type d ! -type f -print -quit | /usr/bin/grep -q .; then
    echo "OpenClaw paired audio driver contains a non-file entry." >&2
    exit 1
  fi
  if /usr/bin/find "$driver" ! -user root -print -quit | /usr/bin/grep -q .; then
    echo "OpenClaw paired audio driver is not owned by root." >&2
    exit 1
  fi
  if /usr/bin/find "$driver" \( -perm -020 -o -perm -002 \) -print -quit | /usr/bin/grep -q .; then
    echo "OpenClaw paired audio driver is group/world writable." >&2
    exit 1
  fi
  plist="$driver/Contents/Info.plist"
  test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")" = "$bundle_id"
  test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")" = "BlackHole"
  test "$(/usr/libexec/PlistBuddy -c 'Print :OpenClawDriverRecipe' "$plist")" = "$recipe"
  test "$(/usr/libexec/PlistBuddy -c 'Print :OpenClawBlackHoleVersion' "$plist")" = "$version"
  /usr/bin/codesign --verify --strict "$driver"
  /usr/bin/codesign -dv --verbose=4 "$driver" 2>&1 | /usr/bin/grep -q '^Signature=adhoc$'
}

build_and_install() {
  canonical_xcode=$(/usr/bin/python3 -I -c 'import os; print(os.path.realpath("/Applications/Xcode.app"))')
  if test "$canonical_xcode" != "$xcode_app"; then
    echo "Trusted Xcode must be installed directly at /Applications/Xcode.app, not through a symlink." >&2
    exit 1
  fi

  work_dir=$(/usr/bin/mktemp -d /private/tmp/openclaw-driver-build.XXXXXX)
  /bin/chmod 700 "$work_dir"
  archive="$work_dir/BlackHole.tar.gz"
  source_dir="$work_dir/BlackHole-$version"
  build_dir="$work_dir/build"
  driver="$build_dir/BlackHole.driver"
  /bin/mkdir -m 700 "$work_dir/home" "$work_dir/tmp"

  /usr/bin/curl -q -fsSL \
    "https://github.com/ExistentialAudio/BlackHole/archive/refs/tags/v$version.tar.gz" \
    -o "$archive"
  printf '%s  %s\n' "$archive_sha256" "$archive" | /usr/bin/shasum -a 256 -c -
  /usr/bin/tar -xzf "$archive" -C "$work_dir"

  plist="$source_dir/BlackHole/BlackHole.plist"
  /usr/libexec/PlistBuddy -c "Delete :CFPlugInFactories:$blackhole_factory_uuid" "$plist"
  /usr/libexec/PlistBuddy -c "Add :CFPlugInFactories:$factory_uuid string BlackHole_Create" "$plist"
  /usr/libexec/PlistBuddy -c "Set :CFPlugInTypes:$plugin_type_uuid:0 $factory_uuid" "$plist"

  # The verified, non-writable Xcode bundle is the trust envelope for every
  # internal build subprocess. Explicit tool settings pin the compiler/linker.
  "$trust_verifier" "$xcode_app"
  # shellcheck disable=SC2016
  /usr/bin/env -i \
    HOME="$work_dir/home" \
    TMPDIR="$work_dir/tmp" \
    PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
    DEVELOPER_DIR="$xcode_developer" \
    "$xcodebuild" \
    -quiet \
    -project "$source_dir/BlackHole.xcodeproj" \
    -scheme BlackHole \
    -configuration Release \
    -derivedDataPath "$work_dir/DerivedData" \
    CODE_SIGNING_ALLOWED=NO \
    CONFIGURATION_BUILD_DIR="$build_dir" \
    PRODUCT_BUNDLE_IDENTIFIER="$bundle_id" \
    CC="$clang" \
    CPLUSPLUS="$clangxx" \
    LD="$linker" \
    LDPLUSPLUS="$linker" \
    LIBTOOL="$libtool" \
    'GCC_PREPROCESSOR_DEFINITIONS=$GCC_PREPROCESSOR_DEFINITIONS kNumber_Of_Channels=2 kPlugIn_BundleID=\"ai.openclaw.BlackHoleBridge\" kDriver_Name=\"OpenClawBridge\" kHas_Driver_Name_Format=false kDevice_Name=\"OpenClaw-Mic\" kDevice2_Name=\"OpenClaw-Feed\" kDevice_IsHidden=false kDevice2_IsHidden=false kDevice_HasInput=true kDevice_HasOutput=false kDevice2_HasInput=false kDevice2_HasOutput=true'

  /usr/bin/codesign --force --deep --sign - "$driver"
  /usr/libexec/PlistBuddy -c "Add :OpenClawDriverRecipe string $recipe" \
    "$driver/Contents/Info.plist"
  /usr/libexec/PlistBuddy -c "Add :OpenClawBlackHoleVersion string $version" \
    "$driver/Contents/Info.plist"
  /usr/bin/codesign --force --deep --sign - "$driver"
  /usr/sbin/chown -R root:wheel "$driver"
  /bin/chmod -R go-w "$driver"
  verify_driver "$driver"

  /bin/mkdir -p "$driver_parent"
  stage="$driver_parent/.OpenClawBridge.driver.stage.$$"
  /usr/bin/ditto "$driver" "$stage"
  /usr/sbin/chown -R root:wheel "$stage"
  /bin/chmod -R go-w "$stage"
  verify_driver "$stage"
  /bin/sh "$transaction" "$stage" "$installed_driver" /usr/bin/codesign
  stage=""
  restart_core_audio
}

case "${1:-}" in
  --install)
    if test "$#" -ne 1; then
      echo "Usage: $0 --install | --uninstall" >&2
      exit 2
    fi
    ;;
  --uninstall)
    if test "$#" -ne 1; then
      echo "Usage: $0 --install | --uninstall" >&2
      exit 2
    fi
    ;;
  *)
    echo "Usage: $0 --install | --uninstall" >&2
    exit 2
    ;;
esac

if test "$(/usr/bin/id -u)" -ne 0; then
  echo "FaceTime driver installation requires administrator privileges." >&2
  exit 1
fi

if test "$1" = "--uninstall"; then
  if test -e "$installed_driver"; then
    /bin/rm -rf "$installed_driver"
    restart_core_audio
  fi
  exit 0
fi

build_and_install
