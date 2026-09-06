#!/bin/sh
set -eu

if test "$#" -ne 3; then
  echo "Usage: $0 <staged-driver> <installed-driver> <codesign-path>" >&2
  exit 2
fi

stage=$1
target=$2
codesign_path=$3
parent=$(/usr/bin/dirname "$target")
rollback="$parent/.OpenClawBridge.driver.rollback.$$"
committed=false

restore_on_failure() {
  if test "$committed" != true; then
    if test -e "$target"; then
      /bin/rm -rf "$target"
    fi
    if test -e "$rollback"; then
      /bin/mv "$rollback" "$target"
    fi
  fi
}
trap restore_on_failure EXIT

test -d "$stage"
if test -e "$target"; then
  /bin/mv "$target" "$rollback"
fi
/bin/mv "$stage" "$target"
"$codesign_path" --verify --strict "$target"
committed=true
if test -e "$rollback"; then
  /bin/rm -rf "$rollback"
fi
