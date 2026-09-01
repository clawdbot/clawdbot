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
  if ! gh_plain api "repos/$MERGE_REPO_NAME/commits/$landed_sha" >"$commit_file"; then
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
    echo "The merge already completed after intervening main movement; this audit reports the residual non-atomic race."
  fi
}

# shellcheck source=scripts/pr-lib/crabbox-merge-bypass.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/crabbox-merge-bypass.sh"
# shellcheck source=scripts/pr-lib/merge-outcome.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/merge-outcome.sh"

fetch_clawsweeper_review_comments() {
  local pr="$1" repo_name="$2" repo_host="$3"
  if ! CLAWSWEEPER_REVIEW_COMMENTS=$(gh_plain api --hostname "$repo_host" --paginate --slurp \
    "repos/$repo_name/issues/$pr/comments?per_page=100" \
    -H 'Cache-Control: max-age=0'); then
    echo "ClawSweeper review gate failed: unable to read current issue comments." >&2
    return 1
  fi
}

validate_clawsweeper_review_comments() {
  local pr="$1" head_sha="$2" evidence
  if ! evidence=$(printf '%s\n' "$CLAWSWEEPER_REVIEW_COMMENTS" |
    node "$script_parent_dir/pr-lib/clawsweeper-review-gate.mjs" "$pr" "$head_sha"); then
    unset CLAWSWEEPER_REVIEW_COMMENTS
    return 1
  fi
  unset CLAWSWEEPER_REVIEW_COMMENTS
  CLAWSWEEPER_REVIEW_EVIDENCE="$evidence"
  echo "ClawSweeper completed review: comment $(printf '%s\n' "$evidence" | jq -r .commentId), reviewed $(printf '%s\n' "$evidence" | jq -r .reviewedAt)"
}

