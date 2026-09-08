#!/usr/bin/env bash

plain_gh_env() {
  env \
    -u CLICOLOR \
    -u CLICOLOR_FORCE \
    -u COLORTERM \
    -u GH_FORCE_TTY \
    NO_COLOR=1 \
    FORCE_COLOR=0 \
    CLICOLOR=0 \
    CLICOLOR_FORCE=0 \
    "$@"
}

resolve_plain_gh_bin() {
  if [ -n "${OPENCLAW_GH_BIN:-}" ]; then
    if [ -x "$OPENCLAW_GH_BIN" ]; then
      printf '%s\n' "$OPENCLAW_GH_BIN"
      return 0
    fi
    printf 'OPENCLAW_GH_BIN is not executable: %s\n' "$OPENCLAW_GH_BIN" >&2
    return 1
  fi

  # PATH owns routing and guarded delegation; plain only normalizes output.
  type -P gh 2>/dev/null
}

plain_gh_auth_token() {
  if [ -z "${OPENCLAW_GH_BIN:-}" ] ||
    [ -n "${GH_TOKEN:-}" ] ||
    [ -n "${GITHUB_TOKEN:-}" ] ||
    [ -n "${GH_ENTERPRISE_TOKEN:-}" ] ||
    [ -n "${GITHUB_ENTERPRISE_TOKEN:-}" ]; then
    return 1
  fi

  local path_gh
  path_gh=$(type -P gh 2>/dev/null) || return 1
  local args=(auth token)
  if [ -n "${GH_HOST:-}" ]; then
    args+=(--hostname "$GH_HOST")
  fi
  OPENCLAW_GH_BIN= plain_gh_env "$path_gh" "${args[@]}"
}

gh_plain() {
  local gh_bin
  gh_bin=$(resolve_plain_gh_bin) || return 1
  local token
  if token=$(plain_gh_auth_token 2>/dev/null) && [ -n "$token" ]; then
    local token_name=GH_TOKEN
    if [ -n "${GH_HOST:-}" ] && [ "$GH_HOST" != "github.com" ]; then
      token_name=GH_ENTERPRISE_TOKEN
    fi
    plain_gh_env "$token_name=$token" "$gh_bin" "$@"
    return
  fi
  plain_gh_env "$gh_bin" "$@"
}
