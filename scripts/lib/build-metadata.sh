#!/usr/bin/env bash

openclaw_trim_build_metadata_value() {
  local value="${1:-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "${value}"
}

openclaw_is_full_git_commit() {
  [[ "${1:-}" =~ ^[0-9a-fA-F]{40}$ ]]
}

openclaw_normalize_utc_build_timestamp() {
  local value="${1:-}"
  local LC_ALL=C
  [[ "${value}" =~ ^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})([.][0-9]{1,3})?Z$ ]] || return 1

  local year="${BASH_REMATCH[1]}"
  local month="${BASH_REMATCH[2]}"
  local day="${BASH_REMATCH[3]}"
  local hour="${BASH_REMATCH[4]}"
  local minute="${BASH_REMATCH[5]}"
  local second="${BASH_REMATCH[6]}"
  local fraction="${BASH_REMATCH[7]:-}"
  local year_number=$((10#${year}))
  local month_number=$((10#${month}))
  local day_number=$((10#${day}))
  local hour_number=$((10#${hour}))
  local minute_number=$((10#${minute}))
  local second_number=$((10#${second}))
  local max_day

  ((month_number >= 1 && month_number <= 12)) || return 1
  ((hour_number <= 23 && minute_number <= 59 && second_number <= 59)) || return 1
  case "${month_number}" in
    1 | 3 | 5 | 7 | 8 | 10 | 12) max_day=31 ;;
    4 | 6 | 9 | 11) max_day=30 ;;
    2)
      max_day=28
      if ((year_number % 400 == 0 || (year_number % 4 == 0 && year_number % 100 != 0))); then
        max_day=29
      fi
      ;;
  esac
  ((day_number >= 1 && day_number <= max_day)) || return 1

  fraction="${fraction#.}"
  case "${#fraction}" in
    0) fraction="000" ;;
    1) fraction="${fraction}00" ;;
    2) fraction="${fraction}0" ;;
  esac
  printf '%s-%s-%sT%s:%s:%s.%sZ' \
    "${year}" "${month}" "${day}" "${hour}" "${minute}" "${second}" "${fraction}"
}

openclaw_is_utc_build_timestamp() {
  openclaw_normalize_utc_build_timestamp "${1:-}" >/dev/null
}

openclaw_resolve_git_commit() {
  local root_dir="$1"
  local candidate
  local source_name
  for source_name in GIT_COMMIT GIT_SHA; do
    candidate="$(openclaw_trim_build_metadata_value "${!source_name:-}")"
    [[ -n "${candidate}" ]] && break
  done
  if [[ -n "${candidate}" ]]; then
    if ! openclaw_is_full_git_commit "${candidate}"; then
      echo "ERROR: ${source_name} must be a full 40-character hexadecimal commit." >&2
      return 1
    fi
    printf '%s' "${candidate}" | tr '[:upper:]' '[:lower:]'
    return 0
  fi

  candidate="$( (cd "${root_dir}" && git rev-parse HEAD) 2>/dev/null || true)"
  if [[ -n "${candidate}" ]] && ! openclaw_is_full_git_commit "${candidate}"; then
    echo "ERROR: git rev-parse HEAD must return a full 40-character hexadecimal commit." >&2
    return 1
  fi
  # GITHUB_SHA names the workflow invocation and can differ from a checked-out tag.
  if [[ -z "${candidate}" ]]; then
    candidate="$(openclaw_trim_build_metadata_value "${GITHUB_SHA:-}")"
    if [[ -n "${candidate}" ]] && ! openclaw_is_full_git_commit "${candidate}"; then
      echo "ERROR: GITHUB_SHA must be a full 40-character hexadecimal commit." >&2
      return 1
    fi
  fi
  if [[ -z "${candidate}" ]]; then
    if [[ "${OPENCLAW_REQUIRE_BUILD_METADATA:-0}" == "1" ]]; then
      echo "ERROR: Unable to resolve a full Git commit for the release build." >&2
      return 1
    fi
    printf 'unknown'
    return 0
  fi
  printf '%s' "${candidate}" | tr '[:upper:]' '[:lower:]'
}

openclaw_resolve_build_timestamp() {
  local candidate
  candidate="$(openclaw_trim_build_metadata_value "${OPENCLAW_BUILD_TIMESTAMP:-}")"
  if [[ -n "${candidate}" ]]; then
    if ! candidate="$(openclaw_normalize_utc_build_timestamp "${candidate}")"; then
      echo "ERROR: OPENCLAW_BUILD_TIMESTAMP must be an ISO-8601 UTC timestamp." >&2
      return 1
    fi
  else
    candidate="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    if ! candidate="$(openclaw_normalize_utc_build_timestamp "${candidate}")"; then
      echo "ERROR: Unable to resolve an ISO-8601 UTC timestamp for the build." >&2
      return 1
    fi
  fi
  printf '%s' "${candidate}"
}
