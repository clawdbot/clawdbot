run_hosted_prepare_gates() {
  local pr="$1"
  local current_head="$2"
  local changelog_only="$3"
  local recent_sha=""
  local remote_record="${4:-}" remote_head remote_head_ref remote_is_cross_repository
  if [ -z "$remote_record" ]; then
    remote_record=$(read_pr_view_json "$pr" "headRefName,headRefOid,isCrossRepository") || return 1
  fi
  remote_head=$(pr_view_string_field "$remote_record" "headRefOid" "$pr" "Re-run prepare-init.") || return 1
  remote_head_ref=$(printf '%s\n' "$remote_record" | jq -r .headRefName)
  remote_is_cross_repository=$(printf '%s\n' "$remote_record" | jq -r .isCrossRepository)
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
  repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || return 1
  local scripts_dir="${script_parent_dir:-}"
  if [ -z "$scripts_dir" ]; then
    scripts_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
  fi
  local args=(
    "$scripts_dir/verify-pr-hosted-gates.mjs"
    --repo "$repo"
    --sha "$current_head"
    --pr "$pr"
    --main-sha "$PR_MAIN_SHA"
    --output ".local/gates-hosted-checks.json"
  )
  if [ -n "$recent_sha" ]; then
    args+=(--recent-sha "$recent_sha")
  fi
  if [ "$changelog_only" = "true" ]; then
    args+=(--changelog-only)
  fi
  if run_quiet_logged "hosted CI/Testbox gates" ".local/gates-hosted-checks.log" node "${args[@]}"; then
    return 0
  fi

  if rg -F -q "Missing successful recent CI workflow for $current_head. Observed: none" \
    .local/gates-hosted-checks.log
  then
    if [ "$remote_is_cross_repository" = "true" ]; then
      cat <<EOF_RECOVERY
Missing hosted CI recovery:
  scripts/pr ci-dispatch $pr
  unavailable: PR #$pr comes from a fork, and release-gate dispatch requires the exact target SHA on a base-repository branch.
EOF_RECOVERY
      return 1
    fi
    cat <<EOF_RECOVERY
Missing hosted CI recovery:
  scripts/pr ci-dispatch $pr
Underlying command:
EOF_RECOVERY
    printf '  gh workflow run ci.yml --ref %q -f %q -f release_gate=true -f %q\n' \
      "$remote_head_ref" \
      "target_ref=$remote_head" \
      "pull_request_number=$pr"
  fi
  return 1
}

ci_dispatch() {
  local pr="$1"
  shift
  local record base_sha head_ref head_sha is_cross_repository
  record=$(gh pr view "$pr" --json baseRefOid,headRefName,headRefOid,isCrossRepository)
  base_sha=$(printf '%s\n' "$record" | jq -r .baseRefOid)
  head_ref=$(printf '%s\n' "$record" | jq -r .headRefName)
  head_sha=$(printf '%s\n' "$record" | jq -r .headRefOid)
  is_cross_repository=$(printf '%s\n' "$record" | jq -r .isCrossRepository)
  if [ -z "$head_ref" ] || [ "$head_ref" = "null" ] || [ -z "$head_sha" ] || [ "$head_sha" = "null" ]; then
    echo "PR #$pr is missing remote headRefName/headRefOid metadata." >&2
    return 1
  fi
  if [ "$is_cross_repository" = "true" ]; then
    echo "PR #$pr comes from a fork; release-gate workflow dispatch requires a base-repository branch at $head_sha." >&2
    return 1
  fi

  mark_pr_operation_side_effects_if_available
  node "$script_parent_dir/pr-lib/ci-dispatch.mjs" \
    "$pr" "$head_ref" "$head_sha" "$base_sha" false "$@"
}

mark_pr_operation_side_effects_if_available() {
  # scripts/pr sources operation-lock.sh first. Policy tests may source this
  # library alone, where advancing a lock phase is neither possible nor needed.
  if declare -F mark_pr_operation_side_effects_started >/dev/null; then
    mark_pr_operation_side_effects_started
  fi
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
    crabbox-aws)
      printf 'crabbox-aws\n'
      ;;
    *)
      echo "Unsupported OPENCLAW_PR_GATES_REMOTE=${OPENCLAW_PR_GATES_REMOTE} (supported: testbox, crabbox-aws)." >&2
      return 1
      ;;
  esac
}

