checkout_prep_branch() {
  local pr="$1"
  require_artifact .local/prep-context.env
  # shellcheck disable=SC1091
  source .local/prep-context.env

  local prep_branch
  prep_branch=$(resolve_prep_branch_name "$pr")
  git checkout "$prep_branch"
}

refresh_prep_branch_for_reviewed_head() {
  local pr="$1"
  require_artifact .local/pr-meta.env
  require_artifact .local/prep-context.env

  # Capture the prepare context before review metadata overrides the same names.
  # shellcheck disable=SC1091
  source .local/prep-context.env
  local prepared_head_ref="${PR_HEAD:-}"
  local recorded_source_head="${PR_HEAD_SHA_BEFORE:-}"
  local prep_branch="${PREP_BRANCH:-pr-$pr-prep}"

  # shellcheck disable=SC1091
  source .local/pr-meta.env
  local reviewed_head_ref="${PR_HEAD:-}"
  local reviewed_head_sha="${PR_HEAD_SHA:-}"

  if [ -z "$recorded_source_head" ] || [ -z "$reviewed_head_sha" ]; then
    echo "Prepare head refresh failed: missing recorded or reviewed PR head SHA. Re-run review-init and prepare-init."
    exit 1
  fi
  if [ -n "$prepared_head_ref" ] && [ "$prepared_head_ref" != "$reviewed_head_ref" ]; then
    echo "PR head branch changed from $prepared_head_ref to $reviewed_head_ref. Re-run review-init and prepare-init."
    exit 1
  fi
  if [ "$recorded_source_head" = "$reviewed_head_sha" ]; then
    return 0
  fi

  local reviewed_ref="refs/heads/pr-$pr"
  local fetched_reviewed_head=""
  if git show-ref --verify --quiet "$reviewed_ref"; then
    fetched_reviewed_head=$(git rev-parse "$reviewed_ref")
  fi
  if [ "$fetched_reviewed_head" != "$reviewed_head_sha" ]; then
    echo "Reviewed PR head $reviewed_head_sha is not available at $reviewed_ref (found ${fetched_reviewed_head:-missing})."
    echo "Re-run scripts/pr review-init $pr before preparing."
    exit 1
  fi

  local prior_prep_head
  prior_prep_head=$(git rev-parse "refs/heads/$prep_branch")
  echo "Prep source head changed from $recorded_source_head to reviewed head $reviewed_head_sha."
  echo "Rebuilding $prep_branch from the reviewed PR head and invalidating stale prepare evidence."
  git checkout -B "$prep_branch" "$reviewed_head_sha"
  rm -f \
    .local/gates.env \
    .local/prep.env \
    .local/prepare-push-result.env \
    .local/prepare-sync-result.env

  # Security: shell-escape values before sourcing this context later.
  printf '%s=%q\n' \
    PR_NUMBER "$pr" \
    PR_HEAD "$reviewed_head_ref" \
    PR_HEAD_SHA_BEFORE "$reviewed_head_sha" \
    PREP_BRANCH "$prep_branch" \
    PREP_STARTED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > .local/prep-context.env

  if [ ! -f .local/prep.md ]; then
    printf '# PR %s prepare log\n\n' "$pr" > .local/prep.md
  fi
  cat >> .local/prep.md <<EOF_PREP
- Rebuilt prep branch $prep_branch after reviewed PR head drifted from $recorded_source_head to $reviewed_head_sha.
- Previous prep tip was $prior_prep_head; stale gate and prepare evidence was invalidated.
EOF_PREP
  PREP_BRANCH_REFRESHED=true
}

resolve_prep_branch_name() {
  local pr="$1"
  require_artifact .local/prep-context.env
  # shellcheck disable=SC1091
  source .local/prep-context.env

  local prep_branch="${PREP_BRANCH:-pr-$pr-prep}"
  if ! git show-ref --verify --quiet "refs/heads/$prep_branch"; then
    echo "Expected prep branch $prep_branch not found. Run prepare-init first."
    exit 1
  fi

  printf '%s\n' "$prep_branch"
}

