run_hosted_prepare_gates() {
  local pr="$1"
  local current_head="$2"
  local changelog_only="$3"
  local recent_sha=""
  local remote_head
  remote_head=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
  if [ "$remote_head" != "$current_head" ]; then
    echo "PR head changed before hosted gate verification (expected $current_head, got $remote_head). Re-run prepare-init."
    return 1
  fi
  # A docs-only final commit may reuse its immutable parent; this covers
  # release-owned cleanup without inferring PR identity from mutable branches.
  if [ -z "$recent_sha" ]; then
    local parent_sha
    local parent_delta
    if parent_sha=$(git rev-parse "${current_head}^" 2>/dev/null) &&
      parent_delta=$(git diff --name-only "$parent_sha" "$current_head" 2>/dev/null) &&
      file_list_is_docsish_only "$parent_delta"; then
      recent_sha="$parent_sha"
    fi
  fi

  local repo
  repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
  local scripts_dir="${script_parent_dir:-}"
  if [ -z "$scripts_dir" ]; then
    scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  fi
  local args=(
    "$scripts_dir/verify-pr-hosted-gates.mjs"
    --repo "$repo"
    --sha "$current_head"
    --pr "$pr"
    --output ".local/gates-hosted-checks.json"
  )
  if [ -n "$recent_sha" ]; then
    args+=(--recent-sha "$recent_sha")
  fi
  if [ "$changelog_only" = "true" ]; then
    args+=(--changelog-only)
  fi
  run_quiet_logged "hosted CI/Testbox gates" ".local/gates-hosted-checks.log" node "${args[@]}"
}

pin_worktree_bundled_plugins_dir() {
  # Nested .worktrees/<pr> checkouts resolve vitest tooling from the primary
  # checkout's node_modules; pin bundled plugin discovery to this worktree so
  # PR branches without the openclaw-root node_modules-boundary fix still test
  # their own extensions instead of the primary checkout's stale trees.
  export OPENCLAW_BUNDLED_PLUGINS_DIR="${OPENCLAW_BUNDLED_PLUGINS_DIR:-$PWD/extensions}"
}

resolve_pr_gates_remote_mode() {
  case "${OPENCLAW_PR_GATES_REMOTE:-}" in
    "")
      printf 'local\n'
      ;;
    testbox)
      printf 'testbox\n'
      ;;
    *)
      echo "Unsupported OPENCLAW_PR_GATES_REMOTE=${OPENCLAW_PR_GATES_REMOTE} (supported: testbox)." >&2
      return 1
      ;;
  esac
}

PR_GATES_LOCK_PID=""
PR_GATES_LOCK_STATUS_FILE=""

acquire_pr_gates_lock() {
  # Serialize whole gate blocks across .worktrees on the shared heavy-check
  # lock; a queued gate run waits here, before its first command, instead of
  # dying on child lock timeouts or shard no-output watchdog kills mid-test.
  if [ "${OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD:-}" = "1" ]; then
    return 0
  fi

  PR_GATES_LOCK_STATUS_FILE=$(mktemp)
  # Use the canonical helper: the PR branch under test may predate it.
  local scripts_dir="${script_parent_dir:-}"
  if [ -z "$scripts_dir" ]; then
    scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  fi
  node "$scripts_dir/pr-gates-lock.mjs" --status-file "$PR_GATES_LOCK_STATUS_FILE" &
  PR_GATES_LOCK_PID=$!
  while [ ! -s "$PR_GATES_LOCK_STATUS_FILE" ]; do
    if ! kill -0 "$PR_GATES_LOCK_PID" 2>/dev/null; then
      wait "$PR_GATES_LOCK_PID" 2>/dev/null || true
      PR_GATES_LOCK_PID=""
      echo "Failed to acquire the shared local heavy-check lock for prepare gates."
      exit 1
    fi
    sleep 0.2
  done
  # Same held-lock contract check-changed uses for its children: gate stages
  # must not re-acquire the lock the block holder already owns.
  export OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD=1
  export OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD=1
  export OPENCLAW_OXLINT_SKIP_LOCK=1
}

prepare_local_gate_workspace() {
  pin_worktree_bundled_plugins_dir
  acquire_pr_gates_lock
  bootstrap_deps_if_needed
}

