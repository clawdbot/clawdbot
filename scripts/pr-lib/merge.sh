is_mainline_drift_critical_path_for_merge() {
  local path="$1"
  case "$path" in
    package.json|pnpm-lock.yaml|pnpm-workspace.yaml|.npmrc|.oxlintrc.json|.oxfmtrc.json|tsconfig.json|tsconfig.*.json|vitest.config.ts|vitest.*.config.ts|scripts/*|.github/workflows/*)
      return 0
      ;;
  esac
  return 1
}

print_file_list_with_limit() {
  local label="$1"
  local file_path="$2"
  local limit="${3:-12}"

  if [ ! -s "$file_path" ]; then
    return 0
  fi

  local count
  count=$(wc -l < "$file_path" | tr -d ' ')
  echo "$label ($count):"
  sed -n "1,${limit}p" "$file_path" | sed 's/^/  - /'
  if [ "$count" -gt "$limit" ]; then
    echo "  ... +$((count - limit)) more"
  fi
}

mainline_drift_requires_sync() {
  local mainline_base="$1"
  local prepared_head_sha="$2"

  if ! git cat-file -e "${mainline_base}^{commit}" 2>/dev/null; then
    echo "Mainline drift relevance: mainline base $mainline_base is missing locally; require sync."
    return 0
  fi
  if ! git cat-file -e "${prepared_head_sha}^{commit}" 2>/dev/null; then
    echo "Mainline drift relevance: prepared head $prepared_head_sha is missing locally; require sync."
    return 0
  fi

  local delta_file
  local prepared_files_file
  local overlap_file
  local critical_file
  delta_file=$(mktemp)
  prepared_files_file=$(mktemp)
  overlap_file=$(mktemp)
  critical_file=$(mktemp)

  # Compare only mainline commits since the prepared lineage base. The remote
  # GraphQL commit has a different parent but its verified tree shares this
  # lineage, so its PR files must not look like incoming mainline drift.
  git diff --name-only "${mainline_base}..origin/main" | sed '/^$/d' | sort -u > "$delta_file"
  git diff --name-only "${mainline_base}..${prepared_head_sha}" | sed '/^$/d' | sort -u > "$prepared_files_file"
  comm -12 "$delta_file" "$prepared_files_file" > "$overlap_file" || true

  local path
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if is_mainline_drift_critical_path_for_merge "$path"; then
      printf '%s\n' "$path" >> "$critical_file"
    fi
  done < "$delta_file"

  local delta_count
  local overlap_count
  local critical_count
  delta_count=$(wc -l < "$delta_file" | tr -d ' ')
  overlap_count=$(wc -l < "$overlap_file" | tr -d ' ')
  critical_count=$(wc -l < "$critical_file" | tr -d ' ')

  if [ "$delta_count" -eq 0 ]; then
    echo "Mainline drift relevance: no mainline changes since the prepared base."
    rm -f "$delta_file" "$prepared_files_file" "$overlap_file" "$critical_file"
    return 1
  fi

  if [ "$overlap_count" -gt 0 ] || [ "$critical_count" -gt 0 ]; then
    echo "Mainline drift relevance: sync required before merge."
    print_file_list_with_limit "Mainline files overlapping prepared files" "$overlap_file"
    print_file_list_with_limit "Mainline files touching merge-critical infrastructure" "$critical_file"
    rm -f "$delta_file" "$prepared_files_file" "$overlap_file" "$critical_file"
    return 0
  fi

  echo "Mainline drift relevance: no overlap with prepared files and no critical infra drift."
  print_file_list_with_limit "Mainline-only drift files" "$delta_file"
  rm -f "$delta_file" "$prepared_files_file" "$overlap_file" "$critical_file"
  return 1
}

merge_verify() {
  local pr="$1"
  enter_worktree "$pr" false

  require_artifact .local/prep.env
  # shellcheck disable=SC1091
  source .local/prep.env
  verify_prep_branch_matches_prepared_head "$pr" "${LOCAL_PREP_HEAD_SHA:-$PREP_HEAD_SHA}"

  local json
  json=$(pr_meta_json "$pr")
  local is_draft
  is_draft=$(printf '%s\n' "$json" | jq -r .isDraft)
  if [ "$is_draft" = "true" ]; then
    echo "PR is draft."
    exit 1
  fi
  local pr_head_sha
  pr_head_sha=$(printf '%s\n' "$json" | jq -r .headRefOid)

  if [ "$pr_head_sha" != "$PREP_HEAD_SHA" ]; then
    echo "PR head changed after prepare (expected $PREP_HEAD_SHA, got $pr_head_sha)."
    echo "Re-run prepare to refresh prep artifacts and gates: scripts/pr-prepare run $pr"
    echo "Note: docs/changelog-only follow-ups reuse prior gate results automatically."

    mark_pr_operation_side_effects_started
    git fetch origin "pull/$pr/head" >/dev/null 2>&1 || true
    if git cat-file -e "${PREP_HEAD_SHA}^{commit}" 2>/dev/null && git cat-file -e "${pr_head_sha}^{commit}" 2>/dev/null; then
      echo "HEAD delta (expected...current):"
      git log --oneline --left-right "${PREP_HEAD_SHA}...${pr_head_sha}" | sed 's/^/  /' || true
    else
      echo "HEAD delta unavailable locally (could not resolve one of the SHAs)."
    fi
    exit 1
  fi

  mark_pr_operation_side_effects_started
  gh pr checks "$pr" --required --watch --fail-fast >.local/merge-checks-watch.log 2>&1 || true
  local checks_json
  local checks_err_file
  checks_err_file=$(mktemp)
  checks_json=$(gh pr checks "$pr" --required --json name,bucket,state 2>"$checks_err_file" || true)
  rm -f "$checks_err_file"
  if [ -z "$checks_json" ]; then
    checks_json='[]'
  fi
  local required_count
  required_count=$(printf '%s\n' "$checks_json" | jq 'length')
  if [ "$required_count" -eq 0 ]; then
    echo "No required checks configured for this PR."
  fi
  printf '%s\n' "$checks_json" | jq -r '.[] | "\(.bucket)\t\(.name)\t\(.state)"'

  local failed_required
  failed_required=$(printf '%s\n' "$checks_json" | jq '[.[] | select(.bucket=="fail")] | length')
  local pending_required
  pending_required=$(printf '%s\n' "$checks_json" | jq '[.[] | select(.bucket=="pending")] | length')

  if [ "$failed_required" -gt 0 ]; then
    echo "Required checks are failing."
    exit 1
  fi

  if [ "$pending_required" -gt 0 ]; then
    echo "Required checks are still pending."
    exit 1
  fi

  git fetch origin main
  git fetch origin "pull/$pr/head:pr-$pr" --force
  if ! git merge-base --is-ancestor origin/main "pr-$pr"; then
    echo "PR branch is behind main."
    if mainline_drift_requires_sync \
      "${PREP_MAINLINE_BASE_SHA:-${LOCAL_PREP_HEAD_SHA:-$PREP_HEAD_SHA}}" \
      "$PREP_HEAD_SHA"
    then
      # Relevant drift is advisory by default: required checks are already
      # green at the prepared head and GitHub's mergeable state still blocks
      # true conflicts. The hard fail serialized every landing behind a full
      # CI cycle per merged sibling, which collapses under multi-session
      # traffic. Set OPENCLAW_PR_STRICT_DRIFT=1 to restore the hard gate.
      if [ "${OPENCLAW_PR_STRICT_DRIFT:-}" = "1" ]; then
        echo "Merge verify failed: mainline drift is relevant to this PR; run scripts/pr prepare-sync-head $pr before merge."
        exit 1
      fi
      echo "Merge verify: WARNING — mainline drift is relevant to this PR; proceeding (OPENCLAW_PR_STRICT_DRIFT=1 restores the hard gate)."
    else
      echo "Merge verify: continuing without prep-head sync because behind-main drift is unrelated."
    fi
  fi

  echo "merge-verify passed for PR #$pr"
}

merge_run() {
  local pr="$1"
  enter_worktree "$pr" false

  local required
  for required in .local/review.md .local/review.json .local/prep.md .local/prep.env; do
    require_artifact "$required"
  done

  merge_verify "$pr"
  # shellcheck disable=SC1091
  source .local/prep.env

  local pr_meta_json
  pr_meta_json=$(gh pr view "$pr" --json state,isDraft)
  local is_draft
  is_draft=$(printf '%s\n' "$pr_meta_json" | jq -r .isDraft)
  if [ "$is_draft" = "true" ]; then
    echo "PR is draft; stop."
    exit 1
  fi

  delete_remote_pr_head_branch_after_merge() {
    local head_json
    head_json=$(gh pr view "$pr" --json headRefName,headRepository,headRepositoryOwner,isCrossRepository,maintainerCanModify)

    local head_ref
    head_ref=$(printf '%s\n' "$head_json" | jq -r '.headRefName // ""')
    if [ -z "$head_ref" ]; then
      return 0
    fi

    local repo_owner
    repo_owner=$(printf '%s\n' "$head_json" | jq -r '.headRepositoryOwner.login // ""')
    local repo_name
    repo_name=$(printf '%s\n' "$head_json" | jq -r '.headRepository.name // ""')
    if [ -z "$repo_owner" ] || [ -z "$repo_name" ]; then
      echo "Warning: unable to resolve head repository for remote branch cleanup"
      return 0
    fi

    local encoded_ref
    encoded_ref=$(jq -rn --arg value "heads/$head_ref" '$value|@uri')
    if gh api -X DELETE "repos/$repo_owner/$repo_name/git/refs/$encoded_ref" >/dev/null 2>&1; then
      return 0
    fi

    echo "Warning: failed to delete remote branch $repo_owner/$repo_name:$head_ref"
    return 0
  }

  local merge_method="${OPENCLAW_PR_MERGE_METHOD:-squash}"
  local merge_flag
  local merge_label
  case "$merge_method" in
    squash)
      merge_flag="--squash"
      merge_label="squash"
      ;;
    merge)
      merge_flag="--merge"
      merge_label="merge commit"
      ;;
    rebase)
      merge_flag="--rebase"
      merge_label="rebase"
      ;;
    *)
      echo "Invalid OPENCLAW_PR_MERGE_METHOD: $merge_method (expected squash, merge, or rebase)."
      exit 2
      ;;
  esac

  if ! gh pr merge "$pr" \
    "$merge_flag" \
    --match-head-commit "$PREP_HEAD_SHA" \
    >.local/merge-output.log 2>&1
  then
    print_relevant_log_excerpt .local/merge-output.log
    exit 1
  fi

  local state
  state=$(gh pr view "$pr" --json state --jq .state)
  if [ "$state" != "MERGED" ]; then
    echo "Landing not finalized yet (state=$state), waiting up to 15 minutes..."
    local i
    for i in $(seq 1 90); do
      sleep 10
      state=$(gh pr view "$pr" --json state --jq .state)
      if [ "$state" = "MERGED" ]; then
        break
      fi
    done
  fi

  if [ "$state" != "MERGED" ]; then
    echo "PR state is $state after waiting."
    exit 1
  fi

  local landed_sha
  landed_sha=$(gh pr view "$pr" --json mergeCommit --jq '.mergeCommit.oid')
  if [ -z "$landed_sha" ] || [ "$landed_sha" = "null" ]; then
    echo "Landed commit SHA missing."
    exit 1
  fi
  local repo_nwo
  repo_nwo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)

  local landed_sha_url=""
  if gh api repos/:owner/:repo/commits/"$landed_sha" >/dev/null 2>&1; then
    landed_sha_url="https://github.com/$repo_nwo/commit/$landed_sha"
  else
    echo "Landed commit is not resolvable via repository commit endpoint: $landed_sha"
    exit 1
  fi

  local prep_sha_url=""
  if gh api repos/:owner/:repo/commits/"$PREP_HEAD_SHA" >/dev/null 2>&1; then
    prep_sha_url="https://github.com/$repo_nwo/commit/$PREP_HEAD_SHA"
  else
    local pr_commit_count
    pr_commit_count=$(gh pr view "$pr" --json commits --jq "[.commits[].oid | select(. == \"$PREP_HEAD_SHA\")] | length")
    if [ "${pr_commit_count:-0}" -gt 0 ]; then
      prep_sha_url="https://github.com/$repo_nwo/pull/$pr/commits/$PREP_HEAD_SHA"
    fi
  fi
  if [ -z "$prep_sha_url" ]; then
    echo "Prepared head SHA is not resolvable in repo commits or PR commit list: $PREP_HEAD_SHA"
    exit 1
  fi

  local ok=0
  local comment_output=""
  local attempt
  for attempt in 1 2 3; do
    if comment_output=$(
      {
        echo "Merged via $merge_label."
        echo
        echo "- Prepared head SHA: [$PREP_HEAD_SHA]($prep_sha_url)"
        echo "- Landed commit: [$landed_sha]($landed_sha_url)"
      } | gh pr comment "$pr" -F - 2>&1
    ); then
      ok=1
      break
    fi
    sleep 2
  done
  [ "$ok" -eq 1 ] || { echo "Failed to post PR comment after retries"; exit 1; }

  local comment_url=""
  comment_url=$(printf '%s\n' "$comment_output" | rg -o 'https://github.com/[^ ]+/pull/[0-9]+#issuecomment-[0-9]+' -m1 || true)
  if [ -z "$comment_url" ]; then
    comment_url="unresolved"
  fi

  local root
  root=$(repo_root)
  cd "$root"
  delete_remote_pr_head_branch_after_merge
  remove_worktree_if_present ".worktrees/pr-$pr"
  delete_local_branch_if_safe "temp/pr-$pr"
  delete_local_branch_if_safe "pr-$pr"
  delete_local_branch_if_safe "pr-$pr-prep"

  local pr_url
  pr_url=$(gh pr view "$pr" --json url --jq .url)

  echo "merge-run complete for PR #$pr"
  echo "landed commit: $landed_sha"
  echo "completion comment: $comment_url"
  echo "$pr_url"
}