require_clawsweeper_review() {
  local pr="$1" head_sha="$2" repo_name="${3:-}" repo_host="${4:-}" repo_json
  if [ -z "$repo_name" ] || [ -z "$repo_host" ]; then
    repo_json=$(gh_plain repo view --json nameWithOwner,url) || return 1
    repo_name=$(printf '%s\n' "$repo_json" | jq -er '.nameWithOwner | select(type == "string" and length > 0)') || return 1
    repo_host=$(printf '%s\n' "$repo_json" | jq -er '.url | capture("^https://(?<host>[^/]+)/").host') || return 1
  fi
  fetch_clawsweeper_review_comments "$pr" "$repo_name" "$repo_host" || return 1
  validate_clawsweeper_review_comments "$pr" "$head_sha"
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
  git diff --name-only "${mainline_base}..${PR_MAIN_SHA}" | sed '/^$/d' | sort -u > "$delta_file"
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
  enter_worktree "$pr" false || return 1

  require_artifact .local/prep.env || return 1
  require_artifact .local/gates.env || return 1
  # shellcheck disable=SC1091
  source .local/gates.env || return 1
  # shellcheck disable=SC1091
  source .local/prep.env || return 1
  verify_prep_branch_matches_prepared_head "$pr" "${LOCAL_PREP_HEAD_SHA:-$PREP_HEAD_SHA}" || return 1

  local json
  json=$(gh_plain pr view "$pr" --json state,isDraft,headRefOid) || return 1
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

  require_clawsweeper_review "$pr" "$pr_head_sha" \
    "${MERGE_REPO_NAME:-}" "${MERGE_REPO_HOST:-}" || return 1
  mark_pr_operation_side_effects_started || return 1
  if [ "${GATES_MODE:-}" = "hosted_exact_or_recent_parent" ]; then
    # The stamp selects the owner, not proof. Revalidate before skipping the
    # PR-only watcher, which cannot observe accepted hosted release gates.
    derive_prepare_gate_change_plan "$PREP_HEAD_SHA" || return 1
    run_hosted_prepare_gates "$pr" "$PREP_HEAD_SHA" "$PREPARE_GATE_CHANGELOG_ONLY" || return 1
  else
    # Local/Crabbox preparation retains the attached-CI wait. Required checks
    # below remain merge authority; optional contexts cannot stall this path.
    node "$script_parent_dir/watch-pr-ci.mjs" "$pr" "$PREP_HEAD_SHA" \
      --completion ci-run >.local/merge-checks-watch.log 2>&1 || true
  fi
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
  # merge_run calls this function in an OR-list, disabling Bash errexit.
  # Validate every row so malformed evidence cannot fall through as green.
  if ! printf '%s\n' "$checks_json" | jq -e '
    type == "array" and all(.[]; type == "object" and
      (.bucket | IN("pass", "fail", "pending", "skipping", "cancel")))
  ' >/dev/null; then
    echo "Merge verify failed: GitHub returned invalid required-check evidence." >&2
    return 1
  fi
  local required_count
  required_count=$(printf '%s\n' "$checks_json" | jq 'length') || return 1
  if [ "$required_count" -eq 0 ]; then
    echo "No required checks configured for this PR."
  fi
  printf '%s\n' "$checks_json" | jq -r '.[] | "\(.bucket)\t\(.name)\t\(.state)"' || return 1

  local failed_required
  failed_required=$(printf '%s\n' "$checks_json" | jq '[.[] | select(.bucket!="pass" and .bucket!="pending")] | length') || return 1
  local pending_required
  pending_required=$(printf '%s\n' "$checks_json" | jq '[.[] | select(.bucket=="pending")] | length') || return 1

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

  refresh_main_snapshot || return 1
  git fetch origin "pull/$pr/head:pr-$pr" --force || return 1
  if ! git merge-base --is-ancestor "$PR_MAIN_SHA" "refs/heads/pr-$pr"; then
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
  local source_trailers
  # GraphQL publication can collapse local fixups. Preserve their reviewed
  # trailers, excluding main's ancestry, rather than inspecting current HEAD.
  source_trailers=$(git -c trailer.separators=: -c trailer.co-authored-by.key=Co-authored-by log --reverse \
    --no-show-signature --no-notes --no-color --no-decorate --encoding=UTF-8 \
    --format='%(trailers:key=Co-authored-by,only,unfold)' "$PR_MAIN_SHA..$source_head") || return 1
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
  local recovery_oid="${3:-}" recovery_record="" recovery_actor=""
  local MERGE_OUTCOME_REF MERGE_OUTCOME_OID MERGE_OUTCOME_RECORD MERGE_REPO
  local MERGE_REPO_URL MERGE_REPO_HOST MERGE_REPO_NAME MERGE_OBSERVATION
  merge_outcome_init "$pr" || return 1
  if [ -n "$recovery_oid" ]; then
    if [ "$recovery_oid" != "$MERGE_OUTCOME_OID" ] ||
      ! printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -e '
        .phase == "intent" and .accepted == false and .route == "immediate"
      ' >/dev/null; then
      merge_outcome_stop "operator recovery requires the exact retained unaccepted immediate intent; no attempt was authorized"
      return 1
    fi
    recovery_record="$MERGE_OUTCOME_RECORD"
  elif [ -n "$MERGE_OUTCOME_OID" ]; then
    # Reconciliation needs neither the old worktree nor its prepare artifacts.
    merge_outcome_resume "$pr"
    return
  fi
  enter_worktree "$pr" false || return 1
  # Earlier wrappers captured output at dispatch without recording intent. Even
  # an empty capture may represent a submitted request; never overwrite that evidence.
  if [ -z "$recovery_oid" ] && has_worktree_merge_output .; then
    merge_outcome_stop "prior merge output exists without an outcome record; preserve the captures and reconcile the earlier request manually"
    return 1
  fi

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
  merge_verify "$pr" || return 1
  # shellcheck disable=SC1091
  source .local/prep.env

  local merge_method="${OPENCLAW_PR_MERGE_METHOD:-squash}"
  if [ -n "$recovery_oid" ] && ! printf '%s\n' "$recovery_record" | jq -e \
    --arg head "$PREP_HEAD_SHA" --arg method "$merge_method" '.head == $head and .method == $method' >/dev/null; then
    merge_outcome_stop "operator recovery requires the retained prepared head and merge method"
    return 1
  fi
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

  if [ "$merge_method" = "squash" ]; then
    case "${PREP_REPLACED_HOSTED_ANCESTRY:-}" in
      true | false) ;;
      *)
        echo "Missing or invalid squash ancestry provenance; re-run scripts/pr prepare-run $pr."
        return 1
        ;;
    esac
    case "${PREP_AUTHOR_ACCESS:-}" in
      maintainer | external | unknown) ;;
      *)
        echo "Missing or invalid PR author access provenance; re-run scripts/pr prepare-run $pr."
        return 1
        ;;
    esac
    if [ "$PREP_REPLACED_HOSTED_ANCESTRY" = "true" ] && [ "$PREP_AUTHOR_ACCESS" != "maintainer" ]; then
      echo "Refusing to squash a contributor-owned PR after maintainer ancestry replacement."
      echo "Create a maintainer-owned replacement PR, link the original, and preserve public noreply co-author credit."
      return 1
    fi
  fi

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

  local crabbox_final_main_sha="" route=immediate
  local admission_attempt previous_observation=""
  # Only fresh admission waits for calculation; retained intent reconciles immediately.
  # Pin all other facts and each projection as soon as it becomes known.
  for admission_attempt in 1 2 3; do
    merge_outcome_observe "$pr" || return 1
    if ! printf '%s\n' "$MERGE_OBSERVATION" | jq -e --arg head "$PREP_HEAD_SHA" --argjson recovery "${recovery_record:-null}" '
      .pr.state == "OPEN" and .pr.headRefOid == $head and .pr.baseRefName == "main" and
      .pr.isDraft == false and .pr.mergeable != "CONFLICTING" and
      .pr.autoMergeRequest == null and .pr.isInMergeQueue == false and
      ($recovery == null or .pr.id == $recovery.prId)
    ' >/dev/null; then
      merge_outcome_stop "require OPEN, exact prepared head, main base, non-draft, no conflicts, and no existing auto/queue request; inspect current PR state"
      return 1
    fi
    if [ -n "$previous_observation" ] && ! printf '%s\n' "$MERGE_OBSERVATION" | jq -e --argjson previous "$previous_observation" '
      del(.pr.mergeable,.pr.mergeStateStatus) == ($previous | del(.pr.mergeable,.pr.mergeStateStatus)) and
      ($previous.pr.mergeable == "UNKNOWN" or .pr.mergeable == $previous.pr.mergeable) and
      ($previous.pr.mergeStateStatus == "UNKNOWN" or .pr.mergeStateStatus == $previous.pr.mergeStateStatus)
    ' >/dev/null; then
      merge_outcome_stop "PR or main changed while waiting for mergeability; stopped before intent/dispatch"
      return 1
    fi
    if printf '%s\n' "$MERGE_OBSERVATION" | jq -e '.pr.mergeable != "UNKNOWN" and .pr.mergeStateStatus != "UNKNOWN"' >/dev/null; then
      break
    fi
    if [ "$admission_attempt" -eq 3 ]; then
      merge_outcome_stop "mergeability remained UNKNOWN after 3 observations; stopped before intent/dispatch"
      return 1
    fi
    if [ "$admission_attempt" -eq 1 ]; then
      echo "Waiting for GitHub mergeability to settle (up to 3 observations, waiting 1 then 2 seconds for UNKNOWN samples)."
    fi
    previous_observation="$MERGE_OBSERVATION"
    sleep "$admission_attempt"
  done
  if [ "$MERGE_USE_CRABBOX_ADMIN_BYPASS" = true ]; then
    route="admin"
    merge_args=(--admin "${merge_args[@]}")
    merge_label="admin squash with trusted Crabbox infrastructure proof"
  elif [ "$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r .pr.isMergeQueueEnabled)" = true ]; then
    route=queue
    merge_label="merge queue (requested $merge_method)"
  elif [ "$auto_merge_requested" = true ]; then
    # Select once before intent; CLEAN needs no auto request. No dispatch error
    # can authorize a second route or request.
    case "$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r '.pr | .mergeable + "/" + .mergeStateStatus')" in
      MERGEABLE/CLEAN) ;;
      MERGEABLE/BEHIND)
        route=auto
        merge_args=(--auto "${merge_args[@]}")
        merge_label="squash auto-merge"
        ;;
      *) merge_outcome_stop "auto-merge admission requires MERGEABLE with CLEAN or BEHIND status"; return 1 ;;
    esac
  fi
  if [ -n "$recovery_oid" ] && [ "$route" != immediate ]; then
    merge_outcome_stop "operator recovery requires current immediate admission without admin, auto, or queue routing"
    return 1
  fi
  # gh skips local status refusals for queue-enabled PRs; admin bypasses BLOCKED/BEHIND.
  # Reject known client-side refusals before recording non-retryable intent.
  if printf '%s\n' "$MERGE_OBSERVATION" | jq -e --arg route "$route" '
    .pr | .isMergeQueueEnabled == false and
    (.mergeStateStatus == "DIRTY" or ($route == "immediate" and (.mergeStateStatus | IN("BLOCKED", "BEHIND"))))
  ' >/dev/null; then
    merge_outcome_stop "selected merge route is blocked by policy, branch drift, or a dirty merge projection; inspect current PR state"
    return 1
  fi
  local observed_main candidate_tree
  observed_main=$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r .main)
  if [ "$merge_method" = squash ] && [ "$route" != queue ]; then
    candidate_tree=$(git merge-tree --write-tree "$observed_main" "$PREP_HEAD_SHA") || {
      merge_outcome_stop "cannot establish prepared-head merge tree (conflict or unavailable objects)"; return 1;
    }
    if [ "$candidate_tree" = "$(git rev-parse "$observed_main^{tree}")" ]; then
      echo "NO NET CHANGE: squash produces the current main tree. PR lifecycle is unresolved; no merge, comment, or cleanup. Inspect main history and PR intent."
      return 1
    fi
  fi
  if [ -n "$recovery_oid" ]; then
    recovery_actor=$(gh_plain api --hostname "$MERGE_REPO_HOST" graphql -f 'query=query { viewer { login } }' --jq '.data.viewer.login | select(type == "string" and length > 0)') || return 1
    [ -n "$recovery_actor" ] || { merge_outcome_stop "cannot identify the operator recovery actor"; return 1; }
  fi
  merge_outcome_stable "$pr" || return 1
  if [ "$route" = admin ]; then
    verify_crabbox_admin_merge_bypass "$pr" "$PREP_HEAD_SHA" || return 1
    crabbox_final_main_sha=$(jq -er '.mainSha | select(type == "string" and test("^[0-9a-f]{40}$"))' .local/merge-crabbox-bypass.json) || return 1
    [ "$crabbox_final_main_sha" = "$observed_main" ] || {
      merge_outcome_stop "main changed during final admin admission"; return 1;
    }
  fi
  fetch_clawsweeper_review_comments "$pr" "$MERGE_REPO_NAME" "$MERGE_REPO_HOST" || return 1
  if ! merge_outcome_stable "$pr"; then
    unset CLAWSWEEPER_REVIEW_COMMENTS
    return 1
  fi
  validate_clawsweeper_review_comments "$pr" "$PREP_HEAD_SHA" || return 1
  local intent attempt
  attempt=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())') || return 1
  intent=$(printf '%s\n' "$MERGE_OBSERVATION" | jq -c --argjson repo "$MERGE_REPO" \
    --arg method "$merge_method" --arg route "$route" --arg attempt "$attempt" \
    --argjson review "$CLAWSWEEPER_REVIEW_EVIDENCE" '
    {version:1,repo:$repo,pr:.pr.number,prId:.pr.id,base:.pr.baseRefName,head:.pr.headRefOid,
     main:.main,method:$method,route:$route,attempt:$attempt,phase:"intent",accepted:false,landed:null,
     clawsweeperReview:$review}
  ') || return 1
  if [ -n "$recovery_oid" ]; then
    # This records a new operator decision, not proof that the prior request failed.
    # The outcome CAS consumes that exact decision and retains the old intent as a parent.
    intent=$(printf '%s\n' "$intent" | jq -c --arg outcome "$recovery_oid" \
      --argjson previous "$recovery_record" --arg actor "$recovery_actor" \
      '.recovery={outcome:$outcome,attempt:$previous.attempt,actor:$actor,reason:"explicit-operator-recovery"}') || return 1
  fi
  mark_pr_operation_side_effects_started
  merge_outcome_write "$intent" || return 1
  local merge_output=".local/merge-output.$attempt.log"
  # Both success and failure are reconciled. A killed process leaves intent for
  # the next invocation; an OPEN read can never authorize another dispatch. Each
  # attempt owns an exclusive capture, so recovery cannot overwrite earlier evidence.
  if (
    set -o noclobber
    exec >"$merge_output" || exit 125
    exec 2>&1
    gh_plain pr merge "$pr" --repo "$MERGE_REPO_URL" "$merge_flag" "${merge_args[@]}"
  ); then
    merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c '.accepted=true')" || return 1
  else
    # Do not read a capture we could not create; it may be somebody else's symlink.
    [ "$?" -eq 125 ] || print_relevant_log_excerpt "$merge_output"
  fi
  merge_outcome_reconcile "$pr" || return 1
  [ "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .phase)" != intent ] || return 0
  local landed_sha
  landed_sha=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .landed)
  if [ "$route" = admin ]; then
    record_crabbox_landing_parent_audit "$landed_sha" "$crabbox_final_main_sha" || return 1
  fi
  local repo_nwo
  repo_nwo="$MERGE_REPO_NAME"

  local landed_sha_url="$MERGE_REPO_URL/commit/$landed_sha"
  local prep_sha_url="$MERGE_REPO_URL/pull/$pr/commits/$PREP_HEAD_SHA"

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
      "$(jq -r 'if .status == "match" then "match" else "drift after intervening main movement; merge already completed" end' .local/merge-crabbox-parent-audit.json)" \
      "$(jq -r .expectedParentSha .local/merge-crabbox-parent-audit.json)" \
      "$(jq -r .actualParentSha .local/merge-crabbox-parent-audit.json)"
  fi
  comment_body+=$'\n\n'"<!-- openclaw-merge:$attempt -->"
  merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c '.phase="commenting"')" || return 1
  local comment_url
  if ! comment_url=$(gh_plain api --hostname "$MERGE_REPO_HOST" --method POST \
    "repos/$repo_nwo/issues/$pr/comments" --raw-field "body=$comment_body" --jq '.html_url // empty') ||
    [ -z "$comment_url" ]; then
    echo "Merge confirmed; completion comment outcome uncertain. No second POST or cleanup. Run scripts/pr merge-run $pr for read-only reconciliation."
    return 1
  fi
  merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c '.phase="commented"')" || return 1

  # Only this uninterrupted completion path owns cleanup. The exact-head lease
  # protects advanced/different-head recreations, but cannot detect same-SHA recreation.
  local head_json head_ref head_repo cleanup_complete=true
  if head_json=$(gh_plain pr view "$pr" --repo "$MERGE_REPO_URL" --json headRefOid,headRefName,headRepository,headRepositoryOwner) &&
    head_ref=$(printf '%s\n' "$head_json" | jq -er --arg head "$PREP_HEAD_SHA" 'select(.headRefOid == $head) | .headRefName | select(type == "string" and length > 0)') &&
    head_repo=$(printf '%s\n' "$head_json" | jq -er '.headRepositoryOwner.login + "/" + .headRepository.name | select(test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))') &&
    git check-ref-format "refs/heads/$head_ref"; then
    local cleanup_error ref_status=0
    if ! cleanup_error=$(git push --force-with-lease="refs/heads/$head_ref:$PREP_HEAD_SHA" \
      "https://$MERGE_REPO_HOST/$head_repo.git" ":refs/heads/$head_ref" 2>&1); then
      # GitHub may already have deleted the branch, or the delete response was
      # lost. Only a successful advertisement with no exact ref proves absence.
      git ls-remote --exit-code --refs "https://$MERGE_REPO_HOST/$head_repo.git" "refs/heads/$head_ref" >/dev/null || ref_status=$?
      if [ "$ref_status" -ne 2 ]; then
        cleanup_complete=false
        echo "Warning: remote cleanup pending; branch changed or inaccessible. Inspect $head_repo:$head_ref; never delete it by name without verifying ownership."
        printf '%s\n' "$cleanup_error" >&2
      fi
    fi
  else
    cleanup_complete=false
    echo "Warning: remote cleanup pending; unable to verify head branch metadata."
  fi
  local root
  root=$(repo_root)
  cd "$root" || return 1
  cleanup_pr_worktree ".worktrees/pr-$pr" || cleanup_complete=false
  if [ "$cleanup_complete" = true ]; then
    merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c '.phase="complete"')" || return 1
    echo "merge-run complete for PR #$pr"
  else
    echo "Merge confirmed; completion pending: inspect cleanup warnings. Recovery will not delete branches or worktrees."
  fi
  echo "landed commit: $landed_sha"
  echo "completion comment: $comment_url"
  echo "$MERGE_REPO_URL/pull/$pr"
}
