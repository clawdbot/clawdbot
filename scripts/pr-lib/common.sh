require_artifact() {
  local path="$1"
  if [ ! -s "$path" ]; then
    echo "Missing required artifact: $path"
    exit 1
  fi
}

validate_pr_temp_storage() {
  local temp_dir="${TMPDIR:-/tmp}"
  local probe=""
  if ! probe=$(mktemp "${temp_dir%/}/openclaw-pr.XXXXXX"); then
    :
  elif ! printf 'openclaw-pr-temp-probe\n' >"$probe"; then
    rm -f "$probe" 2>/dev/null || true
  elif rm -f "$probe"; then
    return 0
  fi

  echo "scripts/pr temporary-storage preflight failed under TMPDIR=$temp_dir." >&2
  echo "Free disk space or set TMPDIR to a writable filesystem, then retry." >&2
  return 1
}

path_is_docsish() {
  local path="$1"
  case "$path" in
    CHANGELOG.md|AGENTS.md|CLAUDE.md|README*.md|docs/*|*.md|*.mdx|mintlify.json|docs.json)
      return 0
      ;;
  esac
  return 1
}

file_list_is_docsish_only() {
  local files="$1"
  local saw_any=false
  local path
  while [ -n "$files" ]; do
    path="${files%%$'\n'*}"
    if [ "$path" = "$files" ]; then
      files=""
    else
      files="${files#*$'\n'}"
    fi
    [ -n "$path" ] || continue
    saw_any=true
    if ! path_is_docsish "$path"; then
      return 1
    fi
  done

  [ "$saw_any" = "true" ]
}

changelog_required_for_changed_files() {
  # CHANGELOG.md is release-owned. Normal PRs carry release-note context in
  # PR bodies and commit messages; release automation generates the file.
  return 1
}

root_changelog_update_allowed_for_pr() {
  case "${OPENCLAW_ALLOW_ROOT_CHANGELOG_PR:-}" in
    1|true|TRUE|yes|YES|on|ON)
      return 0
      ;;
  esac
  return 1
}

print_review_stdout_summary() {
  require_artifact .local/review.md
  require_artifact .local/review.json
  require_artifact .local/pr-meta.env

  # shellcheck disable=SC1091
  source .local/pr-meta.env

  local recommendation
  recommendation=$(jq -r '.recommendation // ""' .local/review.json)
  local finding_count
  finding_count=$(jq '[.findings[]?] | length' .local/review.json)

  echo "review summary:"
  echo "pr_url=${PR_URL:-}"
  echo "recommendation: $recommendation"
  echo "findings: $finding_count"
  cat .local/review.md
}

print_relevant_log_excerpt() {
  local log_file="$1"
  if [ ! -s "$log_file" ]; then
    echo "(no output captured)"
    return 0
  fi

  local filtered_log
  filtered_log=$(mktemp)
  if rg -n -i 'error|err|failed|fail|fatal|panic|exception|TypeError|ReferenceError|SyntaxError|ELIFECYCLE|ERR_' "$log_file" >"$filtered_log"; then
    echo "Relevant log lines:"
    tail -n 120 "$filtered_log"
  else
    echo "No focused error markers found; showing last 120 lines:"
    tail -n 120 "$log_file"
  fi
  rm -f "$filtered_log"
}

print_unrelated_gate_failure_guidance() {
  local label="$1"
  case "$label" in
    pnpm\ build*|pnpm\ check*|pnpm\ test*)
      cat <<'EOF_GUIDANCE'
If this local gate failure already reproduces on latest origin/main and is clearly unrelated to the PR:
- treat it as baseline repo noise
- document it explicitly
- report the scoped verification that validates the PR itself
- do not use this to ignore plausibly related failures
EOF_GUIDANCE
      ;;
  esac
}

run_quiet_logged() {
  local label="$1"
  local log_file="$2"
  shift 2

  mkdir -p .local
  if "$@" >"$log_file" 2>&1; then
    echo "$label passed"
    return 0
  fi

  echo "$label failed (log: $log_file)"
  print_relevant_log_excerpt "$log_file"
  print_unrelated_gate_failure_guidance "$label"
  return 1
}

bootstrap_deps_if_needed() {
  if [ ! -x node_modules/.bin/vitest ]; then
    run_quiet_logged "pnpm install --frozen-lockfile" ".local/bootstrap-install.log" pnpm install --frozen-lockfile
  fi
}

read_pr_view_json() {
  local pr="$1"
  local fields="$2"
  local max_attempts=3
  local temp_dir
  temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/openclaw-pr-view.XXXXXX") || {
    echo "Unable to create temporary storage for GitHub PR metadata." >&2
    return 1
  }
  local stdout_file="$temp_dir/stdout"
  local stderr_file="$temp_dir/stderr"
  local attempt exit_code reason

  for attempt in $(seq 1 "$max_attempts"); do
    exit_code=0
    if gh pr view "$pr" --json "$fields" >"$stdout_file" 2>"$stderr_file"; then
      if [ -s "$stdout_file" ] && jq -se 'length == 1 and (.[0] | type == "object")' "$stdout_file" >/dev/null 2>&1; then
        cat "$stdout_file"
        rm -rf "$temp_dir"
        return 0
      fi
      if [ ! -s "$stdout_file" ]; then
        reason="gh pr view returned empty stdout"
      else
        reason="gh pr view did not return one JSON object"
      fi
    else
      exit_code=$?
      reason="gh pr view exited with status $exit_code"
    fi
    [ "$attempt" -eq "$max_attempts" ] || sleep "$attempt"
  done

  echo "GitHub API failure while reading PR #$pr: $reason after $max_attempts attempts." >&2
  [ ! -s "$stderr_file" ] || cat "$stderr_file" >&2
  rm -rf "$temp_dir"
  return 1
}

pr_view_string_field() {
  local json="$1" field="$2" pr="$3" remedy="${4:-Retry the command.}" label value
  case "$field" in
    headRefOid) label="a head SHA" ;;
    baseRefName) label="a base branch" ;;
    headRefName) label="a head branch" ;;
    *) label="a non-empty .$field string" ;;
  esac
  if ! value=$(printf '%s\n' "$json" | jq -er --arg field "$field" '.[$field] | if type == "string" and length > 0 then . else error("missing string field") end' 2>/dev/null); then
    echo "GitHub PR metadata for #$pr did not include $label. $remedy" >&2
    return 1
  fi
  printf '%s\n' "$value"
}

wait_for_pr_head_sha() {
  local pr="$1"
  local expected_sha="$2"
  local max_attempts="${3:-6}"
  local sleep_seconds="${4:-2}"

  local attempt
  for attempt in $(seq 1 "$max_attempts"); do
    local observed_sha
    observed_sha=$(gh pr view "$pr" --json headRefOid --jq .headRefOid)
    if [ "$observed_sha" = "$expected_sha" ]; then
      return 0
    fi

    if [ "$attempt" -lt "$max_attempts" ]; then
      sleep "$sleep_seconds"
    fi
  done

  return 1
}

pr_contributor_allows_human_trailers() {
  local contrib="${1:-}"
  local normalized
  normalized=$(printf '%s' "$contrib" | tr '[:upper:]' '[:lower:]')

  case "$normalized" in
    ""|"null"|"app/"*|"codex"|"openclaw"|"clawsweeper"|"openclaw-clawsweeper"|"clawsweeper[bot]"|"openclaw-clawsweeper[bot]"|"steipete")
      return 1
      ;;
  esac

  return 0
}

resolve_contributor_coauthor_email() {
  local contrib="${1:-}"

  if ! pr_contributor_allows_human_trailers "$contrib"; then
    return 1
  fi

  local contrib_id
  contrib_id=$(gh api "users/$contrib" --jq .id) || return 1
  printf '%s+%s@users.noreply.github.com\n' "$contrib_id" "$contrib"
}

common_repo_root() {
  if command -v repo_root >/dev/null 2>&1; then
    repo_root
    return
  fi

  local base_dir
  base_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  git -C "$base_dir" rev-parse --show-toplevel
}

worktree_path_for_branch() {
  local branch="$1"
  local ref="refs/heads/$branch"
  local field worktree="" match=""
  # Drain foreground Git before the supervisor checks for leftover children.
  git worktree list --porcelain -z | {
    while IFS= read -r -d '' field; do
      case "$field" in
        worktree\ *) worktree="${field#worktree }" ;;
        "branch $ref") match="$worktree" ;;
        "") worktree="" ;;
      esac
    done
    [ -n "$match" ] || return 1
    printf '%s\n' "$match"
  }
}

worktree_is_registered() {
  local path="$1"
  local field found=false
  # Git must finish before a successful operation can release its lock.
  git worktree list --porcelain -z | {
    while IFS= read -r -d '' field; do
      case "$field" in
        worktree\ *) [ "${field#worktree }" != "$path" ] || found=true ;;
      esac
    done
    [ "$found" = true ]
  }
}

resolve_existing_dir_path() {
  local path="$1"
  if [ ! -d "$path" ]; then
    return 1
  fi

  (
    cd "$path" >/dev/null 2>&1 &&
      pwd -P
  )
}

is_repo_pr_worktree_dir() {
  local path="$1"
  local root
  root=$(common_repo_root)

  local worktrees_dir="$root/.worktrees"
  local resolved_path
  resolved_path=$(resolve_existing_dir_path "$path" 2>/dev/null || true)
  if [ -z "$resolved_path" ]; then
    return 1
  fi

  local resolved_worktrees_dir
  resolved_worktrees_dir=$(resolve_existing_dir_path "$worktrees_dir" 2>/dev/null || true)
  if [ -z "$resolved_worktrees_dir" ]; then
    return 1
  fi

  case "$resolved_path" in
    "$resolved_worktrees_dir"/pr-*)
      return 0
      ;;
  esac
  return 1
}

remove_worktree_if_present() {
  local path="$1"
  local registered_path=""
  local registered_parent=""
  registered_parent=$(resolve_existing_dir_path "$(dirname "$path")" 2>/dev/null || true)
  if [ -n "$registered_parent" ]; then
    registered_path="$registered_parent/$(basename "$path")"
  fi

  if [ ! -e "$path" ]; then
    # A torn-down PR worktree once left a stale registration that poisoned
    # every later worktree add until the registration was pruned.
    if [ -n "$registered_path" ] && worktree_is_registered "$registered_path"; then
      git worktree prune || true
      if worktree_is_registered "$registered_path"; then
        echo "Warning: failed to remove registered worktree $path"
      fi
    fi
    return 0
  fi

  if [ -L "$path" ] || ! is_repo_pr_worktree_dir "$path"; then
    echo "Warning: refusing to remove non-canonical PR-worktree path $path"
    return 0
  fi

  if [ -n "$registered_path" ] && worktree_is_registered "$registered_path"; then
    local remove_error
    if ! remove_error=$(git worktree remove --force "$registered_path" 2>&1); then
      echo "Warning: git worktree remove failed for $path: $remove_error"
    fi
  fi

  if [ ! -e "$path" ]; then
    # See the stale-registration recovery above: removal can delete the path
    # while leaving Git's linked-worktree metadata behind.
    if [ -n "$registered_path" ] && worktree_is_registered "$registered_path"; then
      git worktree prune || true
      if worktree_is_registered "$registered_path"; then
        echo "Warning: failed to remove registered worktree $path"
      fi
    fi
    return 0
  fi

  if [ -n "$registered_path" ] && worktree_is_registered "$registered_path"; then
    echo "Warning: failed to remove registered worktree $path"
    return 0
  fi

  if [ -L "$path" ] || ! is_repo_pr_worktree_dir "$path"; then
    echo "Warning: refusing to trash non-PR-worktree path $path"
    return 0
  fi

  if command -v trash >/dev/null 2>&1; then
    trash "$path" >/dev/null 2>&1 || {
      echo "Warning: failed to trash orphaned worktree dir $path"
      return 0
    }
    return 0
  fi

  echo "Warning: orphaned worktree dir remains and trash is unavailable: $path"
  return 0
}

delete_local_branch_if_safe() {
  local branch="$1"
  local ref="refs/heads/$branch"

  if ! git show-ref --verify --quiet "$ref"; then
    return 0
  fi

  local branch_worktree=""
  branch_worktree=$(worktree_path_for_branch "$branch" 2>/dev/null || true)
  if [ -n "$branch_worktree" ]; then
    echo "Skipping local branch delete for $branch; checked out in worktree $branch_worktree"
    return 0
  fi

  if git branch -D "$branch" >/dev/null 2>&1; then
    return 0
  fi
  if git update-ref -d "$ref" >/dev/null 2>&1; then
    return 0
  fi

  echo "Warning: failed to delete local branch $branch"
  return 0
}
