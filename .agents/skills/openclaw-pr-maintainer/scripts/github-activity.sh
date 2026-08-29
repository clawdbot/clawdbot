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

search_count() {
  local endpoint="$1" query="$2" response count
  query=$(jq -rn --arg q "$query" '$q | @uri')
  # Native gh caching also covers author/date searches the fleet shim delegates.
  if ! response=$(gh api "search/${endpoint}?q=${query}&per_page=1" --cache 1h 2>/dev/null); then
    printf 'unavailable (request failed)'
    return 1
  fi
  if ! count=$(jq -er '
    if type == "object" and
       (.total_count | type == "number" and . >= 0 and . == floor) and
       (.incomplete_results | type == "boolean") then
      if .incomplete_results then "incomplete (reported \(.total_count))"
      else .total_count | tostring end
    else error("invalid search aggregate") end' <<<"$response" 2>/dev/null); then
    printf 'unavailable (invalid response)'
    return 1
  fi
  printf '%s' "$count"
  [[ "$count" != incomplete* ]]
}

global_activity() {
  local login="$1" response
  # GraphQL may use the real CLI via the shim, but remains one aggregate request.
  # shellcheck disable=SC2016
  if ! response=$(gh api graphql --cache 1h -f login="$login" -f from="$global_from" -f to="$global_to" \
    -f query='query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) { contributionsCollection(from: $from, to: $to) {
        totalCommitContributions totalIssueContributions
        totalPullRequestContributions totalPullRequestReviewContributions
      } }
    }' 2>/dev/null); then
    printf 'unavailable (request failed)\n'
    return 1
  fi
  jq -er '
    if (.errors // [] | length) > 0 then error("GraphQL errors") else
      .data.user.contributionsCollection |
      [.totalCommitContributions, .totalPullRequestContributions,
       .totalIssueContributions, .totalPullRequestReviewContributions] |
      if all(.[]; type == "number" and . >= 0 and . == floor) then
        "\(.[0]) commits, \(.[1]) PRs, \(.[2]) issues, \(.[3]) reviews"
      else error("invalid contribution aggregate") end
    end' <<<"$response" 2>/dev/null || {
      printf 'unavailable (invalid response)\n'
      return 1
    }
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
      [[ "$months" =~ ^[1-9][0-9]*$ ]] || die "--months must be a positive integer"
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
    -*) die "unknown option: $1" ;;
    *) break ;;
  esac
done

[[ $# -gt 0 ]] || { usage >&2; exit 2; }
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "--repo requires owner/repo"
for command in gh jq; do
  command -v "$command" >/dev/null 2>&1 || die "missing required command: $command"
done

# Use completed UTC days and clamp calendar subtraction at month ends on both OSes.
# The contribution API accepts at most one year; never relabel that as the repo range.
clock=$(date -u +%s)
windows=$(jq -nr --argjson clock "$clock" --argjson months "$months" '
  def iso: strftime("%Y-%m-%dT%H:%M:%SZ");
  ($clock | gmtime | .[3:6] = [0,0,0]) as $end |
  def ago($n):
    ($end[0] * 12 + $end[1] - $n) as $month |
    [($month / 12 | floor), ($month % 12), 1, 0, 0, 0, 0, 0] as $first |
    if $first[0] < 1 then error("unsupported date range") else
      ($first | .[1] += 1 | mktime - 86400 | gmtime | .[2]) as $last |
      $first | .[2] = ([$end[2], $last] | min) | mktime | iso
    end;
  [$months, 12] | min as $global |
  [ago($months), ($end | mktime - 1 | iso), ago($global),
   ($end | mktime | iso), $global] | @tsv') || die "unsupported --months range"
IFS=$'\t' read -r repo_from repo_to global_from global_to global_months <<<"$windows"
failed=0
for login in "$@"; do
  [[ "$login" =~ ^[A-Za-z0-9_-]+(\[bot\])?$ ]] || {
    printf '@%s (invalid login; account age unknown)\n' "$login"
    failed=1
    continue
  }
  if ! profile=$(gh api "users/${login}" --cache 1h --jq '{login,name,created_at,type}' 2>/dev/null) ||
     ! display_login=$(jq -er '.login | select(type == "string" and test("^[A-Za-z0-9_-]+(\\[bot\\])?$"))' <<<"$profile" 2>/dev/null); then
    printf '@%s (profile unavailable; account age unknown)\n' "$login"
    printf 'Activity unavailable (identity not resolved)\n'
    failed=1
    continue
  fi
  # Identity is useful even if the very next activity request stalls or fails.
  jq -r --argjson clock "$clock" '
    (if (.name | type) == "string" and .name != "" then "\(.name) (@\(.login), " else "@\(.login) (" end) as $who |
    (try (.created_at | fromdateiso8601) catch null) as $created |
    (if $created == null then "account age unknown" else
      "account created \(.created_at | split("T")[0]), ~\((($clock - $created) / 86400) | floor)d old" end) as $age |
    "\($who)\(.type | select(type == "string" and length > 0) // "type unknown"), \($age))"' <<<"$profile"
  query="repo:${repo} author:${display_login}"
  prs=$(search_count issues "$query is:pr created:${repo_from}..${repo_to}") || failed=1
  issues=$(search_count issues "$query is:issue created:${repo_from}..${repo_to}") || failed=1
  commits=$(search_count commits "$query committer-date:${repo_from}..${repo_to}") || failed=1
  printf '%s last %smo [%s..%s]: %s PRs, %s issues, %s commits\n' \
    "$repo" "$months" "$repo_from" "$repo_to" "$prs" "$issues" "$commits"
  printf 'Repo counts: search index totals, default-branch commits; 1h cache; index/cache may lag. Query bounds are not live as-of timestamps.\n'
  if [[ "$include_global" == "1" ]]; then
    printf 'GitHub contributions last %smo [%s..%s]' "$global_months" "$global_from" "$global_to"
    [[ "$global_months" == "$months" ]] || printf ' (capped at one year; requested %smo)' "$months"
    printf ': '
    global_activity "$display_login" || failed=1
    printf 'Contribution graph only; token-visible activity may include private repositories. Zero does not prove inactivity.\n'
  fi
done
exit "$failed"