prepare_local_gate_workspace() {
  pin_worktree_bundled_plugins_dir
  bootstrap_deps_if_needed
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
    -- env CI=1 OPENCLAW_TESTBOX_REMOTE_RUN=1 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false corepack pnpm test
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

require_active_org_admin_for_crabbox_gate() {
  local actor membership
  actor=$(gh_plain api graphql -f 'query=query { viewer { login } }' --jq .data.viewer.login) || return
  membership=$(gh_plain api "orgs/openclaw/memberships/$actor" -H 'Cache-Control: max-age=0') || return
  if [ "$(printf '%s\n' "$membership" | jq -r .state)" != "active" ] ||
    [ "$(printf '%s\n' "$membership" | jq -r .role)" != "admin" ]; then
    echo "OPENCLAW_PR_GATES_REMOTE=crabbox-aws requires an active openclaw organization admin." >&2
    return 1
  fi
  printf '%s\n' "$actor"
}

read_crabbox_gate_pr_binding() {
  local pr="$1"
  local expected_head="$2"
  local expected_base="${3:-}"
  local record
  record=$(gh pr view "$pr" --json baseRefName,baseRefOid,headRefOid,isCrossRepository,state)
  if [ "$(printf '%s\n' "$record" | jq -r .state)" != "OPEN" ] ||
    [ "$(printf '%s\n' "$record" | jq -r .isCrossRepository)" != "false" ] ||
    [ "$(printf '%s\n' "$record" | jq -r .baseRefName)" != "main" ] ||
    [ "$(printf '%s\n' "$record" | jq -r .headRefOid)" != "$expected_head" ]; then
    echo "Crabbox AWS gate requires the requested open same-repository PR at exact head $expected_head." >&2
    return 1
  fi
  local base_sha
  base_sha=$(printf '%s\n' "$record" | jq -r .baseRefOid)
  if [[ ! "$base_sha" =~ ^[0-9a-f]{40}$ ]] ||
    { [ -n "$expected_base" ] && [ "$base_sha" != "$expected_base" ]; }; then
    echo "Crabbox AWS gate PR base changed or is malformed." >&2
    return 1
  fi
  printf '%s\n' "$base_sha"
}

finalize_remote_crabbox_aws_gate() {
  local pr="$1"
  local head_sha="$2"
  local base_sha log_file stamp run_id lease_id run_url
  base_sha=$(read_crabbox_gate_pr_binding "$pr" "$head_sha") || return 1
  require_active_org_admin_for_crabbox_gate >/dev/null || return 1
  log_file=".local/gates-crabbox-aws.log"
  run_quiet_logged "protected-main Crabbox AWS exact-head gate" "$log_file" \
    ci_dispatch "$pr" --backend crabbox
  stamp=$(jq -c -R \
    --arg baseSha "$base_sha" \
    --arg headSha "$head_sha" '
      fromjson?
      | select(
          .backend == "crabbox"
          and .provider == "aws"
          and .target == "linux"
          and .baseSha == $baseSha
          and .headSha == $headSha
          and ((.runId // "") | startswith("run_"))
          and ((.leaseId // "") | startswith("cbx_"))
          and ((.actionsRunUrl // "") | startswith("https://github.com/openclaw/openclaw/actions/runs/"))
        )
    ' "$log_file" | tail -n 1)
  if [ -z "$stamp" ]; then
    echo "Protected-main Crabbox publisher passed without trusted exact-head metadata." >&2
    return 1
  fi
  read_crabbox_gate_pr_binding "$pr" "$head_sha" "$base_sha" >/dev/null || return 1
  run_id=$(printf '%s\n' "$stamp" | jq -r .runId)
  lease_id=$(printf '%s\n' "$stamp" | jq -r .leaseId)
  run_url=$(printf '%s\n' "$stamp" | jq -r .actionsRunUrl)
  write_gates_env_stamp \
    "$pr" \
    "${DOCS_ONLY:-false}" \
    "${CHANGELOG_REQUIRED:-false}" \
    "remote_crabbox_aws" \
    "$head_sha" \
    "$head_sha" \
    "" \
    "aws" \
    "$run_id" \
    "$lease_id" \
    "$run_url"
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
  local remote_run_id="$9"
  local remote_lease_id="${10}"
  local remote_run_url="${11}"

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
    REMOTE_GATES_RUN_ID "$remote_run_id" \
    REMOTE_GATES_LEASE_ID "$remote_lease_id" \
    REMOTE_GATES_RUN_URL "$remote_run_url" \
    GATES_PASSED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > .local/gates.env
}

derive_prepare_gate_change_plan() {
  PREPARE_GATE_CHANGED_FILES=$(git diff --name-only "$PR_MAIN_SHA...${1:-HEAD}") || return 1
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

prepare_gates() {
  local pr="$1"
  local gates_remote_mode
  gates_remote_mode=$(resolve_pr_gates_remote_mode)
  if [ "$gates_remote_mode" != "local" ] && [ "${OPENCLAW_TESTBOX:-}" = "1" ]; then
    echo "OPENCLAW_PR_GATES_REMOTE=$gates_remote_mode conflicts with OPENCLAW_TESTBOX=1; hosted PR gates already own remote proof."
    exit 2
  fi

  PR_MAIN_SHA=""
  enter_worktree "$pr" false || return 1

  mark_pr_operation_side_effects_if_available
  refresh_prep_branch_for_reviewed_head "$pr"
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
  while [ -n "$changed_files" ]; do
    changed_path="${changed_files%%$'\n'*}"
    if [ "$changed_path" = "$changed_files" ]; then
      changed_files=""
    else
      changed_files="${changed_files#*$'\n'}"
    fi
    [ -n "$changed_path" ] || continue
    case "$changed_path" in
      CHANGELOG.md)
        has_changelog_update=true
        ;;
      changelog/fragments/*)
        unsupported_changelog_fragments="${unsupported_changelog_fragments}${changed_path}"$'\n'
        ;;
    esac
  done
  if [ -n "$unsupported_changelog_fragments" ]; then
    echo "Unsupported changelog fragment files detected:"
    printf '%s\n' "$unsupported_changelog_fragments"
    echo "Move changelog fragment content into CHANGELOG.md and remove changelog/fragments files."
    exit 1
  fi

  local remote_record="" changelog_mode
  if [ "$has_changelog_update" = "true" ]; then
    remote_record=$(read_pr_view_json "$pr" "headRefName,headRefOid,isCrossRepository,title,baseRefName") || return 1
    if ! changelog_mode=$(root_changelog_update_allowed_for_pr "$remote_record"); then
      echo "CHANGELOG.md is release-owned; normal PRs should put release-note context in the PR body or commit message."
      echo "Use release/<version>-main-closeout with the documented title and only that origin-tagged version section, or set OPENCLAW_ALLOW_ROOT_CHANGELOG_PR=1 for explicit release automation."
      exit 1
    fi
    # Published closeout text is immutable; normalizing PR references can move it
    # into an Unreleased section and invalidate the tagged release copy.
    if [ "$changelog_mode" = "override" ]; then normalize_pr_changelog_entries "$pr"; fi
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
  local remote_gates_run_id=""
  local remote_gates_lease_id=""
  local remote_gates_run_url=""
  if [ -s .local/gates.env ]; then
    # shellcheck disable=SC1091
    source .local/gates.env
    previous_last_verified_head="${LAST_VERIFIED_HEAD_SHA:-}"
    previous_full_gates_head="${FULL_GATES_HEAD_SHA:-}"
    # Carried alongside FULL_GATES_HEAD_SHA: they describe how that exact-head
    # proof was produced; a fresh gate run below overwrites them.
    remote_gates_provider="${REMOTE_GATES_PROVIDER:-}"
    remote_gates_run_id="${REMOTE_GATES_RUN_ID:-}"
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
    remote_gates_run_id=""
    remote_gates_lease_id=""
    remote_gates_run_url=""
    if [ "$changelog_only" = "true" ]; then
      run_quiet_logged "git diff --check" ".local/gates-diff-check.log" git diff --check "$PR_MAIN_SHA...HEAD"
    fi
    run_hosted_prepare_gates "$pr" "$current_head" "$changelog_only" "$remote_record"
    hosted_gates_head="$current_head"
  elif [ "$reuse_gates" = "true" ]; then
    gates_mode="reused_docs_only"
    echo "Docs/changelog-only delta since last verified head $previous_last_verified_head; reusing prior gates."
  elif [ "$gates_remote_mode" = "crabbox-aws" ]; then
    require_active_org_admin_for_crabbox_gate >/dev/null
    gates_mode="remote_crabbox_aws_pending"
    previous_full_gates_head=""
    remote_gates_provider="aws"
    remote_gates_run_id=""
    remote_gates_lease_id=""
    remote_gates_run_url=""
    echo "Crabbox AWS proof is deferred until prepare-push verifies the exact remote head."
  else
    prepare_local_gate_workspace
    run_quiet_logged "pnpm build" ".local/gates-build.log" pnpm build
    run_quiet_logged "pnpm check" ".local/gates-check.log" pnpm check

    if [ "$docs_only" = "true" ]; then
      gates_mode="docs_only"
      previous_full_gates_head=""
      remote_gates_provider=""
      remote_gates_run_id=""
      remote_gates_lease_id=""
      remote_gates_run_url=""
      echo "Docs-only change detected with high confidence; skipping pnpm test."
    elif [ "$gates_remote_mode" = "testbox" ]; then
      gates_mode="remote_testbox"
      echo "Running pnpm test on Blacksmith Testbox (OPENCLAW_PR_GATES_REMOTE=testbox)."
      run_remote_testbox_full_test_gate \
        "pnpm test (blacksmith-testbox)" \
        ".local/gates-test.log" \
        "pr-$pr-gates"
      local remote_stamp
      remote_stamp=$(require_remote_testbox_gate_stamp ".local/gates-test.log")
      remote_gates_provider="blacksmith-testbox"
      remote_gates_run_id=""
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
      remote_gates_provider=""
      remote_gates_run_id=""
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
    "$remote_gates_run_id" \
    "$remote_gates_lease_id" \
    "$remote_gates_run_url"

  echo "docs_only=$docs_only"
  echo "changelog_only=$changelog_only"
  echo "changelog_required=$changelog_required"
  echo "gates_mode=$gates_mode"
  echo "wrote=.local/gates.env"
}
