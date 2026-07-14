set_review_mode() {
  local mode="$1"
  # Security: shell-escape values to prevent command injection when sourced.
  printf '%s=%q\n' \
    REVIEW_MODE "$mode" \
    REVIEW_MODE_SET_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > .local/review-mode.env
}

review_claim() {
  local pr="$1"
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
    cat > .local/review.json <<'EOF_JSON'
{
  "recommendation": "NEEDS WORK",
  "findings": [],
  "nitSweep": {
    "performed": true,
    "status": "none",
    "summary": "No optional nits identified."
  },
  "behavioralSweep": {
    "performed": true,
    "status": "not_applicable",
    "summary": "No runtime branch-level behavior changes require sweep evidence.",
    "silentDropRisk": "none",
    "branches": []
  },
  "issueValidation": {
    "performed": true,
    "source": "pr_body",
    "status": "unclear",
    "summary": "Review not completed yet."
  },
  "tests": {
    "ran": [],
    "gaps": [],
    "result": "pass"
  },
  "docs": "not_applicable",
  "changelog": "not_required"
}
EOF_JSON
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

  jq . .local/review.json >/dev/null

  local section
  for section in "A)" "B)" "C)" "D)" "E)" "F)" "G)" "H)" "I)" "J)"; do
    awk -v s="$section" 'index($0, s) == 1 { found=1; exit } END { exit(found ? 0 : 1) }' .local/review.md || {
      echo "Missing section header in .local/review.md: $section"
      exit 1
    }
  done

  local recommendation
  recommendation=$(jq -r '.recommendation // ""' .local/review.json)
  case "$recommendation" in
    "READY FOR /prepare-pr"|"NEEDS WORK"|"NEEDS DISCUSSION"|"NOT USEFUL (CLOSE)")
      ;;
    *)
      echo "Invalid recommendation in .local/review.json: $recommendation"
      exit 1
      ;;
  esac

  local invalid_severity_count
  invalid_severity_count=$(jq '[.findings[]? | select((.severity // "") != "BLOCKER" and (.severity // "") != "IMPORTANT" and (.severity // "") != "NIT")] | length' .local/review.json)
  if [ "$invalid_severity_count" -gt 0 ]; then
    echo "Invalid finding severity in .local/review.json"
    exit 1
  fi

  local invalid_findings_count
  invalid_findings_count=$(jq '[.findings[]? | select((.id|type)!="string" or (.title|type)!="string" or (.area|type)!="string" or (.fix|type)!="string")] | length' .local/review.json)
  if [ "$invalid_findings_count" -gt 0 ]; then
    echo "Invalid finding shape in .local/review.json (id/title/area/fix must be strings)"
    exit 1
  fi

  local nit_findings_count
  nit_findings_count=$(jq '[.findings[]? | select((.severity // "") == "NIT")] | length' .local/review.json)

  local nit_sweep_performed
  nit_sweep_performed=$(jq -r '.nitSweep.performed // empty' .local/review.json)
  if [ "$nit_sweep_performed" != "true" ]; then
    echo "Invalid nit sweep in .local/review.json: nitSweep.performed must be true"
    exit 1
  fi

  local nit_sweep_status
  nit_sweep_status=$(jq -r '.nitSweep.status // ""' .local/review.json)
  case "$nit_sweep_status" in
    "none")
      if [ "$nit_findings_count" -gt 0 ]; then
        echo "Invalid nit sweep in .local/review.json: nitSweep.status is none but NIT findings exist"
        exit 1
      fi
      ;;
    "has_nits")
      if [ "$nit_findings_count" -lt 1 ]; then
        echo "Invalid nit sweep in .local/review.json: nitSweep.status is has_nits but no NIT findings exist"
        exit 1
      fi
      ;;
    *)
      echo "Invalid nit sweep status in .local/review.json: $nit_sweep_status"
      exit 1
      ;;
  esac

  local invalid_nit_summary_count
  invalid_nit_summary_count=$(jq '[.nitSweep.summary | select((type != "string") or (gsub("^\\s+|\\s+$";"") | length == 0))] | length' .local/review.json)
  if [ "$invalid_nit_summary_count" -gt 0 ]; then
    echo "Invalid nit sweep summary in .local/review.json: nitSweep.summary must be a non-empty string"
    exit 1
  fi

  local issue_validation_performed
  issue_validation_performed=$(jq -r '.issueValidation.performed // empty' .local/review.json)
  if [ "$issue_validation_performed" != "true" ]; then
    echo "Invalid issue validation in .local/review.json: issueValidation.performed must be true"
    exit 1
  fi

  local issue_validation_source
  issue_validation_source=$(jq -r '.issueValidation.source // ""' .local/review.json)
  case "$issue_validation_source" in
    "linked_issue"|"pr_body"|"both")
      ;;
    *)
      echo "Invalid issue validation source in .local/review.json: $issue_validation_source"
      exit 1
      ;;
  esac

  local issue_validation_status
  issue_validation_status=$(jq -r '.issueValidation.status // ""' .local/review.json)
  case "$issue_validation_status" in
    "valid"|"unclear"|"invalid"|"already_fixed_on_main")
      ;;
    *)
      echo "Invalid issue validation status in .local/review.json: $issue_validation_status"
      exit 1
      ;;
  esac

  local invalid_issue_summary_count
  invalid_issue_summary_count=$(jq '[.issueValidation.summary | select((type != "string") or (gsub("^\\s+|\\s+$";"") | length == 0))] | length' .local/review.json)
  if [ "$invalid_issue_summary_count" -gt 0 ]; then
    echo "Invalid issue validation summary in .local/review.json: issueValidation.summary must be a non-empty string"
    exit 1
  fi

  local runtime_file_count
  runtime_file_count=$(jq '[.files[]? | (.path // "") | select(test("^(src|extensions|apps)/")) | select(test("(^|/)__tests__/|\\.test\\.|\\.spec\\.") | not) | select(test("\\.(md|mdx)$") | not)] | length' .local/pr-meta.json)

  local runtime_review_required="false"
  if [ "$runtime_file_count" -gt 0 ]; then
    runtime_review_required="true"
  fi

  local behavioral_sweep_performed
  behavioral_sweep_performed=$(jq -r '.behavioralSweep.performed // empty' .local/review.json)
  if [ "$behavioral_sweep_performed" != "true" ]; then
    echo "Invalid behavioral sweep in .local/review.json: behavioralSweep.performed must be true"
    exit 1
  fi

  local behavioral_sweep_status
  behavioral_sweep_status=$(jq -r '.behavioralSweep.status // ""' .local/review.json)
  case "$behavioral_sweep_status" in
    "pass"|"needs_work"|"not_applicable")
      ;;
    *)
      echo "Invalid behavioral sweep status in .local/review.json: $behavioral_sweep_status"
      exit 1
      ;;
  esac

  local behavioral_sweep_risk
  behavioral_sweep_risk=$(jq -r '.behavioralSweep.silentDropRisk // ""' .local/review.json)
  case "$behavioral_sweep_risk" in
    "none"|"present"|"unknown")
      ;;
    *)
      echo "Invalid behavioral sweep risk in .local/review.json: $behavioral_sweep_risk"
      exit 1
      ;;
  esac

  local invalid_behavioral_summary_count
  invalid_behavioral_summary_count=$(jq '[.behavioralSweep.summary | select((type != "string") or (gsub("^\\s+|\\s+$";"") | length == 0))] | length' .local/review.json)
  if [ "$invalid_behavioral_summary_count" -gt 0 ]; then
    echo "Invalid behavioral sweep summary in .local/review.json: behavioralSweep.summary must be a non-empty string"
    exit 1
  fi

  local behavioral_branches_is_array
  behavioral_branches_is_array=$(jq -r 'if (.behavioralSweep.branches | type) == "array" then "true" else "false" end' .local/review.json)
  if [ "$behavioral_branches_is_array" != "true" ]; then
    echo "Invalid behavioral sweep in .local/review.json: behavioralSweep.branches must be an array"
    exit 1
  fi

  local invalid_behavioral_branch_count
  invalid_behavioral_branch_count=$(jq '[.behavioralSweep.branches[]? | select((.path|type)!="string" or (.decision|type)!="string" or (.outcome|type)!="string")] | length' .local/review.json)
  if [ "$invalid_behavioral_branch_count" -gt 0 ]; then
    echo "Invalid behavioral sweep branch entry in .local/review.json: each branch needs string path/decision/outcome"
    exit 1
  fi

  local behavioral_branch_count
  behavioral_branch_count=$(jq '[.behavioralSweep.branches[]?] | length' .local/review.json)

  if [ "$runtime_review_required" = "true" ] && [ "$behavioral_sweep_status" = "not_applicable" ]; then
    echo "Invalid behavioral sweep in .local/review.json: runtime file changes require behavioralSweep.status=pass|needs_work"
    exit 1
  fi

  if [ "$runtime_review_required" = "true" ] && [ "$behavioral_branch_count" -lt 1 ]; then
    echo "Invalid behavioral sweep in .local/review.json: runtime file changes require at least one branch entry"
    exit 1
  fi

  if [ "$behavioral_sweep_status" = "not_applicable" ] && [ "$behavioral_branch_count" -gt 0 ]; then
    echo "Invalid behavioral sweep in .local/review.json: not_applicable cannot include branch entries"
    exit 1
  fi

  if [ "$behavioral_sweep_status" = "pass" ] && [ "$behavioral_sweep_risk" != "none" ]; then
    echo "Invalid behavioral sweep in .local/review.json: status=pass requires silentDropRisk=none"
    exit 1
  fi

  if [ "$recommendation" = "READY FOR /prepare-pr" ] && [ "$issue_validation_status" != "valid" ]; then
    echo "Invalid recommendation in .local/review.json: READY FOR /prepare-pr requires issueValidation.status=valid"
    exit 1
  fi

  if [ "$recommendation" = "READY FOR /prepare-pr" ] && [ "$behavioral_sweep_status" = "needs_work" ]; then
    echo "Invalid recommendation in .local/review.json: READY FOR /prepare-pr requires behavioralSweep.status!=needs_work"
    exit 1
  fi

  if [ "$recommendation" = "READY FOR /prepare-pr" ] && [ "$runtime_review_required" = "true" ] && [ "$behavioral_sweep_status" != "pass" ]; then
    echo "Invalid recommendation in .local/review.json: READY FOR /prepare-pr on runtime changes requires behavioralSweep.status=pass"
    exit 1
  fi

  if [ "$recommendation" = "READY FOR /prepare-pr" ] && [ "$behavioral_sweep_risk" = "present" ]; then
    echo "Invalid recommendation in .local/review.json: READY FOR /prepare-pr is not allowed when behavioralSweep.silentDropRisk=present"
    exit 1
  fi

  local docs_status
  docs_status=$(jq -r '.docs // ""' .local/review.json)
  case "$docs_status" in
    "up_to_date"|"missing"|"not_applicable")
      ;;
    *)
      echo "Invalid docs status in .local/review.json: $docs_status"
      exit 1
      ;;
  esac

  local changelog_status
  changelog_status=$(jq -r '.changelog // ""' .local/review.json)
  case "$changelog_status" in
    "required"|"not_required")
      ;;
    *)
      echo "Invalid changelog status in .local/review.json: $changelog_status (must be \"required\" or \"not_required\")"
      exit 1
      ;;
  esac

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