release_pr_gates_lock() {
  if [ -z "${PR_GATES_LOCK_PID:-}" ]; then
    return 0
  fi
  kill "$PR_GATES_LOCK_PID" 2>/dev/null || true
  wait "$PR_GATES_LOCK_PID" 2>/dev/null || true
  PR_GATES_LOCK_PID=""
  rm -f "$PR_GATES_LOCK_STATUS_FILE"
  PR_GATES_LOCK_STATUS_FILE=""
  unset OPENCLAW_TEST_HEAVY_CHECK_LOCK_HELD OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD OPENCLAW_OXLINT_SKIP_LOCK
}

run_remote_testbox_full_test_gate() {
  local label="$1"
  local log_file="$2"
  local lease_label="$3"
  # Same Blacksmith Testbox delegation shape check:changed uses; the worktree's
  # own wrapper syncs this prep tree (the canonical copy would sync the primary
  # checkout instead).
  run_quiet_logged "$label" "$log_file" \
    node scripts/crabbox-wrapper.mjs run \
    --provider blacksmith-testbox \
    --blacksmith-org openclaw \
    --blacksmith-workflow .github/workflows/ci-check-testbox.yml \
    --blacksmith-job check \
    --blacksmith-ref main \
    --idle-timeout 90m \
    --ttl 240m \
    --timing-json \
    --label "$lease_label" \
    -- env CI=1 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=install corepack pnpm test
}

