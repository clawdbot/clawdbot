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

auto_merge_unavailable_error() {
  local log_file="$1"
  rg -q -i -- \
    'auto[- ]merge.*(not allowed|not enabled|not available|unavailable|not configured|not supported|must be enabled)|(not allowed|not enabled|not available|unavailable|not configured|not supported|must be enabled).*auto[- ]merge' \
    "$log_file"
}

record_crabbox_landing_parent_audit() {
  local landed_sha="$1"
  local expected_parent_sha="$2"
  local commit_file=".local/merge-crabbox-landed-commit.json"
  local audit_file=".local/merge-crabbox-parent-audit.json"
  local audit_tmp
  if ! rm -f "$audit_file" ||
    ! audit_tmp=$(mktemp .local/merge-crabbox-parent-audit.XXXXXX); then
    echo "merge completed; post-merge audit failed: unable to prepare the landing parent artifact." >&2
    return 1
  fi
  if ! gh_plain api "repos/{owner}/{repo}/commits/$landed_sha" >"$commit_file"; then
    rm -f "$audit_tmp"
    echo "Crabbox landing parent audit failed after merge: unable to read landed commit $landed_sha." >&2
    return 1
  fi

  local actual_parent_sha
  actual_parent_sha=$(jq -er '
    .parents
    | select(type == "array" and length > 0)
    | .[0].sha
    | select(type == "string" and test("^[0-9a-f]{40}$"))
  ' "$commit_file") || {
    rm -f "$audit_tmp"
    echo "Crabbox landing parent audit failed after merge: landed commit has no valid first parent." >&2
    return 1
  }

  local status="match"
  if [ "$actual_parent_sha" != "$expected_parent_sha" ]; then
    status="drift"
  fi
  if ! jq -n \
    --arg actualParentSha "$actual_parent_sha" \
    --arg expectedParentSha "$expected_parent_sha" \
    --arg landedSha "$landed_sha" \
    --arg status "$status" \
    '{status: $status, landedSha: $landedSha, expectedParentSha: $expectedParentSha, actualParentSha: $actualParentSha}' \
    >"$audit_tmp"; then
    rm -f "$audit_tmp"
    echo "merge completed; post-merge audit failed: unable to serialize landing parent evidence." >&2
    return 1
  fi
  if ! mv "$audit_tmp" "$audit_file"; then
    rm -f "$audit_tmp"
    echo "merge completed; post-merge audit failed: unable to publish the landing parent artifact." >&2
    return 1
  fi

  if [ "$status" = "match" ]; then
    echo "Crabbox landing parent audit matched: landed=$landed_sha parent=$actual_parent_sha"
  else
    echo "Crabbox landing parent audit drift: landed=$landed_sha expected_parent=$expected_parent_sha actual_parent=$actual_parent_sha"
    echo "The merge already completed after an intervening authorized main advance; this audit reports the residual non-atomic race."
  fi
}

