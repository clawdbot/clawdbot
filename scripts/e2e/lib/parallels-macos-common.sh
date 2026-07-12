#!/usr/bin/env bash

parallels_macos_resolve_desktop_user() {
  local vm_name="$1"
  local user
  user="$(prlctl exec "$vm_name" /usr/bin/stat -f '%Su' /dev/console 2>/dev/null | tr -d '\r' | tail -n 1 || true)"
  if [[ "$user" =~ ^[A-Za-z0-9._-]+$ && "$user" != "root" && "$user" != "loginwindow" ]]; then
    printf '%s\n' "$user"
    return 0
  fi
  prlctl exec "$vm_name" /usr/bin/dscl . -list /Users NFSHomeDirectory 2>/dev/null \
    | tr -d '\r' \
    | awk '$2 ~ /^\/Users\// && $1 !~ /^_/ && $1 != "Shared" && $1 != ".localized" { print $1; exit }'
}

parallels_macos_resolve_desktop_home() {
  local vm_name="$1"
  local user="$2"
  local home
  home="$(
    prlctl exec "$vm_name" /usr/bin/dscl . -read "/Users/$user" NFSHomeDirectory 2>/dev/null \
      | tr -d '\r' \
      | awk '/NFSHomeDirectory:/ { print $2; exit }'
  )"
  if [[ -n "$home" ]]; then
    printf '%s\n' "$home"
  else
    printf '/Users/%s\n' "$user"
  fi
}
