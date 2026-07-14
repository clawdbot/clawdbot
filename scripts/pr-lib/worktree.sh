repo_root() {
  # Resolve canonical repository root from git common-dir so wrappers work
  # the same from main checkout or any linked worktree.
  local base_dir
  local common_git_dir
  base_dir="${script_parent_dir:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

  if common_git_dir=$(git -C "$base_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
    (cd "$(dirname "$common_git_dir")" && pwd)
    return
  fi

  # Fallback for environments where git common-dir is unavailable.
  (cd "$base_dir/.." && pwd)
}

ensure_gh_api_auth() {
  # gh auth status fetches token scopes through REST and misreports quota
  # failures as invalid credentials. GraphQL verifies the active local token
  # without sending maintainers through a login that cannot restore quota.
  if gh_plain api graphql -f 'query=query { viewer { login } }' --jq .data.viewer.login >/dev/null 2>&1; then
    return 0
  fi

  cat >&2 <<'EOF'
GitHub CLI auth is not usable for non-interactive API calls.
Run `gh auth login -h github.com` (or refresh the current token) and retry.
EOF
  return 1
}

enter_worktree() {
  local pr="$1"
  local reset_to_main="${2:-false}"
  local invoke_cwd
  invoke_cwd="$PWD"
  local root
  root=$(repo_root)

  if [ "$invoke_cwd" != "$root" ]; then
    echo "Detected non-root invocation cwd=$invoke_cwd, using canonical root $root"
  fi

  cd "$root"
  ensure_gh_api_auth
  git fetch origin main

  local dir=".worktrees/pr-$pr"
  if [ -d "$dir" ]; then
    cd "$dir"
    git fetch origin main
    if [ "$reset_to_main" = "true" ]; then
      git checkout -B "temp/pr-$pr" origin/main
    fi
  else
    git worktree add "$dir" -b "temp/pr-$pr" origin/main
    cd "$dir"
  fi

  mkdir -p .local
}

pr_meta_json() {
  local pr="$1"
  local metadata files expected_file_count actual_file_count head_before head_after
  metadata=$(gh pr view "$pr" --json number,title,state,isDraft,author,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,url,body,labels,assignees,reviewRequests,changedFiles,additions,deletions,statusCheckRollup)
  head_before=$(printf '%s\n' "$metadata" | jq -r .headRefOid)

  # Raw `gh pr view --json files` stops at 100 entries. Paginate REST so
  # review guards see every path, then fail closed on head or API drift.
  if ! files=$(
    set -o pipefail
    gh api --paginate "repos/{owner}/{repo}/pulls/$pr/files?per_page=100" |
      jq -cs '
        add
        | map({
            path: .filename,
            additions: .additions,
            deletions: .deletions,
            changeType: (
              if .status == "removed" then "DELETED"
              else (.status | ascii_upcase)
              end
            )
          })
      '
  ); then
    echo "Failed to collect paginated PR file metadata for #$pr." >&2
    return 1
  fi

  head_after=$(gh pr view "$pr" --json headRefOid | jq -r .headRefOid)
  if [ "$head_after" != "$head_before" ]; then
    echo "PR head changed while collecting file metadata for #$pr (started at $head_before, ended at $head_after). Retry review initialization." >&2
    return 1
  fi

  expected_file_count=$(printf '%s\n' "$metadata" | jq -r .changedFiles)
  if ! actual_file_count=$(
    printf '%s\n' "$files" |
      jq -er 'if type == "array" then length else error("expected an array") end'
  ); then
    echo "Invalid paginated PR file metadata for #$pr: expected a JSON array." >&2
    return 1
  fi
  if [ "$actual_file_count" -ne "$expected_file_count" ]; then
    echo "Incomplete PR file metadata for #$pr: expected $expected_file_count changed files, received $actual_file_count from paginated REST." >&2
    return 1
  fi

  printf '%s\n%s\n' "$metadata" "$files" | jq -cs '.[0] + {files: .[1]}'
}

write_pr_meta_files() {
  local json="$1"

  printf '%s\n' "$json" > .local/pr-meta.json

  # Security: shell-escape all values with printf %q to prevent command injection
  # via malicious branch names containing $() or backticks. See GHSA-xxxx-xxxx-xxxx.
  local pr_number pr_url pr_author pr_base pr_head pr_head_sha
  local pr_head_repo pr_head_repo_url pr_head_owner pr_head_repo_name
  pr_number=$(printf '%s\n' "$json" | jq -r .number)
  pr_url=$(printf '%s\n' "$json" | jq -r .url)
  pr_author=$(printf '%s\n' "$json" | jq -r .author.login)
  pr_base=$(printf '%s\n' "$json" | jq -r .baseRefName)
  pr_head=$(printf '%s\n' "$json" | jq -r .headRefName)
  pr_head_sha=$(printf '%s\n' "$json" | jq -r .headRefOid)
  pr_head_repo=$(printf '%s\n' "$json" | jq -r .headRepository.nameWithOwner)
  pr_head_repo_url=$(printf '%s\n' "$json" | jq -r '.headRepository.url // ""')
  pr_head_owner=$(printf '%s\n' "$json" | jq -r '.headRepositoryOwner.login // ""')
  pr_head_repo_name=$(printf '%s\n' "$json" | jq -r '.headRepository.name // ""')

  printf '%s=%q\n' \
    PR_NUMBER "$pr_number" \
    PR_URL "$pr_url" \
    PR_AUTHOR "$pr_author" \
    PR_BASE "$pr_base" \
    PR_HEAD "$pr_head" \
    PR_HEAD_SHA "$pr_head_sha" \
    PR_HEAD_REPO "$pr_head_repo" \
    PR_HEAD_REPO_URL "$pr_head_repo_url" \
    PR_HEAD_OWNER "$pr_head_owner" \
    PR_HEAD_REPO_NAME "$pr_head_repo_name" \
    > .local/pr-meta.env
}

list_pr_worktrees() {
  local root
  root=$(repo_root)
  cd "$root"

  local dir
  local found=false
  for dir in .worktrees/pr-*; do
    [ -d "$dir" ] || continue
    found=true
    local pr
    if ! pr=$(pr_number_from_worktree_dir "$dir"); then
      printf 'UNKNOWN\t%s\tUNKNOWN\t(unparseable)\t\n' "$dir"
      continue
    fi
    local info
    info=$(gh pr view "$pr" --json state,title,url --jq '[.state, .title, .url] | @tsv' 2>/dev/null || printf 'UNKNOWN\t(unavailable)\t')
    printf '%s\t%s\t%s\n' "$pr" "$dir" "$info"
  done

  if [ "$found" = "false" ]; then
    echo "No PR worktrees found."
  fi
}

gc_pr_worktrees() {
  local dry_run="${1:-false}"
  local root
  root=$(repo_root)
  cd "$root"

  local dir
  local removed=0
  for dir in .worktrees/pr-*; do
    [ -d "$dir" ] || continue
    local pr
    if ! pr=$(pr_number_from_worktree_dir "$dir"); then
      echo "skipping $dir (could not parse PR number)"
      continue
    fi
    local lock_status=0
    try_acquire_pr_operation_lock "$pr" || lock_status=$?
    if [ "$lock_status" -ne 0 ]; then
      if [ "$lock_status" -eq 1 ]; then
        echo "skipping $dir (PR #$pr has an active scripts/pr operation)"
      elif [ -n "$PR_OPERATION_LOCK_BLOCKED_OID" ]; then
        echo "skipping $dir (PR #$pr operation lock is $PR_OPERATION_LOCK_BLOCKED_REASON)"
        print_pr_operation_lock_recovery_guidance "$pr"
      else
        echo "skipping $dir (PR #$pr operation lock state is indeterminate)"
      fi
      continue
    fi
    local state
    state=$(gh pr view "$pr" --json state --jq .state 2>/dev/null || printf 'UNKNOWN')
    case "$state" in
      MERGED|CLOSED)
        if [ "$dry_run" = "true" ]; then
          echo "would remove $dir (PR #$pr state=$state)"
          removed=$((removed + 1))
        else
          remove_worktree_if_present "$dir"
          delete_local_branch_if_safe "temp/pr-$pr"
          delete_local_branch_if_safe "pr-$pr"
          delete_local_branch_if_safe "pr-$pr-prep"
          if [ ! -e "$dir" ] &&
            ! git show-ref --verify --quiet "refs/heads/temp/pr-$pr" &&
            ! git show-ref --verify --quiet "refs/heads/pr-$pr" &&
            ! git show-ref --verify --quiet "refs/heads/pr-$pr-prep"
          then
            echo "removed $dir (PR #$pr state=$state)"
            removed=$((removed + 1))
          else
            echo "skipping $dir (cleanup incomplete)"
          fi
        fi
        ;;
    esac
    release_pr_operation_lock
  done

  if [ "$removed" -eq 0 ]; then
    if [ "$dry_run" = "true" ]; then
      echo "No merged/closed PR worktrees eligible for removal."
    else
      echo "No merged/closed PR worktrees removed."
    fi
  fi
}

pr_number_from_worktree_dir() {
  local dir="$1"
  local basename=${dir##*/}
  local token=${basename#pr-}
  [ "$basename" != "$token" ] || return 1
  is_canonical_pr_number "$token" || return 1
  printf '%s\n' "$token"
}
