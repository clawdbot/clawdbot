#!/bin/sh
set -eu

if test "$#" -ne 2 || test -z "$1" || test "$1" = / || test -z "$2" || test "$2" = /; then
  echo "Usage: $0 <user-home> <temporary-root>" >&2
  exit 2
fi

user_home=$1
temporary_root=$2
/bin/rm -rf "$user_home/Library/Caches/OpenClaw/FaceTime/driver/OpenClawBridge.driver"
/bin/rm -f \
  "$user_home/Library/Application Support/OpenClaw/FaceTime/helper-ipc-key" \
  "$user_home/Library/Application Support/OpenClaw/FaceTime/helper-build.sha256"
for container in com.apple.FaceTime com.apple.mobilephone; do
  staged="$user_home/Library/Containers/$container/Data/tmp"
  if test -d "$staged"; then
    /usr/bin/find "$staged" -maxdepth 1 -type f -name 'FaceTimeHelper*.dylib' -delete
  fi
done
/bin/rm -rf "$temporary_root/openclaw-facetime-macabi"
