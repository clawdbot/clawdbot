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

  local candidate
  while IFS= read -r candidate; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(plain_gh_system_candidates)

  if candidate=$(PATH="$(plain_gh_search_path)" type -P gh 2>/dev/null); then
    printf '%s\n' "$candidate"
    return 0
  fi

  type -P gh 2>/dev/null
}

plain_gh_system_candidates() {
  # bin/gh may intentionally be an Octopool shim; prefer package-manager opt paths.
  printf '%s\n' \
    /opt/homebrew/opt/gh/bin/gh \
    /usr/local/opt/gh/bin/gh \
    /home/linuxbrew/.linuxbrew/opt/gh/bin/gh \
    /opt/homebrew/bin/gh \
    /usr/local/bin/gh
}

plain_gh_search_path() {
  local path_value="${PATH:-}"
  local home_bin="${HOME:-}/bin"
  local item
  local output=""
  local first=true
  local path_parts=()

  IFS=':' read -r -a path_parts <<<"$path_value"
  for item in "${path_parts[@]}"; do
    if [ -n "${HOME:-}" ] && [ "$item" = "$home_bin" ]; then
      continue
    fi
    if [ "$first" = "true" ]; then
      output="$item"
      first=false
    else
      output="${output}:$item"
    fi
  done

  printf '%s\n' "$output"
}

plain_gh_auth_token() {
  if [ -n "${GH_TOKEN:-}" ] ||
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