# shellcheck source=scripts/pr-lib/crabbox-merge-bypass.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/crabbox-merge-bypass.sh"

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
  MERGE_USE_CRABBOX_ADMIN_BYPASS=false
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
  # Wait only for the attached CI workflow here. The direct required-check
  # query below remains the merge authority, so optional contexts cannot stall it.
  node "$script_parent_dir/watch-pr-ci.mjs" "$pr" "$PREP_HEAD_SHA" \
    --completion ci-run >.local/merge-checks-watch.log 2>&1 || true
  local checks_json
  local checks_err_file
  local checks_exit_status
  checks_err_file=$(mktemp)
  if checks_json=$(gh_plain pr checks "$pr" --required --json name,bucket,state 2>"$checks_err_file"); then
    checks_exit_status=0
  else
    checks_exit_status=$?
  fi
  # gh documents exit 8 for pending checks even when it emits valid JSON. Let
  # the checked evidence below reject pending checks without hiding API errors.
  if [ "$checks_exit_status" -ne 0 ] && [ "$checks_exit_status" -ne 8 ]; then
    local checks_error
    checks_error=$(cat "$checks_err_file")
    case "$checks_error" in
      "no required checks reported on the '"*"' branch")
        # gh reports the valid empty-required set as an error, not a JSON array.
        checks_json='[]'
        ;;
      *)
        echo "Merge verify failed: unable to verify the required GitHub checks." >&2
        printf '%s\n' "$checks_error" >&2
        rm -f "$checks_err_file"
        return 1
        ;;
    esac
  fi
  rm -f "$checks_err_file"
  if ! printf '%s\n' "$checks_json" | jq -e 'type == "array"' >/dev/null; then
    echo "Merge verify failed: GitHub returned invalid required-check evidence." >&2
    return 1
  fi
  local required_count
  required_count=$(printf '%s\n' "$checks_json" | jq 'length')
  if [ "$required_count" -eq 0 ]; then
    echo "No required checks configured for this PR."
  fi
  printf '%s\n' "$checks_json" | jq -r '.[] | "\(.bucket)\t\(.name)\t\(.state)"'

  local failed_required
  failed_required=$(printf '%s\n' "$checks_json" | jq '[.[] | select(.bucket=="fail" or .bucket=="skipping")] | length')
  local pending_required
  pending_required=$(printf '%s\n' "$checks_json" | jq '[.[] | select(.bucket=="pending")] | length')

  if [ "$pending_required" -gt 0 ]; then
    echo "Required checks are still pending."
    exit 1
  fi

  if [ "$failed_required" -gt 0 ]; then
    echo "Required checks are failing; checking the bounded Crabbox infrastructure fallback."
    if ! verify_crabbox_admin_merge_bypass "$pr" "$PREP_HEAD_SHA"; then
      echo "Crabbox merge bypass evidence is not sufficient." >&2
      echo "Required checks are failing."
      exit 1
    fi
    MERGE_USE_CRABBOX_ADMIN_BYPASS=true
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

prepare_squash_merge_body() {
  local pr="$1" source_head="${LOCAL_PREP_HEAD_SHA:-$PREP_HEAD_SHA}"
  local main_sha source_trailers
  main_sha=$(git rev-parse --verify refs/remotes/origin/main) || return 1
  # GraphQL publication can collapse local fixups. Preserve their reviewed
  # trailers, excluding main's ancestry, rather than inspecting current HEAD.
  source_trailers=$(git -c trailer.separators=: -c trailer.co-authored-by.key=Co-authored-by log --reverse \
    --no-show-signature --no-notes --no-color --no-decorate --encoding=UTF-8 \
    --format='%(trailers:key=Co-authored-by,only,unfold)' "$main_sha..$source_head") || return 1
  [ -n "$source_trailers" ] || return 0

  local repo_nwo preview
  repo_nwo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || return 1
  preview=$(gh_plain api graphql \
    -f 'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid isMergeQueueEnabled viewerMergeBodyText(mergeType:SQUASH)}}}' \
    -f owner="${repo_nwo%/*}" -f name="${repo_nwo#*/}" -F number="$pr") || return 1
  if ! printf '%s\n' "$preview" | jq -e --arg head "$PREP_HEAD_SHA" '
    .data.repository.pullRequest | .headRefOid == $head and
      (.viewerMergeBodyText | type == "string") and .isMergeQueueEnabled == false
  ' >/dev/null; then
    echo "Cannot preserve squash credit: require a current-head message from a non-queue PR. Refresh prepare evidence and check the merge queue policy." >&2
    return 1
  fi

  local body_file envelope original_trailers final_trailers message trailer
  body_file=$(mktemp .local/merge-body.XXXXXX) || return 1
  # Git parses complete commit messages; a body containing only trailers needs
  # a temporary subject. Keep all authors in one terminal trailer block.
  envelope=$'OpenClaw merge message\n\n'
  printf '%s' "$envelope" > "$body_file" || return 1
  printf '%s\n' "$preview" | jq -r '.data.repository.pullRequest.viewerMergeBodyText' >> "$body_file" || return 1
  original_trailers=$(git -c trailer.separators=: -c trailer.co-authored-by.key=Co-authored-by interpret-trailers \
    --parse --no-divider "$body_file") || return 1
  # Mutating interpret-trailers runs configured trailer commands. Parse only,
  # then append missing values without rewriting the server's existing text.
  message=$(printf '%s\n' "$preview" | jq -r '.data.repository.pullRequest.viewerMergeBodyText') || return 1
  while [[ "$message" == *$'\n'* ]] && [[ "${message##*$'\n'}" != *[!$' \t\r']* ]]; do
    message="${message%$'\n'*}"
  done
  local known_trailers="$original_trailers" separator=$'\n\n'
  [ -z "$original_trailers" ] || separator=$'\n'
  while IFS= read -r trailer; do
    [ -n "$trailer" ] || continue
    if ! printf '%s\n' "$known_trailers" | grep -Fxq -- "$trailer"; then
      [ -z "$message" ] || message+="$separator"
      message+="$trailer"
      known_trailers+=$'\n'"$trailer"
      separator=$'\n'
    fi
  done <<< "$source_trailers"
  printf '%s%s\n' "$envelope" "$message" > "$body_file" || return 1
  final_trailers=$(git -c trailer.separators=: -c trailer.co-authored-by.key=Co-authored-by interpret-trailers \
    --parse --no-divider "$body_file") || return 1
  while IFS= read -r trailer; do
    [ -n "$trailer" ] || continue
    if ! printf '%s\n' "$final_trailers" | grep -Fxq -- "$trailer"; then
      echo "Cannot preserve squash credit: the final message lost a source or preview trailer." >&2
      return 1
    fi
  done <<< "$original_trailers
$source_trailers"
  printf '%s\n' "$message" > "$body_file" || return 1
  printf '%s\n' "$body_file"
}

