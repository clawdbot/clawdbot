#!/usr/bin/env bash

OPENCLAW_DOCKER_LIVE_AUTH_ALL=(.factory .gemini .minimax)
OPENCLAW_DOCKER_LIVE_AUTH_FILES_ALL=(
  .codex/auth.json
  .codex/config.toml
  .claude.json
  .claude/.credentials.json
  .claude/settings.json
  .claude/settings.local.json
  .gemini/settings.json
)

openclaw_live_trim() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

openclaw_live_truthy() {
  case "${1:-}" in
    1 | true | TRUE | yes | YES | on | ON)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

openclaw_live_is_ci() {
  openclaw_live_truthy "${CI:-}" || openclaw_live_truthy "${GITHUB_ACTIONS:-}"
}

openclaw_live_default_profile_file() {
  if [[ -n "${OPENCLAW_PROFILE_FILE:-}" ]]; then
    printf '%s\n' "$OPENCLAW_PROFILE_FILE"
    return 0
  fi
  local testbox_profile="$HOME/.openclaw-testbox-live.profile"
  if [[ -f "$testbox_profile" ]]; then
    printf '%s\n' "$testbox_profile"
    return 0
  fi
  printf '%s\n' "$HOME/.profile"
}

openclaw_live_validate_relative_home_path() {
  local value
  value="$(openclaw_live_trim "${1:-}")"
  [[ -n "$value" ]] || {
    echo "ERROR: empty auth path." >&2
    return 1
  }
  case "$value" in
    /* | *..* | *\\* | *:*)
      echo "ERROR: invalid auth path '$value'." >&2
      return 1
      ;;
  esac
  printf '%s' "$value"
}

openclaw_live_normalize_auth_dir() {
  local value
  value="$(openclaw_live_trim "${1:-}")"
  [[ -n "$value" ]] || return 1
  if [[ "$value" != .* ]]; then
    value=".$value"
  fi
  value="$(openclaw_live_validate_relative_home_path "$value")" || return 1
  printf '%s' "$value"
}

openclaw_live_should_include_auth_dir_for_provider() {
  local provider
  provider="$(openclaw_live_trim "${1:-}")"
  case "$provider" in
    droid | factory | factory-droid)
      printf '%s\n' ".factory"
      ;;
    gemini | gemini-cli | google-gemini-cli)
      printf '%s\n' ".gemini"
      ;;
    minimax | minimax-portal)
      printf '%s\n' ".minimax"
      ;;
  esac
}

openclaw_live_should_include_auth_file_for_provider() {
  local provider
  provider="$(openclaw_live_trim "${1:-}")"
  case "$provider" in
    codex-cli | openai-codex)
      printf '%s\n' ".codex/auth.json"
      printf '%s\n' ".codex/config.toml"
      ;;
    anthropic | claude-cli)
      printf '%s\n' ".claude.json"
      printf '%s\n' ".claude/.credentials.json"
      printf '%s\n' ".claude/settings.json"
      printf '%s\n' ".claude/settings.local.json"
      ;;
  esac
}

openclaw_live_collect_auth_dirs_from_csv() {
  local raw="${1:-}"
  local token normalized
  [[ -n "$(openclaw_live_trim "$raw")" ]] || return 0
  IFS=',' read -r -a tokens <<<"$raw"
  for token in "${tokens[@]}"; do
    while IFS= read -r normalized; do
      printf '%s\n' "$normalized"
    done < <(openclaw_live_should_include_auth_dir_for_provider "$token")
  done | awk 'NF && !seen[$0]++'
}

openclaw_live_collect_auth_dirs_from_override() {
  local raw token normalized
  raw="$(openclaw_live_trim "${OPENCLAW_DOCKER_AUTH_DIRS:-}")"
  [[ -n "$raw" ]] || return 1
  case "$raw" in
    all)
      printf '%s\n' "${OPENCLAW_DOCKER_LIVE_AUTH_ALL[@]}"
      return 0
      ;;
    none)
      return 0
      ;;
  esac
  IFS=',' read -r -a tokens <<<"$raw"
  for token in "${tokens[@]}"; do
    normalized="$(openclaw_live_normalize_auth_dir "$token")" || continue
    printf '%s\n' "$normalized"
  done | awk '!seen[$0]++'
  return 0
}

openclaw_live_collect_auth_dirs() {
  if openclaw_live_collect_auth_dirs_from_override; then
    return 0
  fi
  printf '%s\n' "${OPENCLAW_DOCKER_LIVE_AUTH_ALL[@]}"
}

openclaw_live_collect_auth_files_from_csv() {
  local raw="${1:-}"
  local token normalized
  [[ -n "$(openclaw_live_trim "$raw")" ]] || return 0
  IFS=',' read -r -a tokens <<<"$raw"
  for token in "${tokens[@]}"; do
    while IFS= read -r normalized; do
      printf '%s\n' "$normalized"
    done < <(openclaw_live_should_include_auth_file_for_provider "$token")
  done | awk 'NF && !seen[$0]++'
}

openclaw_live_collect_auth_files_from_override() {
  local raw
  raw="$(openclaw_live_trim "${OPENCLAW_DOCKER_AUTH_DIRS:-}")"
  [[ -n "$raw" ]] || return 1
  case "$raw" in
    all)
      printf '%s\n' "${OPENCLAW_DOCKER_LIVE_AUTH_FILES_ALL[@]}"
      return 0
      ;;
    none)
      return 0
      ;;
  esac
  return 0
}

openclaw_live_collect_auth_files() {
  if openclaw_live_collect_auth_files_from_override; then
    return 0
  fi
  printf '%s\n' "${OPENCLAW_DOCKER_LIVE_AUTH_FILES_ALL[@]}"
}

openclaw_live_join_csv() {
  local first=1 value
  for value in "$@"; do
    [[ -n "$value" ]] || continue
    if (( first )); then
      printf '%s' "$value"
      first=0
    else
      printf ',%s' "$value"
    fi
  done
}

openclaw_live_append_array() {
  local target_array="${1:?target array required}"
  local source_array="${2:?source array required}"
  local count

  eval "count=\${#$source_array[@]}"
  if ((count == 0)); then
    return 0
  fi
  eval "$target_array+=(\"\${$source_array[@]}\")"
}

openclaw_live_stage_auth_into_home() {
  local dest_home="${1:?destination home directory required}"
  shift

  local mode="dirs"
  local relative_path source_path dest_path

  mkdir -p "$dest_home"
  chmod u+rwx "$dest_home" || true

  while (($# > 0)); do
    case "$1" in
      --files)
        mode="files"
        shift
        continue
        ;;
    esac

    relative_path="$(openclaw_live_validate_relative_home_path "$1")" || return 1
    source_path="$HOME/$relative_path"
    dest_path="$dest_home/$relative_path"

    if [[ "$mode" == "dirs" ]]; then
      if [[ -d "$source_path" ]]; then
        mkdir -p "$dest_path"
        cp -R "$source_path"/. "$dest_path"
        chmod -R u+rwX "$dest_path" || true
      fi
    else
      if [[ -f "$source_path" ]]; then
        mkdir -p "$(dirname "$dest_path")"
        cp "$source_path" "$dest_path"
        chmod u+rw "$dest_path" || true
      fi
    fi

    shift
  done
}
