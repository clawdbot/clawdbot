set_review_mode() {
  local mode="$1"
  # Security: shell-escape values to prevent command injection when sourced.
  printf '%s=%q\n' \
    REVIEW_MODE "$mode" \
    REVIEW_MODE_SET_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > .local/review-mode.env
}

review_artifacts_helper_path() {
  local scripts_dir="${script_parent_dir:-}"
  if [ -z "$scripts_dir" ]; then
    scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  fi
  printf '%s/pr-lib/review-artifacts.mjs\n' "$scripts_dir"
}

review_claim() {
  local pr="$1"
  mark_pr_operation_side_effects_started
  local root
  root=$(repo_root)
  cd "$root"
  mkdir -p .local

  local reviewer=""
  local max_attempts=3
  local attempt

  for attempt in $(seq 1 "$max_attempts"); do
    local user_log
    user_log=".local/review-claim-user-attempt-$attempt.log"

    if reviewer=$(gh api user --jq .login 2>"$user_log"); then
      printf "%s\n" "$reviewer" >"$user_log"
      break
    fi

    echo "Claim reviewer lookup failed (attempt $attempt/$max_attempts)."
    print_relevant_log_excerpt "$user_log"

    if [ "$attempt" -lt "$max_attempts" ]; then
      sleep 2
    fi
  done

  if [ -z "$reviewer" ]; then
    echo "Failed to resolve reviewer login after $max_attempts attempts."
    return 1
  fi

  for attempt in $(seq 1 "$max_attempts"); do
    local claim_log
    claim_log=".local/review-claim-assignee-attempt-$attempt.log"

    if gh pr edit "$pr" --add-assignee "$reviewer" >"$claim_log" 2>&1; then
      echo "review claim succeeded: @$reviewer assigned to PR #$pr"
      return 0
    fi

    echo "Claim assignee update failed (attempt $attempt/$max_attempts)."
    print_relevant_log_excerpt "$claim_log"

    if [ "$attempt" -lt "$max_attempts" ]; then
      sleep 2
    fi
  done

  echo "Failed to assign @$reviewer to PR #$pr after $max_attempts attempts."
  return 1
}

review_checkout_main() {
  local pr="$1"
  enter_worktree "$pr" false
  mark_pr_operation_side_effects_started
  git fetch origin main
  git checkout --detach origin/main
  set_review_mode main

  echo "review mode set to main baseline"
  echo "branch=$(git branch --show-current)"
  echo "head=$(git rev-parse --short HEAD)"
}

review_checkout_pr() {
  local pr="$1"
  enter_worktree "$pr" false
  mark_pr_operation_side_effects_started
  git fetch origin "pull/$pr/head:pr-$pr" --force
  git checkout --detach "pr-$pr"
  set_review_mode pr

  echo "review mode set to PR head"
  echo "branch=$(git branch --show-current)"
  echo "head=$(git rev-parse --short HEAD)"
}

review_guard() {
  local pr="$1"
  enter_worktree "$pr" false
  require_artifact .local/review-mode.env
  require_artifact .local/pr-meta.env

  # shellcheck disable=SC1091
  source .local/review-mode.env
  # shellcheck disable=SC1091
  source .local/pr-meta.env

  local branch
  branch=$(git branch --show-current)
  local head_sha
  head_sha=$(git rev-parse HEAD)

  case "${REVIEW_MODE:-}" in
    main)
      local expected_main_sha
      expected_main_sha=$(git rev-parse origin/main)
      if [ "$head_sha" != "$expected_main_sha" ]; then
        echo "Review guard failed: expected HEAD at origin/main ($expected_main_sha) for main baseline mode, got $head_sha"
        exit 1
      fi
      ;;
    pr)
      if [ -z "${PR_HEAD_SHA:-}" ]; then
        echo "Review guard failed: missing PR_HEAD_SHA in .local/pr-meta.env"
        exit 1
      fi
      if [ "$head_sha" != "$PR_HEAD_SHA" ]; then
        echo "Review guard failed: expected HEAD at PR_HEAD_SHA ($PR_HEAD_SHA), got $head_sha"
        exit 1
      fi
      ;;
    *)
      echo "Review guard failed: unknown review mode '${REVIEW_MODE:-}'"
      exit 1
      ;;
  esac

  echo "review guard passed"
  echo "mode=$REVIEW_MODE"
  echo "branch=$branch"
  echo "head=$head_sha"
}