read_remote_testbox_gate_stamp() {
  # crabbox --timing-json emits one single-line JSON report on stderr; pick the
  # last successful blacksmith-testbox report in the gate log as the stamp.
  local log_file="$1"
  jq -c -R '
    fromjson?
    | select(type == "object")
    | select(.provider == "blacksmith-testbox" and .exitCode == 0 and ((.leaseId // "") | startswith("tbx_")))
  ' "$log_file" | tail -n 1
}

read_remote_testbox_gate_run_url() {
  # The delegated timing report currently omits actionsRunUrl, while the same
  # run prints the canonical Actions URL as a separate line.
  local log_file="$1"
  local pr_url="${PR_URL:-}"
  local expected_repo="${pr_url#https://github.com/}"
  expected_repo="${expected_repo%%/pull/*}"
  if [ -z "$expected_repo" ] || [ "$expected_repo" = "$pr_url" ]; then
    expected_repo="openclaw/openclaw"
  fi
  local url_prefix="https://github.com/$expected_repo/actions/runs/"
  local marker="GitHub Actions run: $url_prefix"
  awk -v marker="$marker" -v url_prefix="$url_prefix" '
    index($0, marker) {
      suffix = substr($0, index($0, marker) + length(marker))
      if (match(suffix, /^[0-9]+/)) {
        print url_prefix substr(suffix, RSTART, RLENGTH)
        exit
      }
    }
  ' "$log_file"
}

require_remote_testbox_gate_stamp() {
  # Runs inside $(...): report to stderr and fail the substitution so set -e
  # aborts the caller with the message visible.
  local log_file="$1"
  local stamp
  stamp=$(read_remote_testbox_gate_stamp "$log_file")
  if [ -z "$stamp" ]; then
    echo "Remote testbox gate passed but no successful blacksmith-testbox timing stamp was found in $log_file." >&2
    return 1
  fi
  local actions_run_url
  actions_run_url=$(read_remote_testbox_gate_run_url "$log_file")
  if [ -n "$actions_run_url" ] && [ "$(printf '%s\n' "$stamp" | jq -r '.actionsRunUrl // empty')" = "" ]; then
    stamp=$(printf '%s\n' "$stamp" | jq -c --arg actionsRunUrl "$actions_run_url" '. + {actionsRunUrl: $actionsRunUrl}')
  fi
  printf '%s\n' "$stamp"
}

write_gates_env_stamp() {
  local pr="$1"
  local docs_only="$2"
  local changelog_required="$3"
  local gates_mode="$4"
  local last_verified_head="$5"
  local full_gates_head="$6"
  local hosted_gates_head="$7"
  local remote_provider="$8"
  local remote_lease_id="$9"
  local remote_run_url="${10}"

  # Security: shell-escape values to prevent command injection when sourced.
  printf '%s=%q\n' \
    PR_NUMBER "$pr" \
    DOCS_ONLY "$docs_only" \
    CHANGELOG_REQUIRED "$changelog_required" \
    GATES_MODE "$gates_mode" \
    LAST_VERIFIED_HEAD_SHA "$last_verified_head" \
    FULL_GATES_HEAD_SHA "$full_gates_head" \
    HOSTED_GATES_TARGET_HEAD_SHA "$hosted_gates_head" \
    REMOTE_GATES_PROVIDER "$remote_provider" \
    REMOTE_GATES_LEASE_ID "$remote_lease_id" \
    REMOTE_GATES_RUN_URL "$remote_run_url" \
    GATES_PASSED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > .local/gates.env
}

derive_prepare_gate_change_plan() {
  PREPARE_GATE_CHANGED_FILES=$(git diff --name-only origin/main...HEAD)
  PREPARE_GATE_DOCS_ONLY=false
  if file_list_is_docsish_only "$PREPARE_GATE_CHANGED_FILES"; then
    PREPARE_GATE_DOCS_ONLY=true
  fi
  PREPARE_GATE_CHANGELOG_ONLY=false
  if [ "$PREPARE_GATE_CHANGED_FILES" = "CHANGELOG.md" ]; then
    PREPARE_GATE_CHANGELOG_ONLY=true
  fi
  PREPARE_GATE_CHANGELOG_REQUIRED=false
  if changelog_required_for_changed_files "$PREPARE_GATE_CHANGED_FILES"; then
    PREPARE_GATE_CHANGELOG_REQUIRED=true
  fi
}

run_prepare_push_retry_gates() {
  local docs_only="${1:-false}"

  if [ "${OPENCLAW_TESTBOX:-}" = "1" ]; then
    echo "A lease retry changed the prepared head after gate selection."
    echo "Stop here, wait for hosted evidence on the pushed branch, then re-run prepare-run."
    return 1
  fi

  local gates_remote_mode
  gates_remote_mode=$(resolve_pr_gates_remote_mode)

  prepare_local_gate_workspace
  run_quiet_logged "pnpm build (lease-retry)" ".local/lease-retry-build.log" pnpm build
  run_quiet_logged "pnpm check (lease-retry)" ".local/lease-retry-check.log" pnpm check

  # The retry rebased the prep head, so the pre-push gates.env stamp no longer
  # describes what these gates just verified; rewrite it for the new head so
  # prep.md and prep.env do not attribute stale evidence to the pushed commit.
  local retry_head
  retry_head=$(git rev-parse HEAD)
  local gates_mode="full"
  local full_gates_head="$retry_head"
  local remote_gates_provider=""
  local remote_gates_lease_id=""
  local remote_gates_run_url=""

  if [ "$docs_only" = "true" ]; then
    release_pr_gates_lock
    gates_mode="docs_only"
    # No test ran: carry the prior full-gates proof and how it was produced.
    full_gates_head="${FULL_GATES_HEAD_SHA:-}"
    remote_gates_provider="${REMOTE_GATES_PROVIDER:-}"
    remote_gates_lease_id="${REMOTE_GATES_LEASE_ID:-}"
    remote_gates_run_url="${REMOTE_GATES_RUN_URL:-}"
  elif [ "$gates_remote_mode" = "testbox" ]; then
    release_pr_gates_lock
    gates_mode="remote_testbox"
    run_remote_testbox_full_test_gate \
      "pnpm test (lease-retry, blacksmith-testbox)" \
      ".local/lease-retry-test.log" \
      "pr-${PR_NUMBER:-unknown}-gates-lease-retry"
    local retry_stamp
    retry_stamp=$(require_remote_testbox_gate_stamp ".local/lease-retry-test.log")
    remote_gates_provider="blacksmith-testbox"
    remote_gates_lease_id=$(printf '%s\n' "$retry_stamp" | jq -r '.leaseId')
    remote_gates_run_url=$(printf '%s\n' "$retry_stamp" | jq -r '.actionsRunUrl // ""')
    echo "Remote testbox lease-retry gate stamp: $remote_gates_lease_id${remote_gates_run_url:+ ($remote_gates_run_url)}"
  else
    run_quiet_logged "pnpm test (lease-retry)" ".local/lease-retry-test.log" pnpm test
    release_pr_gates_lock
  fi

  write_gates_env_stamp \
    "${PR_NUMBER:-}" \
    "$docs_only" \
    "${CHANGELOG_REQUIRED:-false}" \
    "$gates_mode" \
    "$retry_head" \
    "$full_gates_head" \
    "" \
    "$remote_gates_provider" \
    "$remote_gates_lease_id" \
    "$remote_gates_run_url"
}

prepare_gates() {
  local pr="$1"
  local gates_remote_mode
  gates_remote_mode=$(resolve_pr_gates_remote_mode)
  if [ "$gates_remote_mode" = "testbox" ] && [ "${OPENCLAW_TESTBOX:-}" = "1" ]; then
    echo "OPENCLAW_PR_GATES_REMOTE=testbox conflicts with OPENCLAW_TESTBOX=1; hosted PR gates already own remote proof."
    exit 2
  fi

  enter_worktree "$pr" false

  checkout_prep_branch "$pr"
  require_artifact .local/pr-meta.env
  # shellcheck disable=SC1091
  source .local/pr-meta.env

  derive_prepare_gate_change_plan
  local changed_files="$PREPARE_GATE_CHANGED_FILES"
  local docs_only="$PREPARE_GATE_DOCS_ONLY"
  local changelog_only="$PREPARE_GATE_CHANGELOG_ONLY"
  local changelog_required="$PREPARE_GATE_CHANGELOG_REQUIRED"

  local has_changelog_update=false
  local unsupported_changelog_fragments=""
  local changed_path
  while IFS= read -r changed_path; do
    [ -n "$changed_path" ] || continue
    case "$changed_path" in
      CHANGELOG.md)
        has_changelog_update=true
        ;;
      changelog/fragments/*)
        unsupported_changelog_fragments="${unsupported_changelog_fragments}${changed_path}"$'\n'
        ;;
    esac
  done <<<"$changed_files"
  if [ -n "$unsupported_changelog_fragments" ]; then
    echo "Unsupported changelog fragment files detected:"
    printf '%s\n' "$unsupported_changelog_fragments"
    echo "Move changelog fragment content into CHANGELOG.md and remove changelog/fragments files."
    exit 1
  fi

  if [ "$has_changelog_update" = "true" ]; then
    if ! root_changelog_update_allowed_for_pr; then
      echo "CHANGELOG.md is release-owned; normal PRs should put release-note context in the PR body or commit message."
      echo "Set OPENCLAW_ALLOW_ROOT_CHANGELOG_PR=1 only for explicit release automation or maintainer release closeout."
      exit 1
    fi
    normalize_pr_changelog_entries "$pr"
    validate_changelog_attribution_policy
  fi

  if [ "$changelog_required" = "true" ]; then
    local contrib="${PR_AUTHOR:-}"
    validate_changelog_merge_hygiene
    validate_changelog_entry_for_pr "$pr" "$contrib"
  else
    echo "Changelog not required for this changed-file set."
  fi

  local current_head
  current_head=$(git rev-parse HEAD)
  local previous_last_verified_head=""
  local previous_full_gates_head=""
  local remote_gates_provider=""
  local remote_gates_lease_id=""
  local remote_gates_run_url=""
  if [ -s .local/gates.env ]; then
    # shellcheck disable=SC1091
    source .local/gates.env
    previous_last_verified_head="${LAST_VERIFIED_HEAD_SHA:-}"
    previous_full_gates_head="${FULL_GATES_HEAD_SHA:-}"
    # Carried alongside FULL_GATES_HEAD_SHA: they describe how that full-suite
    # proof was produced; a fresh full run below overwrites them.
    remote_gates_provider="${REMOTE_GATES_PROVIDER:-}"
    remote_gates_lease_id="${REMOTE_GATES_LEASE_ID:-}"
    remote_gates_run_url="${REMOTE_GATES_RUN_URL:-}"
  fi

  local gates_mode="full"
  local hosted_gates_head=""
  local reuse_gates=false
  if [ "${OPENCLAW_TESTBOX:-}" != "1" ] && [ "$docs_only" = "true" ] && [ -n "$previous_last_verified_head" ] && git merge-base --is-ancestor "$previous_last_verified_head" HEAD 2>/dev/null; then
    local delta_since_verified
    delta_since_verified=$(git diff --name-only "$previous_last_verified_head"..HEAD)
    if [ -z "$delta_since_verified" ] || file_list_is_docsish_only "$delta_since_verified"; then
      reuse_gates=true
    fi
  fi

  if [ "${OPENCLAW_TESTBOX:-}" = "1" ]; then
    gates_mode="hosted_exact_or_recent_parent"
    remote_gates_provider=""
    remote_gates_lease_id=""
    remote_gates_run_url=""
    if [ "$changelog_only" = "true" ]; then
      run_quiet_logged "git diff --check" ".local/gates-diff-check.log" git diff --check origin/main...HEAD
    fi
    run_hosted_prepare_gates "$pr" "$current_head" "$changelog_only"
    hosted_gates_head="$current_head"
  elif [ "$reuse_gates" = "true" ]; then
    gates_mode="reused_docs_only"
    echo "Docs/changelog-only delta since last verified head $previous_last_verified_head; reusing prior gates."
  else
    prepare_local_gate_workspace
    run_quiet_logged "pnpm build" ".local/gates-build.log" pnpm build
    run_quiet_logged "pnpm check" ".local/gates-check.log" pnpm check

    if [ "$docs_only" = "true" ]; then
      release_pr_gates_lock
      gates_mode="docs_only"
      previous_full_gates_head=""
      remote_gates_provider=""
      remote_gates_lease_id=""
      remote_gates_run_url=""
      echo "Docs-only change detected with high confidence; skipping pnpm test."
    elif [ "$gates_remote_mode" = "testbox" ]; then
      # The full suite runs on a Blacksmith Testbox, so free the local lock
      # for other heavy work while we wait on remote proof.
      release_pr_gates_lock
      gates_mode="remote_testbox"
      echo "Running pnpm test on Blacksmith Testbox (OPENCLAW_PR_GATES_REMOTE=testbox)."
      run_remote_testbox_full_test_gate \
        "pnpm test (blacksmith-testbox)" \
        ".local/gates-test.log" \
        "pr-$pr-gates"
      local remote_stamp
      remote_stamp=$(require_remote_testbox_gate_stamp ".local/gates-test.log")
      remote_gates_provider="blacksmith-testbox"
      remote_gates_lease_id=$(printf '%s\n' "$remote_stamp" | jq -r '.leaseId')
      remote_gates_run_url=$(printf '%s\n' "$remote_stamp" | jq -r '.actionsRunUrl // ""')
      echo "Remote testbox gate stamp: $remote_gates_lease_id${remote_gates_run_url:+ ($remote_gates_run_url)}"
      previous_full_gates_head="$current_head"
    else
      gates_mode="full"
      if [ -n "${OPENCLAW_VITEST_MAX_WORKERS:-}" ]; then
        echo "Running pnpm test with OPENCLAW_VITEST_MAX_WORKERS=$OPENCLAW_VITEST_MAX_WORKERS."
        run_quiet_logged \
          "pnpm test" \
          ".local/gates-test.log" \
          env OPENCLAW_VITEST_MAX_WORKERS="$OPENCLAW_VITEST_MAX_WORKERS" pnpm test
      else
        echo "Running pnpm test with host-aware scheduling defaults."
        run_quiet_logged "pnpm test" ".local/gates-test.log" pnpm test
      fi
      release_pr_gates_lock
      remote_gates_provider=""
      remote_gates_lease_id=""
      remote_gates_run_url=""
      previous_full_gates_head="$current_head"
    fi
  fi

  write_gates_env_stamp \
    "$pr" \
    "$docs_only" \
    "$changelog_required" \
    "$gates_mode" \
    "$current_head" \
    "${previous_full_gates_head:-}" \
    "$hosted_gates_head" \
    "$remote_gates_provider" \
    "$remote_gates_lease_id" \
    "$remote_gates_run_url"

  echo "docs_only=$docs_only"
  echo "changelog_only=$changelog_only"
  echo "changelog_required=$changelog_required"
  echo "gates_mode=$gates_mode"
  echo "wrote=.local/gates.env"
}