verify_prep_branch_matches_prepared_head() {
  local pr="$1"
  local prepared_head_sha="$2"

  local prep_branch
  prep_branch=$(resolve_prep_branch_name "$pr")
  local prep_branch_head_sha
  prep_branch_head_sha=$(git rev-parse "refs/heads/$prep_branch")
  if [ "$prep_branch_head_sha" = "$prepared_head_sha" ]; then
    return 0
  fi

  echo "Local prep branch moved after prepare-push (branch=$prep_branch expected $prepared_head_sha, got $prep_branch_head_sha)."
  if git merge-base --is-ancestor "$prepared_head_sha" "$prep_branch_head_sha" 2>/dev/null; then
    echo "Unpushed local commits on prep branch:"
    git log --oneline "${prepared_head_sha}..${prep_branch_head_sha}" | sed 's/^/  /' || true
    echo "Run scripts/pr prepare-sync-head $pr to push them before merge."
  else
    echo "Prep branch no longer contains the prepared head. Re-run prepare-init."
  fi
  exit 1
}

prepare_init() {
  local pr="$1"
  mark_pr_operation_side_effects_started
  enter_worktree "$pr" true

  require_artifact .local/pr-meta.env
  require_artifact .local/review.md

  if [ ! -s .local/review.json ]; then
    echo "WARNING: .local/review.json is missing; structured findings are expected."
  fi

  local recorded_source_head=""
  if [ -s .local/prep-context.env ]; then
    recorded_source_head=$(
      unset PR_HEAD_SHA_BEFORE
      # shellcheck disable=SC1091
      source .local/prep-context.env
      printf '%s\n' "${PR_HEAD_SHA_BEFORE:-}"
    )
  fi

  # shellcheck disable=SC1091
  source .local/pr-meta.env
  local reviewed_head="${PR_HEAD:-}"
  local reviewed_head_sha="${PR_HEAD_SHA:-}"
  if [ -z "$reviewed_head_sha" ]; then
    echo "Prepare init failed: missing PR_HEAD_SHA in .local/pr-meta.env. Re-run review-init."
    exit 1
  fi

  local json
  json=$(pr_meta_json "$pr")

  local head
  head=$(printf '%s\n' "$json" | jq -r .headRefName)
  local pr_head_sha_before
  pr_head_sha_before=$(printf '%s\n' "$json" | jq -r .headRefOid)

  if [ -n "$reviewed_head" ] && [ "$head" != "$reviewed_head" ]; then
    echo "PR head branch changed from $reviewed_head to $head. Re-run review-init."
    exit 1
  fi
  if [ "$pr_head_sha_before" != "$reviewed_head_sha" ]; then
    echo "PR head changed after review-init (reviewed $reviewed_head_sha, live $pr_head_sha_before). Re-run review-init."
    exit 1
  fi

  git fetch origin "pull/$pr/head:pr-$pr" --force
  local fetched_head_sha
  fetched_head_sha=$(git rev-parse "refs/heads/pr-$pr")
  if [ "$fetched_head_sha" != "$reviewed_head_sha" ]; then
    echo "PR head changed while prepare-init fetched it (reviewed $reviewed_head_sha, fetched $fetched_head_sha). Re-run review-init."
    exit 1
  fi
  git checkout -B "pr-$pr-prep" "$reviewed_head_sha"
  git fetch origin main

  # Security: shell-escape values to prevent command injection via malicious branch names.
  printf '%s=%q\n' \
    PR_NUMBER "$pr" \
    PR_HEAD "$reviewed_head" \
    PR_HEAD_SHA_BEFORE "$reviewed_head_sha" \
    PREP_BRANCH "pr-$pr-prep" \
    PREP_STARTED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > .local/prep-context.env

  if [ ! -f .local/prep.md ]; then
    cat > .local/prep.md <<EOF_PREP
# PR $pr prepare log

- Initialized prepare context from the PR head branch without rebasing on origin/main.
EOF_PREP
  fi
  if [ -n "$recorded_source_head" ] && [ "$recorded_source_head" != "$reviewed_head_sha" ]; then
    echo "Rebuilt pr-$pr-prep after reviewed PR head changed from $recorded_source_head to $reviewed_head_sha."
    cat >> .local/prep.md <<EOF_PREP
- Rebuilt prep branch pr-$pr-prep after reviewed PR head changed from $recorded_source_head to $reviewed_head_sha.
EOF_PREP
  fi

  echo "worktree=$PWD"
  echo "branch=$(git branch --show-current)"
  echo "wrote=.local/prep-context.env .local/prep.md"
}

