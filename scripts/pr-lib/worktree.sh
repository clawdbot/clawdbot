# Shell-local operation state, never inherited freshness from the environment.
unset PR_MAIN_SHA
PR_MAIN_SHA=""

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

ensure_full_pr_worktree_checkout() {
  local sparse_checkout
  # An unset key (exit 1) is normal; other Git failures must not skip materialization.
  sparse_checkout=$(git config --bool core.sparseCheckout 2>/dev/null) || [ "$?" -eq 1 ] || return 1
  if [ "$sparse_checkout" = "true" ]; then
    # Prepare gates build the whole repository. Inherited sparse settings can
    # omit tracked transitive inputs and turn healthy PRs into false failures.
    git sparse-checkout disable
  fi
}

refuse_review_transition() {
  local pr="$1"
  local reason="$2"
  echo "Refusing scripts/pr transition for PR #$pr: $reason" >&2
  git status --short >&2
  return 1
}

require_no_foreign_untracked() {
  local pr="$1"
  local foreign=()
  local file
  while IFS= read -r -d '' file; do
    case "$file" in
      .local|.local/*) ;;
      *) foreign+=("$file") ;;
    esac
  done < <(git ls-files --others --exclude-standard -z)
  [ "${#foreign[@]}" -eq 0 ] || refuse_review_transition "$pr" "untracked files are not owned by scripts/pr."
}

require_no_ignored_transition_paths() {
  local pr="$1"
  local source="$2"
  local target="$3"
  local file ignored
  while IFS= read -r -d '' file; do
    case "$file" in
      .local|.local/*)
        refuse_review_transition "$pr" "the journaled transition touches the reserved .local artifact namespace."
        return 1
        ;;
    esac
  done < <(git diff --name-only --no-renames -z "$source" "$target")

  # Ask Git about every transition path at once. Per-path ignored-file scans
  # become prohibitively slow when a PR is far behind main.
  if IFS= read -r -d '' ignored < <(
    git check-ignore -z --stdin < <(git diff --name-only --no-renames -z "$source" "$target") |
      while IFS= read -r -d '' candidate; do
        # check-ignore also reports matching paths that do not exist. Only an
        # existing ignored entry can be overwritten by the transition.
        if [ -e "$candidate" ] || [ -L "$candidate" ]; then
          printf '%s\0' "$candidate"
        fi
      done
  ); then
    refuse_review_transition "$pr" "ignored file '$ignored' would be overwritten by the journaled transition."
    return 1
  fi
}

validate_review_transition_state() {
  local pr="$1"
  local source="$2"
  local target="$3"
  local current
  current=$(git rev-parse HEAD)
  if { [ "$current" != "$source" ] && [ "$current" != "$target" ]; } ||
    [ -n "$(git ls-files -u)" ] || ! git diff --quiet ||
    ! require_no_foreign_untracked "$pr"
  then
    refuse_review_transition "$pr" "the journaled transition state is ambiguous."
    return 1
  fi
  require_no_ignored_transition_paths "$pr" "$source" "$target" || return 1

  # A path changed from source is owned only when its index mode and blob match target.
  local file
  while IFS= read -r -d '' file; do
    if ! git diff --cached --quiet "$target" -- ":(literal)$file"; then
      refuse_review_transition "$pr" "'$file' is neither its journaled source nor target entry."
      return 1
    fi
  done < <(git diff --cached --name-only --no-renames -z "$source")
}

write_review_transition_journal() {
  local pr="$1"
  local source="$2"
  local target="$3"
  local mode="$4"
  local branch="$5"
  mkdir -p .local
  local journal=.local/review-transition.json
  local pending
  pending=$(mktemp "$journal.XXXXXX") || return 1
  if jq -cn --argjson pr "$pr" --arg source "$source" --arg target "$target" \
    --arg mode "$mode" --arg branch "$branch" \
    '{version:1,pr:$pr,source:$source,target:$target,mode:$mode,branch:(if $mode == "branch" then $branch else null end)}' \
    >"$pending" && mv "$pending" "$journal"
  then
    return 0
  fi
  rm -f "$pending"
  return 1
}

recover_review_transition() {
  local pr="$1"
  local journal=.local/review-transition.json
  [ -e "$journal" ] || return 0

  local fields source target mode branch
  fields=$(jq -er --argjson pr "$pr" '
    select(type == "object" and (keys | sort) == ["branch","mode","pr","source","target","version"])
    | select(.version == 1 and .pr == $pr)
    | select((.source | type == "string" and test("^[0-9a-f]{40}$")) and (.target | type == "string" and test("^[0-9a-f]{40}$")))
    | select((.mode == "detached" and .branch == null) or (.mode == "branch" and (.branch | type == "string")))
    | [.source,.target,.mode,(.branch // "")] | @tsv
  ' "$journal" 2>/dev/null) || {
    refuse_review_transition "$pr" "the transition journal is invalid."
    return 1
  }
  IFS=$'\t' read -r source target mode branch <<<"$fields"
  if ! git cat-file -e "$source^{commit}" 2>/dev/null ||
    ! git cat-file -e "$target^{commit}" 2>/dev/null ||
    { [ "$mode" = "branch" ] && [ "$branch" != "temp/pr-$pr" ]; }
  then
    refuse_review_transition "$pr" "the transition journal names an invalid endpoint or branch."
    return 1
  fi

  validate_review_transition_state "$pr" "$source" "$target" || return 1
  # Completed deletions are absent from both index and target, so replay only
  # remaining entries rather than passing already-removed paths to restore.
  if ! git diff --cached --quiet "$target"; then
    git diff --cached --name-only --no-renames -z "$target" |
      git --literal-pathspecs restore --source="$target" --staged --worktree \
        --pathspec-from-file=- --pathspec-file-nul || return 1
  fi
  if [ "$(git write-tree)" != "$(git rev-parse "$target^{tree}")" ] || ! git diff --quiet; then
    refuse_review_transition "$pr" "the tracked tree did not reach the journaled target."
    return 1
  fi
  if [ "$mode" = "branch" ]; then
    git checkout -B "$branch" "$target" || return 1
  else
    git checkout --detach "$target" || return 1
  fi

  local actual_branch
  actual_branch=$(git branch --show-current)
  if [ "$(git rev-parse HEAD)" != "$target" ] || ! git diff --quiet || ! git diff --cached --quiet ||
    { [ "$mode" = "branch" ] && [ "$actual_branch" != "$branch" ]; } ||
    { [ "$mode" = "detached" ] && [ -n "$actual_branch" ]; } ||
    ! require_no_foreign_untracked "$pr"
  then
    refuse_review_transition "$pr" "the journaled transition did not complete cleanly."
    return 1
  fi
  rm -f "$journal"
}

checkout_pr_worktree_target() {
  local pr="$1"
  local target_ref="$2"
  local branch="${3:-}"
  recover_review_transition "$pr" || return 1
  if [ -n "$(git ls-files -u)" ] || ! git diff --quiet || ! git diff --cached --quiet ||
    ! require_no_foreign_untracked "$pr"
  then
    refuse_review_transition "$pr" "foreign state blocks a new transition."
    return 1
  fi

  local source target mode=detached
  source=$(git rev-parse HEAD) || return 1
  target=$(git rev-parse "$target_ref^{commit}") || return 1
  require_no_ignored_transition_paths "$pr" "$source" "$target" || return 1
  [ -z "$branch" ] || mode=branch
  write_review_transition_journal "$pr" "$source" "$target" "$mode" "$branch" || return 1
  recover_review_transition "$pr"
}

fetch_canonical_main() {
  local root source git_dir
  root=$(repo_root) || return 1
  source=$(git -C "$root" remote get-url origin) || return 1
  git_dir=$(git rev-parse --absolute-git-dir) || return 1
  # Resolve relative URLs at the canonical root; ignore worktree origin/refmaps.
  git -C "$root" --git-dir="$git_dir" fetch --no-tags --refmap= "$source" \
    +refs/heads/main:refs/remotes/origin/main
}

refresh_main_snapshot() {
  # The PR lock owns this worktree's FETCH_HEAD, not the shared origin/main ref.
  # Capture immediately: subsequent PR-head fetches overwrite FETCH_HEAD.
  PR_MAIN_SHA=""
  local sha
  fetch_canonical_main || return 1
  sha=$(git rev-parse --verify 'FETCH_HEAD^{commit}') || return 1
  PR_MAIN_SHA="$sha"
}

enter_worktree() {
  # OR-list callers disable errexit throughout this function; guard required steps explicitly.
  local pr="$1"
  local reset_to_main="${2:-false}"
  local invoke_cwd
  invoke_cwd="$PWD"
  local root
  root=$(repo_root) || return 1

  if [ "$invoke_cwd" != "$root" ]; then
    echo "Detected non-root invocation cwd=$invoke_cwd, using canonical root $root"
  fi

  cd "$root" || return 1
  ensure_gh_api_auth || { PR_MAIN_SHA=""; return 1; }
  # Fetch can launch helpers and mutate Git state even when it fails; leave validation first.
  mark_pr_operation_side_effects_started || return 1

  # Resolve through the parent, never through the leaf: a missing directory has
  # no real path of its own, and resolving a leaf symlink would silently adopt
  # whichever worktree it aliases.
  local dir="$root/.worktrees/pr-$pr"
  local resolved_parent resolved_dir="" initialized_sha=""
  resolved_parent=$(resolve_existing_dir_path "$(dirname "$dir")" 2>/dev/null || true)
  [ -z "$resolved_parent" ] || resolved_dir="$resolved_parent/pr-$pr"

  if [ ! -d "$dir" ] || [ -z "$resolved_dir" ] || ! worktree_is_registered "$resolved_dir"; then
    if [ -e "$dir" ] || { [ -n "$resolved_dir" ] && worktree_is_registered "$resolved_dir"; }; then
      require_worktree_cleanup_evidence "$dir" || return 1
      echo "Pruning stale worktree registration for .worktrees/pr-$pr"
      git -C "$root" worktree prune || return 1
      remove_worktree_if_present "$dir" || return 1
      [ ! -e "$dir" ] || {
        echo "Refusing scripts/pr operation for PR #$pr: $dir is not a registered worktree and could not be cleared; scripts/pr refuses to mutate the shared canonical checkout." >&2
        return 1
      }
    fi
    # Cold bootstrap needs one extra fetch before private FETCH_HEAD exists.
    # Initialize fully before the next network wait so interruption is retryable.
    # This shared main ref is only a seed, never the operation's snapshot.
    PR_MAIN_SHA=""
    fetch_canonical_main || return 1
    git -C "$root" worktree add -B "temp/pr-$pr" "$dir" refs/remotes/origin/main || return 1
    resolved_parent=$(resolve_existing_dir_path "$(dirname "$dir")") || return 1
    resolved_dir="$resolved_parent/pr-$pr"
    initialized_sha=$(git -C "$dir" rev-parse --verify HEAD) || return 1
  fi

  cd "$resolved_dir" || return 1

  # Containment, not repair: every mutation below runs against ambient cwd, so
  # prove Git resolves it to this worktree before any branch moves. A directory
  # that is not a worktree lets discovery escape up into the shared canonical
  # checkout, where a sibling session's branch would be clobbered.
  local actual_toplevel
  actual_toplevel=$(resolve_existing_dir_path "$(git rev-parse --path-format=absolute --show-toplevel 2>/dev/null)" 2>/dev/null || true)
  if [ "$actual_toplevel" != "$resolved_dir" ]; then
    echo "Refusing scripts/pr operation for PR #$pr: expected worktree $resolved_dir, Git resolved ${actual_toplevel:-no repository}; scripts/pr refuses to mutate the shared canonical checkout." >&2
    return 1
  fi

  [ -n "$PR_MAIN_SHA" ] || refresh_main_snapshot || return 1
  recover_review_transition "$pr" || return 1
  ensure_full_pr_worktree_checkout || return 1
  # Explicit resets still validate foreign state, even when the seed matches.
  # Otherwise a new temp branch needs a transition only if main moved.
  if [ "$reset_to_main" = true ] ||
    { [ -n "$initialized_sha" ] && [ "$initialized_sha" != "$PR_MAIN_SHA" ]; }; then
    checkout_pr_worktree_target "$pr" "$PR_MAIN_SHA" "temp/pr-$pr" || return 1
  fi
  mkdir -p .local
}

pr_meta_json() {
  local pr="$1"
  local metadata files expected_file_count actual_file_count head_before head_after head_after_json
  metadata=$(read_pr_view_json "$pr" "number,title,state,isDraft,author,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,url,body,labels,assignees,changedFiles,additions,deletions,statusCheckRollup,files") || return 1
  head_before=$(pr_view_string_field "$metadata" "headRefOid" "$pr" "Retry review initialization.") || return 1
  if ! expected_file_count=$(printf '%s\n' "$metadata" | jq -er '.changedFiles | if type == "number" and . >= 0 and . == floor then . else error("invalid changed file count") end' 2>/dev/null); then
    echo "Invalid PR metadata for #$pr: changedFiles must be a non-negative integer." >&2
    return 1
  fi

  # `gh pr view --json files` is cacheable but stops at 100 entries. Use it
  # when complete; only large or incomplete responses spend uncached REST quota.
  files='[]'
  if [ "$expected_file_count" -le 100 ]; then
    files=$(printf '%s\n' "$metadata" | jq -c '
      .files
      | if type == "array"
          and all(.[];
            (.path | type == "string")
            and (.additions | type == "number")
            and (.deletions | type == "number")
            and (.changeType | type == "string" and length > 0)
          )
        then map({
            path: .path,
            additions: .additions,
            deletions: .deletions,
            changeType: (
              if (.changeType | ascii_downcase) == "removed"
                or (.changeType | ascii_downcase) == "deleted"
              then "DELETED"
              else (.changeType | ascii_upcase)
              end
            )
          })
        else []
        end
    ' 2>/dev/null || printf '[]')
  fi

  actual_file_count=$(printf '%s\n' "$files" | jq -r 'length')
  if [ "$actual_file_count" -ne "$expected_file_count" ]; then
    local repo_nwo
    repo_nwo=$(gh_plain repo view --json nameWithOwner --jq .nameWithOwner) || return 1
    # Pin the base repository and revalidate every page before the final head check.
    if ! files=$(
      set -o pipefail
      gh_plain api --paginate "repos/$repo_nwo/pulls/$pr/files?per_page=100" -H 'Cache-Control: max-age=0' |
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
  fi

  head_after_json=$(read_pr_view_json "$pr" "headRefOid") || return 1
  head_after=$(pr_view_string_field "$head_after_json" "headRefOid" "$pr" "Retry review initialization.") || return 1
  if [ "$head_after" != "$head_before" ]; then
    echo "PR head changed while collecting file metadata for #$pr (started at $head_before, ended at $head_after). Retry review initialization." >&2
    return 1
  fi

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
        if ! require_worktree_cleanup_evidence "$dir"; then
          echo "skipping $dir (merge evidence preserved)"
        elif [ "$dry_run" = "true" ]; then
          echo "would remove $dir (PR #$pr state=$state)"
          removed=$((removed + 1))
        elif cleanup_pr_worktree "$dir"; then
          echo "removed $dir (PR #$pr state=$state)"
          removed=$((removed + 1))
        else
          echo "skipping $dir (cleanup incomplete)"
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