review_artifacts_init() {
  local pr="$1"
  enter_worktree "$pr" false
  require_artifact .local/pr-meta.env

  mark_pr_operation_side_effects_started

  if [ ! -f .local/review.md ]; then
    cat > .local/review.md <<'EOF_MD'
A) TL;DR recommendation

B) What changed and what is good?

C) Security findings

D) What is the PR intent? Is this the most optimal implementation?

E) Concerns or questions (actionable)

F) Tests

G) Docs status

H) Changelog

I) Follow ups (optional)

J) Suggested PR comment (optional)
EOF_MD
  fi

  if [ ! -f .local/review.json ]; then
    node "$(review_artifacts_helper_path)" template > .local/review.json
  fi

  echo "review artifact templates are ready"
  echo "files=.local/review.md .local/review.json"
}

review_validate_artifacts() {
  local pr="$1"
  enter_worktree "$pr" false
  require_artifact .local/review.md
  require_artifact .local/review.json
  require_artifact .local/pr-meta.env
  require_artifact .local/pr-meta.json

  review_guard "$pr"

  if ! node "$(review_artifacts_helper_path)" validate \
    .local/review.json \
    .local/review.md \
    .local/pr-meta.json
  then
    return 1
  fi

  echo "review artifacts validated"
  print_review_stdout_summary
}

review_tests() {
  local pr="$1"
  shift
  if [ "$#" -lt 1 ]; then
    echo "Usage: scripts/pr review-tests <PR> <test-file> [<test-file> ...]"
    exit 2
  fi

  enter_worktree "$pr" false
  review_guard "$pr"

  local target
  for target in "$@"; do
    if [ ! -f "$target" ]; then
      echo "Missing test target file: $target"
      exit 1
    fi
  done

  mark_pr_operation_side_effects_started
  bootstrap_deps_if_needed

  local run_log=".local/review-tests-run.log"
  run_quiet_logged "pnpm test" "$run_log" pnpm test -- "$@"

  local missing_run=()
  for target in "$@"; do
    local base
    base=$(basename "$target")
    if ! rg -F -q "$target" "$run_log" && ! rg -F -q "$base" "$run_log"; then
      missing_run+=("$target")
    fi
  done

  if [ "${#missing_run[@]}" -gt 0 ]; then
    echo "These requested targets were not observed in vitest run output:"
    printf ' - %s\n' "${missing_run[@]}"
    exit 1
  fi

  # Security: shell-escape values to prevent command injection when sourced.
  printf '%s=%q\n' \
    REVIEW_TESTS_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    REVIEW_TEST_TARGET_COUNT "$#" \
    > .local/review-tests.env

  echo "review tests passed and were observed in output"
}

review_init() {
  local pr="$1"
  mark_pr_operation_side_effects_started
  enter_worktree "$pr" true

  local json pr_url
  json=$(pr_meta_json "$pr")
  write_pr_meta_files "$json"
  pr_url=$(printf '%s\n' "$json" | jq -r .url)

  git fetch origin "pull/$pr/head:pr-$pr" --force
  local mb
  mb=$(git merge-base origin/main "pr-$pr")

  # Security: shell-escape values to prevent command injection when sourced.
  printf '%s=%q\n' \
    PR_NUMBER "$pr" \
    MERGE_BASE "$mb" \
    REVIEW_STARTED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > .local/review-context.env
  set_review_mode main

  printf '%s\n' "$json" | jq '{number,title,url,state,isDraft,author:.author.login,base:.baseRefName,head:.headRefName,headSha:.headRefOid,headRepo:.headRepository.nameWithOwner,additions,deletions,files:.changedFiles}'
  echo "worktree=$PWD"
  echo "pr_url=$pr_url"
  echo "merge_base=$mb"
  echo "branch=$(git branch --show-current)"
  echo "wrote=.local/pr-meta.json .local/pr-meta.env .local/review-context.env .local/review-mode.env"
  cat <<EOF_GUIDE
Review guidance:
- Inspect main baseline: scripts/pr review-checkout-main $pr
- Inspect PR head:      scripts/pr review-checkout-pr $pr
- Guard before writeout: scripts/pr review-guard $pr
EOF_GUIDE
}
