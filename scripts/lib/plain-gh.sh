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

gh_plain() {
  local gh_bin
  gh_bin=$(resolve_plain_gh_bin) || return 1
  plain_gh_env "$gh_bin" "$@"
}
