#!/usr/bin/env bash
set -euo pipefail

repo="openclaw/openclaw"
months="12"
include_global="0"

usage() {
  printf 'Usage: %s [--repo owner/repo] [--months N] [--global] <github-login> [login...]\n' "$0"
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

date_utc_relative_months() {
  local count="$1"
  if date -u -v-"${count}"m +%Y-%m-%dT00:00:00Z >/dev/null 2>&1; then
    date -u -v-"${count}"m +%Y-%m-%dT00:00:00Z
    return
  fi
  date -u -d "${count} months ago" +%Y-%m-%dT00:00:00Z
}

date_to_epoch() {
  local value="$1"
  if date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$value" +%s >/dev/null 2>&1; then
    date -u -j -f '%Y-%m-%dT%H:%M:%SZ' "$value" +%s
    return
  fi
  date -u -d "$value" +%s
}

rough_age() {
  local created_at="$1"
  local now_s created_s days
  now_s=$(date -u +%s)
  created_s=$(date_to_epoch "$created_at")
  days=$(( (now_s - created_s) / 86400 ))
  if (( days < 120 )); then
    printf '~%dd old' "$days"
    return
  fi
  awk -v days="$days" 'BEGIN { printf "~%.1fy old", days / 365.2425 }'
}

thread_kinds() {
  local login="$1"
  local since_ts="$2"
  gh api --paginate "repos/${repo}/issues?state=all&creator=${login}&since=${since_ts}&per_page=100" \
    --jq ".[] | select(.created_at >= \"${since_ts}\") | if has(\"pull_request\") then \"pr\" else \"issue\" end"
}

count_kind_lines() {
  local kind="$1"
  local lines="$2"
  grep -cx "$kind" <<<"$lines" 2>/dev/null || true
}

count_commits() {
  local login="$1"
  local since_ts="$2"
  gh api --paginate "repos/${repo}/commits?author=${login}&since=${since_ts}&per_page=100" \
    --jq '.[].sha' | wc -l | tr -d '[:space:]'
}

global_activity() {
  local login="$1"
  local since_ts="$2"
  local now_ts="$3"
  # shellcheck disable=SC2016
  gh api graphql \
    -f login="$login" \
    -f from="$since_ts" \
    -f to="$now_ts" \
    -f query='
query($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      totalIssueContributions
      totalPullRequestContributions
      totalPullRequestReviewContributions
    }
  }
}' \
    --jq '.data.user.contributionsCollection // empty'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || die "--repo requires owner/repo"
      repo="$2"
      shift 2
      ;;
    --months)
      [[ $# -ge 2 ]] || die "--months requires a positive integer"
      months="$2"
      [[ "$months" =~ ^[0-9]+$ && "$months" != "0" ]] || die "--months must be a positive integer"
      shift 2
      ;;
    --global)
      include_global="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      break
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      break
      ;;
  esac
done

[[ $# -gt 0 ]] || {
  usage >&2
  exit 2
}

need gh
need jq

since_ts=$(date_utc_relative_months "$months")
now_ts=$(date -u +%Y-%m-%dT%H:00:00Z)

for login in "$@"; do
  profile=$(gh api "users/${login}" --jq '{login,name,created_at,type}')
  display_login=$(jq -r '.login' <<<"$profile")
  name=$(jq -r '.name // empty' <<<"$profile")
  created_at=$(jq -r '.created_at' <<<"$profile")
  type=$(jq -r '.type' <<<"$profile")
  created_day=${created_at%%T*}

  kinds=$(thread_kinds "$display_login" "$since_ts")
  prs=$(count_kind_lines pr "$kinds")
  issues=$(count_kind_lines issue "$kinds")
  commits=$(count_commits "$display_login" "$since_ts")

  if [[ -n "$name" ]]; then
    printf '%s (@%s, %s, account created %s, %s)\n' \
      "$name" "$display_login" "$type" "$created_day" "$(rough_age "$created_at")"
  else
    printf '@%s (%s, account created %s, %s)\n' \
      "$display_login" "$type" "$created_day" "$(rough_age "$created_at")"
  fi
  printf '%s last %smo: %s PRs, %s issues, %s commits\n' "$repo" "$months" "$prs" "$issues" "$commits"

  if [[ "$include_global" == "1" ]]; then
    if global_json=$(global_activity "$display_login" "$since_ts" "$now_ts" 2>/dev/null); then
      if [[ -n "$global_json" ]]; then
        global_commits=$(jq -r '.totalCommitContributions' <<<"$global_json")
        global_issues=$(jq -r '.totalIssueContributions' <<<"$global_json")
        global_prs=$(jq -r '.totalPullRequestContributions' <<<"$global_json")
        global_reviews=$(jq -r '.totalPullRequestReviewContributions' <<<"$global_json")
        printf 'GitHub public last %smo: %s commits, %s PRs, %s issues, %s reviews\n' \
          "$months" "$global_commits" "$global_prs" "$global_issues" "$global_reviews"
      else
        printf 'GitHub public last %smo: unavailable\n' "$months"
      fi
    else
      printf 'GitHub public last %smo: unavailable\n' "$months"
    fi
  fi
done
