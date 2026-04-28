run_prepare_push_retry_gates() {
  local docs_only="${1:-false}"

  bootstrap_deps_if_needed
  run_quiet_logged "pnpm build (lease-retry)" ".local/lease-retry-build.log" pnpm build
  run_quiet_logged "pnpm check (lease-retry)" ".local/lease-retry-check.log" pnpm check
  if [ "$docs_only" != "true" ]; then
    run_quiet_logged "pnpm test (lease-retry)" ".local/lease-retry-test.log" pnpm test
  fi
}

prepare_gates() {
  local pr="$1"
  enter_worktree "$pr" false

  checkout_prep_branch "$pr"
  bootstrap_deps_if_needed
  require_artifact .local/pr-meta.env
  # shellcheck disable=SC1091
  source .local/pr-meta.env

  local changed_files
  changed_files=$(git diff --name-only origin/main...HEAD)
  local non_docs
  non_docs=$(printf '%s\n' "$changed_files" | while IFS= read -r path; do
    [ -n "$path" ] || continue
    if ! path_is_docsish "$path"; then
      printf '%s\n' "$path"
    fi
  done)

  local docs_only=false
  if [ -n "$changed_files" ] && [ -z "$non_docs" ]; then
    docs_only=true
  fi

  local changelog_required=false
  if changelog_required_for_changed_files "$changed_files"; then
    changelog_required=true
  fi

  local has_changelog_update=false
  if printf '%s\n' "$changed_files" | rg -q '^CHANGELOG\.md$'; then
    has_changelog_update=true
  fi

  local unsupported_changelog_fragments
  unsupported_changelog_fragments=$(printf '%s\n' "$changed_files" | rg '^changelog/fragments/' || true)
  if [ -n "$unsupported_changelog_fragments" ]; then
    echo "Unsupported changelog fragment files detected:"
    printf '%s\n' "$unsupported_changelog_fragments"
    echo "Move changelog fragment content into CHANGELOG.md and remove changelog/fragments files."
    exit 1
  fi

  if [ "$changelog_required" = "true" ] && [ "$has_changelog_update" = "false" ]; then
    echo "Missing changelog update. Add CHANGELOG.md changes."
    exit 1
  fi

  if [ "$has_changelog_update" = "true" ]; then
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
  if [ -s .local/gates.env ]; then
    # shellcheck disable=SC1091
    source .local/gates.env
    previous_last_verified_head="${LAST_VERIFIED_HEAD_SHA:-}"
    previous_full_gates_head="${FULL_GATES_HEAD_SHA:-}"
  fi

  local gates_mode="full"
  local reuse_gates=false
  if [ "$docs_only" = "true" ] && [ -n "$previous_last_verified_head" ] && git merge-base --is-ancestor "$previous_last_verified_head" HEAD 2>/dev/null; then
    local delta_since_verified
    delta_since_verified=$(git diff --name-only "$previous_last_verified_head"..HEAD)
    if [ -z "$delta_since_verified" ] || file_list_is_docsish_only "$delta_since_verified"; then
      reuse_gates=true
    fi
  fi

  if [ "$reuse_gates" = "true" ]; then
    gates_mode="reused_docs_only"
    echo "Docs/changelog-only delta since last verified head $previous_last_verified_head; reusing prior gates."
  else
    run_quiet_logged "pnpm build" ".local/gates-build.log" pnpm build
    run_quiet_logged "pnpm check" ".local/gates-check.log" pnpm check

    if [ "$docs_only" = "true" ]; then
      gates_mode="docs_only"
      echo "Docs-only change detected with high confidence; skipping pnpm test."
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
      previous_full_gates_head="$current_head"
    fi
  fi

  # Security: shell-escape values to prevent command injection when sourced.
  printf '%s=%q\n' \
    PR_NUMBER "$pr" \
    DOCS_ONLY "$docs_only" \
    CHANGELOG_REQUIRED "$changelog_required" \
    GATES_MODE "$gates_mode" \
    LAST_VERIFIED_HEAD_SHA "$current_head" \
    FULL_GATES_HEAD_SHA "${previous_full_gates_head:-}" \
    GATES_PASSED_AT "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    > .local/gates.env

  echo "docs_only=$docs_only"
  echo "changelog_required=$changelog_required"
  echo "gates_mode=$gates_mode"
  echo "wrote=.local/gates.env"
}