prepare_validate_commit() {
  local pr="$1"
  enter_worktree "$pr" false
  require_artifact .local/pr-meta.env

  mark_pr_operation_side_effects_started
  checkout_prep_branch "$pr"

  # shellcheck disable=SC1091
  source .local/pr-meta.env
  local pr_number="${PR_NUMBER:-$pr}"

  local subject
  subject=$(git log -1 --pretty=%s)

  if echo "$subject" | rg -qi "(^|[[:space:]])openclaw#$pr_number([[:space:]]|$)|\\(#$pr_number\\)"; then
    echo "ERROR: prep commit subject should not include PR number metadata"
    exit 1
  fi

  if echo "$subject" | rg -qi "thanks @"; then
    echo "ERROR: prep commit subject should not include contributor thanks"
    exit 1
  fi

  echo "prep commit subject validated: $subject"
}

prepare_push() {
  local pr="$1"
  enter_worktree "$pr" false

  require_artifact .local/pr-meta.env
  require_artifact .local/prep-context.env

  mark_pr_operation_side_effects_started
  PREP_BRANCH_REFRESHED=false
  refresh_prep_branch_for_reviewed_head "$pr"
  checkout_prep_branch "$pr"
  if [ "$PREP_BRANCH_REFRESHED" = "true" ]; then
    echo "Prep branch was refreshed for reviewed head drift; rerunning prepare gates before push."
    prepare_gates "$pr"
    checkout_prep_branch "$pr"
  fi
  require_artifact .local/gates.env

  # shellcheck disable=SC1091
  source .local/pr-meta.env
  # shellcheck disable=SC1091
  source .local/prep-context.env
  # shellcheck disable=SC1091
  source .local/gates.env

  local prep_head_sha
  prep_head_sha=$(git rev-parse HEAD)
  local local_prep_head_sha

  local lease_sha
  lease_sha=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
  local push_result_env=".local/prepare-push-result.env"

  verify_pr_head_branch_matches_expected "$pr" "$PR_HEAD"
  push_prep_head_to_pr_branch "$pr" "$PR_HEAD" "$prep_head_sha" "$lease_sha" true "${DOCS_ONLY:-false}" "$push_result_env"
  # shellcheck disable=SC1090
  source "$push_result_env"
  # A lease retry reruns gates for the rebased head and rewrites gates.env;
  # re-source so prep.md/prep.env carry the stamp for the head actually pushed.
  # shellcheck disable=SC1091
  source .local/gates.env
  prep_head_sha="$PUSH_PREP_HEAD_SHA"
  local_prep_head_sha="$PUSH_LOCAL_PREP_HEAD_SHA"
  local mainline_base_sha
  mainline_base_sha=$(git merge-base "$local_prep_head_sha" origin/main) || {
    echo "Unable to resolve the prepared mainline base."
    exit 1
  }
  local pushed_from_sha="$PUSHED_FROM_SHA"
  local pr_head_sha_after="$PR_HEAD_SHA_AFTER_PUSH"

  local contrib="${PR_AUTHOR:-}"
  if [ -z "$contrib" ]; then
    contrib=$(gh pr view "$pr" --json author --jq .author.login)
  fi
  local coauthor_email=""
  if coauthor_email=$(resolve_contributor_coauthor_email "$contrib"); then
    :
  else
    coauthor_email=""
  fi

  cat >> .local/prep.md <<EOF_PREP
- Gates passed and push succeeded to branch $PR_HEAD.
- Gate mode: ${GATES_MODE:-unknown}.
- Verified the remote PR head tree matches the local prep head.
EOF_PREP
  if [ -n "${REMOTE_GATES_LEASE_ID:-}" ]; then
    cat >> .local/prep.md <<EOF_PREP
- Remote testbox gate stamp: ${REMOTE_GATES_LEASE_ID}${REMOTE_GATES_RUN_URL:+ (${REMOTE_GATES_RUN_URL})}.
EOF_PREP
  fi

  # Security: shell-escape values to prevent command injection via propagated PR_HEAD.
  printf '%s=%q\n' \
    PR_NUMBER "$PR_NUMBER" \
    PR_AUTHOR "$contrib" \
    PR_URL "${PR_URL:-}" \
    PR_HEAD "$PR_HEAD" \
    PR_HEAD_SHA_BEFORE "$pushed_from_sha" \
    PREP_HEAD_SHA "$prep_head_sha" \
    LOCAL_PREP_HEAD_SHA "$local_prep_head_sha" \
    PREP_MAINLINE_BASE_SHA "$mainline_base_sha" \
    COAUTHOR_EMAIL "$coauthor_email" \
    > .local/prep.env

  ls -la .local/prep.md .local/prep.env >/dev/null

  echo "prepare-push complete"
  echo "pr_url=${PR_URL:-}"
  echo "prep_branch=$(git branch --show-current)"
  echo "prep_head_sha=$prep_head_sha"
  echo "pr_head_sha=$pr_head_sha_after"
  echo "artifacts=.local/prep.md .local/prep.env"
}