merge_run() {
  local pr="$1"
  local auto_merge_requested="${2:-false}"
  enter_worktree "$pr" false

  local required
  for required in \
    .local/review.md \
    .local/review.json \
    .local/pr-meta.env \
    .local/pr-meta.json \
    .local/prep.md \
    .local/prep.env
  do
    require_artifact "$required"
  done

  validate_review_artifact_data || return 1
  require_ready_review_recommendation || return 1
  merge_verify "$pr"
  # shellcheck disable=SC1091
  source .local/prep.env

  local pr_meta_json
  pr_meta_json=$(read_pr_view_json "$pr" "state,isDraft") || exit 1
  local is_draft
  is_draft=$(printf '%s\n' "$pr_meta_json" | jq -r .isDraft)
  if [ "$is_draft" = "true" ]; then
    echo "PR is draft; stop."
    exit 1
  fi

  delete_remote_pr_head_branch_after_merge() {
    local head_json head_ref
    if ! head_json=$(gh pr view "$pr" --json headRefName,headRepository,headRepositoryOwner); then
      echo "Warning: unable to read PR head metadata for remote branch cleanup"
      return 0
    fi
    head_ref=$(printf '%s\n' "$head_json" | jq -r '.headRefName // ""')
    if [ -z "$head_ref" ]; then
      return 0
    fi

    local repo_owner repo_name
    repo_owner=$(printf '%s\n' "$head_json" | jq -r '.headRepositoryOwner.login // ""')
    repo_name=$(printf '%s\n' "$head_json" | jq -r '.headRepository.name // ""')
    if [ -z "$repo_owner" ] || [ -z "$repo_name" ]; then
      echo "Warning: unable to resolve head repository for remote branch cleanup"
      return 0
    fi

    local encoded_ref delete_error matching_refs
    encoded_ref=$(jq -rn --arg value "heads/$head_ref" '$value|@uri')
    if delete_error=$(gh_plain api -X DELETE "repos/$repo_owner/$repo_name/git/refs/$encoded_ref" 2>&1); then
      return 0
    fi

    # GitHub may auto-delete the head before cleanup. Only a fresh, valid ref
    # listing proves absence; longer prefix siblings are not the target.
    if matching_refs=$(gh_plain api -X GET "repos/$repo_owner/$repo_name/git/matching-refs/$encoded_ref") &&
      printf '%s\n' "$matching_refs" | jq -se --arg ref "refs/heads/$head_ref" '
        length == 1 and (.[0] | type == "array" and
          all(.[]; (.ref | type == "string" and startswith($ref)) and .ref != $ref))
      ' >/dev/null; then
      return 0
    fi

    echo "Warning: failed to delete remote branch $repo_owner/$repo_name:$head_ref"
    printf '%s\n' "$delete_error" >&2
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

  if [ "$MERGE_USE_CRABBOX_ADMIN_BYPASS" = "true" ] && [ "$merge_method" != "squash" ]; then
    echo "Crabbox infrastructure bypass requires the pinned squash merge method."
    exit 2
  fi
  if [ "$MERGE_USE_CRABBOX_ADMIN_BYPASS" = "true" ] && [ "$auto_merge_requested" = "true" ]; then
    echo "Crabbox infrastructure bypass uses an immediate pinned admin squash merge; ignoring auto-merge."
    auto_merge_requested=false
  fi

  if [ "$auto_merge_requested" = "true" ] && [ "$merge_method" != "squash" ]; then
    echo "Auto-merge requires squash; unset OPENCLAW_PR_MERGE_METHOD or set it to squash."
    exit 2
  fi

  local merge_args=(--match-head-commit "$PREP_HEAD_SHA")
  if [ "$merge_method" = "squash" ]; then
    local merge_body_file
    merge_body_file=$(prepare_squash_merge_body "$pr") || return 1
    [ -z "$merge_body_file" ] || merge_args+=(--body-file "$merge_body_file")
  fi

  local crabbox_final_main_sha=""
  local merge_submitted=false
  local state=""
  # Auto-merge is only a post-verification landing strategy. Keep every
  # artifact, exact-head, required-check, and drift check in merge_verify.
  if [ "$auto_merge_requested" = "true" ]; then
    local auto_meta
    auto_meta=$(read_pr_view_json "$pr" "state,headRefOid,mergeable,mergeStateStatus,autoMergeRequest") || exit 1
    local auto_head_sha
    auto_head_sha=$(printf '%s\n' "$auto_meta" | jq -r .headRefOid)
    if [ "$auto_head_sha" != "$PREP_HEAD_SHA" ]; then
      echo "PR head changed before auto-merge enablement (expected $PREP_HEAD_SHA, got $auto_head_sha)."
      exit 1
    fi

    local mergeable
    local merge_state_status
    local existing_auto_method
    mergeable=$(printf '%s\n' "$auto_meta" | jq -r '.mergeable // "UNKNOWN"')
    merge_state_status=$(printf '%s\n' "$auto_meta" | jq -r '.mergeStateStatus // "UNKNOWN"')
    existing_auto_method=$(printf '%s\n' "$auto_meta" | jq -r '.autoMergeRequest.mergeMethod // ""')

    if [ "$mergeable" = "CONFLICTING" ]; then
      echo "PR is not mergeable: GitHub reports merge conflicts."
      exit 1
    fi

    if [ -n "$existing_auto_method" ]; then
      echo "Auto-merge is already enabled with $existing_auto_method; re-arming it as pinned SQUASH."
      if ! gh_plain pr merge "$pr" --disable-auto >.local/merge-output.log 2>&1; then
        print_relevant_log_excerpt .local/merge-output.log
        exit 1
      fi
      auto_meta=$(read_pr_view_json "$pr" "state,headRefOid,mergeable,mergeStateStatus,autoMergeRequest") || exit 1
      auto_head_sha=$(printf '%s\n' "$auto_meta" | jq -r .headRefOid)
      mergeable=$(printf '%s\n' "$auto_meta" | jq -r '.mergeable // "UNKNOWN"')
      merge_state_status=$(printf '%s\n' "$auto_meta" | jq -r '.mergeStateStatus // "UNKNOWN"')
      existing_auto_method=$(printf '%s\n' "$auto_meta" | jq -r '.autoMergeRequest.mergeMethod // ""')
      if [ "$auto_head_sha" != "$PREP_HEAD_SHA" ]; then
        echo "PR head changed while re-arming auto-merge (expected $PREP_HEAD_SHA, got $auto_head_sha)."
        exit 1
      fi
      if [ -n "$existing_auto_method" ]; then
        echo "Auto-merge remained enabled after GitHub accepted the disable request."
        exit 1
      fi
    fi

    if [ "$mergeable" != "MERGEABLE" ] || [ "$merge_state_status" != "BEHIND" ]; then
      echo "Auto-merge eligibility not met (mergeable=$mergeable, mergeStateStatus=$merge_state_status; expected MERGEABLE/BEHIND)."
      echo "Falling back to the current immediate pinned merge behavior."
    else
      # GitHub's EnablePullRequestAutoMergeInput contract keeps expectedHeadOid
      # as the head that must match to allow the eventual merge.
      if gh_plain pr merge "$pr" \
        --auto \
        --squash \
        "${merge_args[@]}" \
        >.local/merge-output.log 2>&1
      then
        auto_meta=$(read_pr_view_json "$pr" "state,headRefOid,mergeable,mergeStateStatus,autoMergeRequest") || exit 1
        auto_head_sha=$(printf '%s\n' "$auto_meta" | jq -r .headRefOid)
        state=$(printf '%s\n' "$auto_meta" | jq -r .state)
        existing_auto_method=$(printf '%s\n' "$auto_meta" | jq -r '.autoMergeRequest.mergeMethod // ""')
        if [ "$auto_head_sha" != "$PREP_HEAD_SHA" ]; then
          echo "PR head changed while enabling auto-merge (expected $PREP_HEAD_SHA, got $auto_head_sha)."
          exit 1
        elif [ "$state" = "MERGED" ]; then
          merge_submitted=true
          merge_label="squash auto-merge"
        elif [ "$existing_auto_method" = "SQUASH" ]; then
          echo "AUTO-MERGE ENABLED for PR #$pr at $PREP_HEAD_SHA."
          echo "GitHub will land it via squash when required checks and branch up-to-dateness are satisfied."
          return 0
        else
          echo "GitHub accepted the auto-merge command but did not report a squash auto-merge request."
          print_relevant_log_excerpt .local/merge-output.log
          exit 1
        fi
      else
        auto_meta=$(read_pr_view_json "$pr" "state,headRefOid,autoMergeRequest") || exit 1
        auto_head_sha=$(printf '%s\n' "$auto_meta" | jq -r .headRefOid)
        existing_auto_method=$(printf '%s\n' "$auto_meta" | jq -r '.autoMergeRequest.mergeMethod // ""')
        if [ "$auto_head_sha" = "$PREP_HEAD_SHA" ] && [ -n "$existing_auto_method" ]; then
          echo "Auto-merge enablement was inconclusive; clearing the observed $existing_auto_method request to fail closed."
          if ! gh_plain pr merge "$pr" --disable-auto >>.local/merge-output.log 2>&1; then
            print_relevant_log_excerpt .local/merge-output.log
            exit 1
          fi
          auto_meta=$(gh pr view "$pr" --json state,headRefOid,autoMergeRequest)
          auto_head_sha=$(printf '%s\n' "$auto_meta" | jq -r .headRefOid)
          existing_auto_method=$(printf '%s\n' "$auto_meta" | jq -r '.autoMergeRequest.mergeMethod // ""')
          if [ "$auto_head_sha" != "$PREP_HEAD_SHA" ] || [ -n "$existing_auto_method" ]; then
            echo "Unable to prove the inconclusive auto-merge request was cleared at the verified head."
            exit 1
          fi
          echo "The inconclusive auto-merge request was cleared safely; re-run merge-run to retry."
          exit 1
        fi
        if ! auto_merge_unavailable_error .local/merge-output.log; then
          print_relevant_log_excerpt .local/merge-output.log
          exit 1
        fi
        echo "GitHub auto-merge is unavailable for this repository or branch protection; falling back to the current immediate pinned merge behavior."
        print_relevant_log_excerpt .local/merge-output.log
      fi
    fi
  fi

  if [ "$merge_submitted" != "true" ]; then
    if [ "$MERGE_USE_CRABBOX_ADMIN_BYPASS" = "true" ]; then
      if ! verify_crabbox_admin_merge_bypass "$pr" "$PREP_HEAD_SHA"; then
        echo "Crabbox merge bypass evidence is not sufficient." >&2
        exit 1
      fi
      crabbox_final_main_sha=$(jq -er '
        .workflowSha
        | select(type == "string" and test("^[0-9a-f]{40}$"))
      ' .local/merge-crabbox-bypass.json) || {
        echo "Crabbox merge bypass did not preserve the final protected-main SHA." >&2
        exit 1
      }
      merge_label="admin squash with trusted Crabbox infrastructure proof"
      if ! gh_plain pr merge "$pr" \
        --admin \
        "$merge_flag" \
        "${merge_args[@]}" \
        >.local/merge-output.log 2>&1
      then
        print_relevant_log_excerpt .local/merge-output.log
        exit 1
      fi
    else
      if ! gh_plain pr merge "$pr" \
        "$merge_flag" \
        "${merge_args[@]}" \
        >.local/merge-output.log 2>&1
      then
        print_relevant_log_excerpt .local/merge-output.log
        exit 1
      fi
    fi
  fi

  if [ -z "$state" ]; then
    state=$(gh pr view "$pr" --json state --jq .state)
  fi
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
  if [ "$MERGE_USE_CRABBOX_ADMIN_BYPASS" = "true" ]; then
    record_crabbox_landing_parent_audit "$landed_sha" "$crabbox_final_main_sha" || exit 1
  fi
  local repo_nwo
  repo_nwo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)

  local landed_sha_url="https://github.com/$repo_nwo/commit/$landed_sha"
  local prep_sha_url="https://github.com/$repo_nwo/pull/$pr/commits/$PREP_HEAD_SHA"

  local ok=0
  local comment_body
  printf -v comment_body \
    'Merged via %s.\n\n- Prepared head SHA: [%s](%s)\n- Landed commit: [%s](%s)' \
    "$merge_label" \
    "$PREP_HEAD_SHA" \
    "$prep_sha_url" \
    "$landed_sha" \
    "$landed_sha_url"
  if [ "$MERGE_USE_CRABBOX_ADMIN_BYPASS" = "true" ]; then
    local crabbox_check_url
    local ci_gate_url
    crabbox_check_url=$(jq -r .crabboxCheckUrl .local/merge-crabbox-bypass.json)
    ci_gate_url=$(jq -r .ciGateUrl .local/merge-crabbox-bypass.json)
    printf -v comment_body \
      '%s\n- Alternate gate: [openclaw/crabbox-gate](%s)\n- Hosted CI infrastructure failure: [openclaw/ci-gate](%s)\n- Landing parent audit: %s (expected `%s`, actual `%s`)' \
      "$comment_body" \
      "$crabbox_check_url" \
      "$ci_gate_url" \
      "$(jq -r 'if .status == "match" then "match" else "drift after an intervening authorized main advance; merge already completed" end' .local/merge-crabbox-parent-audit.json)" \
      "$(jq -r .expectedParentSha .local/merge-crabbox-parent-audit.json)" \
      "$(jq -r .actualParentSha .local/merge-crabbox-parent-audit.json)"
  fi
  local comment_url=""
  local comment_err_file
  comment_err_file=$(mktemp)
  local attempt
  for attempt in 1 2 3; do
    if comment_url=$(
      gh_plain api \
        --method POST \
        "repos/{owner}/{repo}/issues/$pr/comments" \
        --raw-field "body=$comment_body" \
        --jq '.html_url // empty' \
        2>"$comment_err_file"
    ) && [ -n "$comment_url" ]; then
      ok=1
      break
    fi
    sleep 2
  done
  rm -f "$comment_err_file"
  [ "$ok" -eq 1 ] || { echo "Failed to post PR comment after retries"; exit 1; }

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
