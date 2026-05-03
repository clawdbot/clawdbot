checkout_prep_branch() {
  local pr="$1"
  require_artifact .local/prep-context.env
  # shellcheck disable=SC1091
  source .local/prep-context.env

  local prep_branch
  prep_branch=$(resolve_prep_branch_name "$pr")
  git checkout "$prep_branch"
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
  enter_worktree "$pr" true

  require_artifact .local/pr-meta.env
  require_artifact .local/review.md

  if [ ! -s .local/review.json ]; then
    echo "WARNING: .local/review.json is missing; structured findings are expected."
  fi

  # shellcheck disable=SC1091
  source .local/pr-meta.env

  local json
  json=$(pr_meta_json "$pr")

  local head
  head=$(printf '%s\n' "$json" | jq -r .headRefName)
  local pr_head_sha_before
  pr_head_sha_before=$(printf '%s\n' "$json" | jq -r .headRefOid)

  if [ -n "${PR_HEAD:-}" ] && [ "$head" != "$PR_HEAD" ]; then
    echo "PR head branch changed from $PR_HEAD to $head. Re-run review-pr."
    exit 1
  fi

  git fetch origin "pull/$pr/head:pr-$pr" --force
  git checkout -B "pr-$pr-prep" "pr-$pr"
  git fetch origin main

  # Security: shell-escape values to prevent command injection via malicious branch names.
  printf '%s=%q\n' \
    PR_NUMBER "$pr" \
    PR_HEAD "$head" \
    PR_HEAD_SHA_BEFORE "$pr_head_sha_before" \
    PREP_BRANCH "pr-$pr-prep" \
    PREP_STARTED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > .local/prep-context.env

  if [ ! -f .local/prep.md ]; then
    cat > .local/prep.md <<EOF_PREP
# PR $pr prepare log

- Initialized prepare context from the PR head branch without rebasing on origin/main.
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
  require_artifact .local/gates.env

  checkout_prep_branch "$pr"

  # shellcheck disable=SC1091
  source .local/pr-meta.env
  # shellcheck disable=SC1091
  source .local/prep-context.env
  # shellcheck disable=SC1091
  source .local/gates.env

  local prep_head_sha
  prep_head_sha=$(git rev-parse HEAD)

  local lease_sha
  lease_sha=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
  local push_result_env=".local/prepare-push-result.env"

  verify_pr_head_branch_matches_expected "$pr" "$PR_HEAD"
  push_prep_head_to_pr_branch "$pr" "$PR_HEAD" "$prep_head_sha" "$lease_sha" true "${DOCS_ONLY:-false}" "$push_result_env"
  # shellcheck disable=SC1090
  source "$push_result_env"
  prep_head_sha="$PUSH_PREP_HEAD_SHA"
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
- Verified PR head SHA matches local prep HEAD.
- Verified PR head contains origin/main.
EOF_PREP

  # Security: shell-escape values to prevent command injection via propagated PR_HEAD.
  printf '%s=%q\n' \
    PR_NUMBER "$PR_NUMBER" \
    PR_AUTHOR "$contrib" \
    PR_URL "${PR_URL:-}" \
    PR_HEAD "$PR_HEAD" \
    PR_HEAD_SHA_BEFORE "$pushed_from_sha" \
    PREP_HEAD_SHA "$prep_head_sha" \
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

  checkout_prep_branch "$pr"

  # shellcheck disable=SC1091
  source .local/pr-meta.env
  # shellcheck disable=SC1091
  source .local/prep-context.env

  local rebased=false
  git fetch origin main
  if ! git merge-base --is-ancestor origin/main HEAD; then
    git rebase origin/main
    rebased=true
    prepare_gates "$pr"
    checkout_prep_branch "$pr"
  fi

  local prep_head_sha
  prep_head_sha=$(git rev-parse HEAD)

  local lease_sha
  lease_sha=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
  local push_result_env=".local/prepare-sync-result.env"

  verify_pr_head_branch_matches_expected "$pr" "$PR_HEAD"
  push_prep_head_to_pr_branch "$pr" "$PR_HEAD" "$prep_head_sha" "$lease_sha" false false "$push_result_env"
  # shellcheck disable=SC1090
  source "$push_result_env"
  prep_head_sha="$PUSH_PREP_HEAD_SHA"
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
- Rebased onto origin/main: $rebased.
- Verified PR head SHA matches local prep HEAD.
- Verified PR head contains origin/main.
- Prepare gates reran automatically when the sync rebase changed the prep head.
EOF_PREP

  # Security: shell-escape values to prevent command injection via propagated PR_HEAD.
  printf '%s=%q\n' \
    PR_NUMBER "$PR_NUMBER" \
    PR_AUTHOR "$contrib" \
    PR_URL "${PR_URL:-}" \
    PR_HEAD "$PR_HEAD" \
    PR_HEAD_SHA_BEFORE "$pushed_from_sha" \
    PREP_HEAD_SHA "$prep_head_sha" \
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
