#!/usr/bin/env bash

normalize_release_suite_filter() {
  local raw="$1"
  local normalized=""
  local token
  while IFS= read -r token; do
    [[ -z "$token" ]] && continue
    normalized+="${normalized:+,}${token}"
  done < <(printf '%s\n' "$raw" | tr '[:upper:]' '[:lower:]' | tr ',[:space:]' '\n')
  printf '%s' "$normalized"
}

validate_release_suite_filters() {
  local rerun_group="$1"
  local raw_live_suite_filter="$2"
  local raw_cross_os_suite_filter="$3"
  local dispatch_scope="$4"
  local live_suite_filter
  local cross_os_suite_filter
  local qa_filter_seen=false
  local repo_filter_seen=false
  local -a repo_filter_tokens=()
  local token

  case "$dispatch_scope" in
    controller)
      case "$rerun_group" in
        all|ci|plugin-prerelease|install-smoke|cross-os|live-e2e|package|qa-parity|qa-live|npm-telegram|performance) ;;
        *)
          echo "controller rerun_group is invalid: ${rerun_group}." >&2
          return 1
          ;;
      esac
      ;;
    release-checks)
      case "$rerun_group" in
        all|install-smoke|cross-os|live-e2e|package|qa|qa-parity|qa-live) ;;
        *)
          echo "release-checks rerun_group is invalid: ${rerun_group}." >&2
          return 1
          ;;
      esac
      ;;
    *)
      echo "release suite filter dispatch scope is invalid: ${dispatch_scope}." >&2
      return 1
      ;;
  esac

  live_suite_filter="$(normalize_release_suite_filter "$raw_live_suite_filter")"
  cross_os_suite_filter="$(normalize_release_suite_filter "$raw_cross_os_suite_filter")"
  if [[ -n "$raw_live_suite_filter" && -z "$live_suite_filter" ]]; then
    echo "live_suite_filter must contain at least one suite selector." >&2
    return 1
  fi
  if [[ -n "$raw_cross_os_suite_filter" && -z "$cross_os_suite_filter" ]]; then
    echo "cross_os_suite_filter must contain at least one suite selector." >&2
    return 1
  fi
  if [[ -n "$cross_os_suite_filter" && "$rerun_group" != "cross-os" ]]; then
    echo "cross_os_suite_filter requires rerun_group=cross-os; received ${rerun_group}." >&2
    return 1
  fi

  if [[ -n "$live_suite_filter" ]]; then
    local -a filter_tokens=()
    IFS=',' read -r -a filter_tokens <<< "$live_suite_filter"
    for token in "${filter_tokens[@]}"; do
      case "$token" in
        qa-live|qa-live-all|qa-all|\
        qa-live-non-slack|qa-non-slack|non-slack|no-slack|without-slack|\
        qa-live-matrix|qa-matrix|matrix|\
        qa-live-buzz|qa-buzz|buzz|\
        qa-live-telegram|qa-telegram|telegram|\
        qa-live-discord|qa-discord|discord|\
        qa-live-whatsapp|qa-whatsapp|whatsapp|\
        qa-live-slack|qa-slack|slack)
          qa_filter_seen=true
          ;;
        *)
          repo_filter_seen=true
          repo_filter_tokens+=("$token")
          ;;
      esac
    done
  fi

  if [[ "$qa_filter_seen" == "true" && "$rerun_group" != "qa" && "$rerun_group" != "qa-live" ]]; then
    echo "QA live_suite_filter selectors require rerun_group=qa or qa-live; received ${rerun_group}." >&2
    return 1
  fi
  if [[ "$repo_filter_seen" == "true" && "$rerun_group" != "live-e2e" ]]; then
    echo "Repo live_suite_filter selectors require rerun_group=live-e2e; received ${rerun_group}." >&2
    return 1
  fi

  # Outputs are consumed by the workflow step that sources this helper.
  # shellcheck disable=SC2034
  RELEASE_FILTER_LIVE_SUITE_FILTER="$live_suite_filter"
  # shellcheck disable=SC2034
  RELEASE_FILTER_CROSS_OS_SUITE_FILTER="$cross_os_suite_filter"
  # shellcheck disable=SC2034
  RELEASE_FILTER_REPO_LIVE_SUITE_FILTER="$(IFS=,; printf '%s' "${repo_filter_tokens[*]-}")"
  # shellcheck disable=SC2034
  RELEASE_FILTER_QA_FILTER_SEEN="$qa_filter_seen"
}
