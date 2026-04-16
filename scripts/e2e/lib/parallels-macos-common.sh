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

parallels_macos_current_user_available() {
  local vm_name="$1"
  prlctl exec "$vm_name" --current-user /usr/bin/whoami >/dev/null 2>&1
}

parallels_macos_desktop_user_exec_with_secret_file() {
  local vm_name="$1"
  local user_flag="$2"
  local user_name="$3"
  local home="$4"
  local path_value="$5"
  local api_key_env="$6"
  local api_key_value="$7"
  shift 7

  local secret_path
  secret_path="/tmp/openclaw-secret-${api_key_env:-env}-$RANDOM-$RANDOM"

  if [[ -n "$api_key_env" && -n "$api_key_value" ]]; then
    if [[ "$user_flag" == "current-user" ]]; then
      printf '%s' "$api_key_value" | /usr/bin/base64 | prlctl exec "$vm_name" \
        --current-user /usr/bin/base64 -D -o "$secret_path"
    else
      printf '%s' "$api_key_value" | /usr/bin/base64 | prlctl exec "$vm_name" \
        /usr/bin/sudo -H -u "$user_name" /usr/bin/base64 -D -o "$secret_path"
    fi
  fi

  local wrapper
  wrapper='
set -e
if [ -n "${OPENCLAW_SECRET_ENV_NAME:-}" ] && [ -n "${OPENCLAW_SECRET_FILE:-}" ] && [ -f "$OPENCLAW_SECRET_FILE" ]; then
  secret_value="$(cat "$OPENCLAW_SECRET_FILE")"
  rm -f "$OPENCLAW_SECRET_FILE"
  export "${OPENCLAW_SECRET_ENV_NAME}=${secret_value}"
fi
exec "$@"
'

  if [[ "$user_flag" == "current-user" ]]; then
    prlctl exec "$vm_name" --current-user /usr/bin/env \
      "PATH=$path_value" \
      "OPENCLAW_SECRET_ENV_NAME=$api_key_env" \
      "OPENCLAW_SECRET_FILE=$secret_path" \
      /bin/bash -c "$wrapper" openclaw-secret-env "$@"
    return
  fi

  prlctl exec "$vm_name" /usr/bin/sudo -u "$user_name" /usr/bin/env \
    "HOME=$home" \
    "USER=$user_name" \
    "LOGNAME=$user_name" \
    "PATH=$path_value" \
    "OPENCLAW_SECRET_ENV_NAME=$api_key_env" \
    "OPENCLAW_SECRET_FILE=$secret_path" \
    /bin/bash -c "$wrapper" openclaw-secret-env "$@"
}

parallels_macos_desktop_user_exec() {
  local vm_name="$1"
  local api_key_env="$2"
  local api_key_value="$3"
  shift 3

  if parallels_macos_current_user_available "$vm_name"; then
    parallels_macos_desktop_user_exec_with_secret_file \
      "$vm_name" \
      "current-user" \
      "" \
      "" \
      "/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin" \
      "$api_key_env" \
      "$api_key_value" \
      "$@"
    return
  fi

  local user home
  user="$(parallels_macos_resolve_desktop_user "$vm_name")"
  [[ -n "$user" ]] || {
    printf 'unable to resolve macOS desktop user for sudo fallback\n' >&2
    return 1
  }
  home="$(parallels_macos_resolve_desktop_home "$vm_name" "$user")"
  printf 'warn: macOS --current-user unavailable; using root sudo fallback for %s\n' "$user" >&2
  parallels_macos_desktop_user_exec_with_secret_file \
    "$vm_name" \
    "sudo" \
    "$user" \
    "$home" \
    "/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin" \
    "$api_key_env" \
    "$api_key_value" \
    "$@"
}