prepare_sync_head() {
  local pr="$1"
  enter_worktree "$pr" false

  require_artifact .local/pr-meta.env
  require_artifact .local/prep-context.env

  mark_pr_operation_side_effects_started
  checkout_prep_branch "$pr"

  # shellcheck disable=SC1091
  source .local/pr-meta.env
  # shellcheck disable=SC1091
  source .local/prep-context.env

  # merge-verify owns relevance-aware mainline drift. Keep the hosted PR head
  # as the publication parent so fork updates contain only reviewed fixups.
  git fetch origin main

  local prep_head_sha
  prep_head_sha=$(git rev-parse HEAD)
  local local_prep_head_sha

  local lease_sha
  lease_sha=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
  verify_prep_head_extends_hosted_head "$lease_sha" || exit 1
  local push_result_env=".local/prepare-sync-result.env"

  verify_pr_head_branch_matches_expected "$pr" "$PR_HEAD"
  push_prep_head_to_pr_branch "$pr" "$PR_HEAD" "$prep_head_sha" "$lease_sha" false false "$push_result_env"
  # shellcheck disable=SC1090
  source "$push_result_env"
  prep_head_sha="$PUSH_PREP_HEAD_SHA"
  local_prep_head_sha="$PUSH_LOCAL_PREP_HEAD_SHA"
  local mainline_base_sha
  mainline_base_sha=$(git merge-base "$local_prep_head_sha" origin/main) || {
    echo "Unable to resolve the prepared mainline base."
    exit 1
  }
  local pushed_from_sha="$PUSHED_FROM_SHA"
  local pr_head_sha_after="$PR_HEAD_SHA_AFTER_PUSH"

  local contrib="${PR_AUTHOR:-}"
  if [ -z "$contrib" ]; then
    contrib=$(gh pr view "$pr" --json author --jq .author.login)
  fi
  local coauthor_email=""
  if coauthor_email=$(resolve_contributor_coauthor_email "$contrib"); then
    :
  else
    coauthor_email=""
  fi

  cat >> .local/prep.md <<EOF_PREP
- Prep head sync completed to branch $PR_HEAD.
- Preserved hosted PR ancestry; merge verification owns mainline drift.
- Verified the remote PR head tree matches the local prep head.
EOF_PREP

  # Security: shell-escape values to prevent command injection via propagated PR_HEAD.
  printf '%s=%q\n' \
    PR_NUMBER "$PR_NUMBER" \
    PR_AUTHOR "$contrib" \
    PR_URL "${PR_URL:-}" \
    PR_HEAD "$PR_HEAD" \
    PR_HEAD_SHA_BEFORE "$pushed_from_sha" \
    PREP_HEAD_SHA "$prep_head_sha" \
    LOCAL_PREP_HEAD_SHA "$local_prep_head_sha" \
    PREP_MAINLINE_BASE_SHA "$mainline_base_sha" \
    COAUTHOR_EMAIL "$coauthor_email" \
    > .local/prep.env

  ls -la .local/prep.md .local/prep.env >/dev/null

  echo "prepare-sync-head complete"
  echo "pr_url=${PR_URL:-}"
  echo "prep_branch=$(git branch --show-current)"
  echo "prep_head_sha=$prep_head_sha"
  echo "pr_head_sha=$pr_head_sha_after"
  echo "artifacts=.local/prep.md .local/prep.env"
}

prepare_run() {
  local pr="$1"
  prepare_init "$pr"
  prepare_gates "$pr"
  prepare_push "$pr"
  echo "prepare-run complete for PR #$pr"
  echo "pr_url=${PR_URL:-}"
}
