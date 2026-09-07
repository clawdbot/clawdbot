# Remote outcome outlives the process lock and all disposable prepare artifacts.
# These private commits retain the actual head/main/landed objects as parents;
# textual OIDs in a blob alone would not keep historical proof alive through GC.
merge_outcome_stop() {
  echo "Merge outcome: $*" >&2
  echo "No automatic merge retry. Repeated merge-run only reconciles a recorded attempt. Inspect the PR timeline, main history, and $MERGE_OUTCOME_REF; a new attempt requires explicit operator recovery through merge-recover." >&2
  return 1
}

merge_outcome_repo_identity() {
  # gh returns the repository's REST database id as a JSON number while PR ids are
  # GraphQL node strings. Accept either scalar so a current gh cannot fail admission
  # closed; nameWithOwner and the url suffix still pin which repository this is.
  jq -ce '
    . as $repo | select((.id | (type == "string" and length > 0) or type == "number") and
      (.nameWithOwner | test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")) and
      (.url | test("^https://[A-Za-z0-9.-]+/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") and endswith("/" + $repo.nameWithOwner)))
  '
}

merge_outcome_init() {
  local pr="$1" identity
  is_canonical_pr_number "$pr" || return 1
  MERGE_OUTCOME_REF="refs/openclaw/pr-merge-outcomes/$pr"
  identity=$(gh_plain repo view --json id,nameWithOwner,url) || return 1
  MERGE_REPO=$(printf '%s\n' "$identity" | merge_outcome_repo_identity) || { merge_outcome_stop "invalid repository identity"; return 1; }
  MERGE_REPO_URL=$(printf '%s\n' "$MERGE_REPO" | jq -r .url)
  MERGE_REPO_HOST="${MERGE_REPO_URL#https://}"
  MERGE_REPO_HOST="${MERGE_REPO_HOST%%/*}"
  MERGE_REPO_NAME=$(printf '%s\n' "$MERGE_REPO" | jq -r .nameWithOwner)
  merge_outcome_load_local "$pr" "$MERGE_REPO"
}

# Cleanup validates retained proof locally (Git 2.45+ prevents lazy fetch). Admission also
# supplies the freshly resolved repository identity; local validity is not reconciliation.
merge_outcome_load_local() {
  local pr="$1" expected_repo="${2:-null}"
  is_canonical_pr_number "$pr" || return 1
  MERGE_OUTCOME_REF="refs/openclaw/pr-merge-outcomes/$pr"
  MERGE_OUTCOME_OID=""
  MERGE_OUTCOME_RECORD=""
  if GIT_NO_LAZY_FETCH=1 git symbolic-ref -q "$MERGE_OUTCOME_REF" >/dev/null 2>&1; then
    merge_outcome_stop "symbolic outcome ref; inspect without deleting it"
    return 1
  fi
  local ref_status=0
  if MERGE_OUTCOME_OID=$(GIT_NO_LAZY_FETCH=1 git rev-parse --verify "$MERGE_OUTCOME_REF" 2>/dev/null); then
    local parents retained
    [ "$(GIT_NO_LAZY_FETCH=1 git cat-file -t "$MERGE_OUTCOME_OID")" = commit ] || { merge_outcome_stop "outcome ref is not a commit"; return 1; }
    MERGE_OUTCOME_RECORD=$(GIT_NO_LAZY_FETCH=1 git show "$MERGE_OUTCOME_OID:outcome.json" | jq -ce \
      --argjson repo "$expected_repo" --argjson pr "$pr" '
      def oid: type == "string" and test("^[0-9a-f]{40}$");
      def attempt: type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$");
      def recovery:
        if has("recovery") then . as $record | .recovery |
          type == "object" and
          ((keys == ["actor","attempt","outcome","reason"]) or
           (keys == ["actor","attempt","outcome","reason","replacementHead"] and
            (.replacementHead | oid) and .replacementHead == $record.head)) and
          (.outcome | oid) and (.attempt | attempt) and
          (.actor | type == "string" and length > 0) and .reason == "explicit-operator-recovery"
        else true end;
      select(.version == 1 and ($repo == null or .repo == $repo) and .pr == $pr and .base == "main" and
        (.prId | type == "string" and length > 0) and (.head | oid) and (.main | oid) and
        (.attempt | attempt) and recovery and
        (.method == "squash" or .method == "merge" or .method == "rebase") and
        (.route == "immediate" or .route == "admin" or .route == "auto" or .route == "queue") and
        (.accepted | type == "boolean") and
        (if .phase == "intent" then .landed == null else
          (.phase == "merged" or .phase == "commenting" or .phase == "commented" or .phase == "complete") and (.landed | oid) end))
    ') || { merge_outcome_stop "corrupt or mismatched retained record"; return 1; }
    printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c .repo | merge_outcome_repo_identity >/dev/null || {
      merge_outcome_stop "invalid retained repository identity"; return 1;
    }
    parents=$(GIT_NO_LAZY_FETCH=1 git cat-file commit "$MERGE_OUTCOME_OID" | awk 'NF == 0 {exit} $1 == "parent" {printf "%s ", $2}') || return 1
    for retained in $(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r '[.head,.main,.landed] | .[] | select(. != null)'); do
      case " $parents " in *" $retained "*) ;; *) merge_outcome_stop "record does not retain required commit $retained"; return 1 ;; esac
      GIT_NO_LAZY_FETCH=1 git cat-file -e "$retained^{commit}" || { merge_outcome_stop "required historical commit $retained is unavailable"; return 1; }
    done
    if printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -e 'has("recovery")' >/dev/null; then
      retained=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .recovery.outcome)
      if ! GIT_NO_LAZY_FETCH=1 git merge-base --is-ancestor "$retained" "$MERGE_OUTCOME_OID" ||
        ! GIT_NO_LAZY_FETCH=1 git show "$retained:outcome.json" | jq -e --argjson next "$MERGE_OUTCOME_RECORD" '
          .phase == "intent" and .accepted == false and .route == "immediate" and
          .repo == $next.repo and .pr == $next.pr and .prId == $next.prId and
          .base == $next.base and .method == $next.method and .attempt == $next.recovery.attempt and
          $next.route == "immediate" and (.head == $next.head or $next.recovery.replacementHead == $next.head)
        ' >/dev/null; then
        merge_outcome_stop "invalid or unretained operator recovery provenance"; return 1
      fi
    fi
  else
    GIT_NO_LAZY_FETCH=1 git show-ref --verify --quiet "$MERGE_OUTCOME_REF" 2>/dev/null || ref_status=$?
    [ "$ref_status" -eq 1 ] || { merge_outcome_stop "unreadable outcome ref"; return 1; }
  fi
}

merge_outcome_write() {
  local record="$1" blob tree next parent entries capture
  shift
  mark_pr_operation_side_effects_started || return 1
  local parents=()
  for parent in $(printf '%s\n' "$record" | jq -r '[.head,.main,.landed] | unique | .[] | select(. != null)'); do
    parents+=(-p "$parent")
  done
  [ -z "$MERGE_OUTCOME_OID" ] || parents+=(-p "$MERGE_OUTCOME_OID")
  blob=$(printf '%s\n' "$record" | git hash-object -w --stdin) || return 1
  entries=$(printf '100644 blob %s\toutcome.json\n' "$blob")
  # Replacement intent retains old captures as blobs before cleanup can remove
  # the worktree. Later receipts retain this tree through their outcome parents.
  for capture in "$@"; do
    [ -f "$capture" ] && [ ! -L "$capture" ] || { merge_outcome_stop "cannot retain non-regular capture $capture"; return 1; }
    blob=$(git hash-object -w --no-filters -- "$capture") || return 1
    entries+=$'\n'"$(printf '100644 blob %s\t%s' "$blob" "${capture##*/}")"
  done
  tree=$(printf '%s\n' "$entries" | git mktree) || return 1
  next=$(printf 'Native PR merge outcome\n' | git -c commit.gpgsign=false commit-tree "$tree" "${parents[@]}") || return 1
  if git symbolic-ref -q "$MERGE_OUTCOME_REF" >/dev/null 2>&1 ||
    ! git update-ref --no-deref "$MERGE_OUTCOME_REF" "$next" "${MERGE_OUTCOME_OID:-$(pr_operation_lock_zero_oid)}"; then
    merge_outcome_stop "outcome owner changed; preserved successor, no dispatch or completion action"
    return 1
  fi
  MERGE_OUTCOME_OID="$next"
  MERGE_OUTCOME_RECORD="$record"
}

merge_outcome_read_remote() {
  local response
  response=$(gh_plain api graphql --hostname "$MERGE_REPO_HOST" \
    -f owner="${MERGE_REPO_NAME%/*}" -f name="${MERGE_REPO_NAME#*/}" -F number="$1" \
    -f 'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){id databaseId url nameWithOwner ref(qualifiedName:"refs/heads/main"){target{oid}} pullRequest(number:$number){id number url state headRefOid baseRefName isDraft mergeCommit{oid} autoMergeRequest{mergeMethod} isInMergeQueue isMergeQueueEnabled mergeable mergeStateStatus}}}') || return 1
  printf '%s\n' "$response" | jq -ce --argjson repo "$MERGE_REPO" --argjson pr "$1" '
    def oid: type == "string" and test("^[0-9a-f]{40}$");
    select(.errors == null) | .data.repository |
    # gh reports the repository id as its REST database id while GraphQL reports the node
    # id, so the two sources never compare equal on identity alone. Match whichever
    # representation gh supplied; url and nameWithOwner still pin the repository exactly.
    select(.url == $repo.url and .nameWithOwner == $repo.nameWithOwner and
      ($repo.id == .id or $repo.id == .databaseId) and (.ref.target.oid | oid)) |
    {main:.ref.target.oid, pr:.pullRequest} |
    select(.pr.number == $pr and (.pr.id | type == "string" and length > 0) and
      .pr.url == ($repo.url + "/pull/" + ($pr|tostring)) and
      (.pr.headRefOid | oid) and (.pr.baseRefName | type == "string" and length > 0) and
      (.pr.isDraft | type == "boolean") and (.pr.isInMergeQueue | type == "boolean") and
      (.pr.isMergeQueueEnabled | type == "boolean") and
      (.pr.mergeable == "MERGEABLE" or .pr.mergeable == "CONFLICTING" or .pr.mergeable == "UNKNOWN") and
      (.pr.mergeStateStatus | type == "string" and length > 0) and (.pr | has("autoMergeRequest")) and
      (.pr.autoMergeRequest == null or (.pr.autoMergeRequest.mergeMethod | IN("SQUASH","MERGE","REBASE"))) and
      (.pr | has("mergeCommit")) and
      (if .pr.state == "MERGED" then (.pr.mergeCommit.oid | oid) else
        (.pr.state == "OPEN" or .pr.state == "CLOSED") and .pr.mergeCommit == null end))
  '
}

merge_outcome_require_main() {
  local oid="$1"
  # Fetch immutable objects only. Do not replace a pinned observation with the
  # moving origin/main tracking ref or FETCH_HEAD.
  if ! GIT_NO_LAZY_FETCH=1 git cat-file -e "$oid^{commit}" 2>/dev/null; then
    git fetch --no-tags --no-write-fetch-head "$MERGE_REPO_URL" "$oid" || { merge_outcome_stop "cannot fetch authoritative main $oid"; return 1; }
  fi
  GIT_NO_LAZY_FETCH=1 git cat-file -e "$oid^{commit}"
}

merge_outcome_observe() {
  MERGE_OBSERVATION=$(merge_outcome_read_remote "$1") || {
    merge_outcome_stop "authoritative PR/main metadata unavailable or invalid"; return 1;
  }
  merge_outcome_require_main "$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r .main)"
}

merge_outcome_stable() {
  local reread main
  reread=$(merge_outcome_read_remote "$1") || return 1
  [ "$reread" = "$MERGE_OBSERVATION" ] && return 0
  # Only finish an already-proven MERGED receipt; this never admits a future merge.
  # Keep both snapshots pinned: later forward work cannot restart historical proof.
  if printf '%s\n' "$reread" | jq -e --argjson observed "$MERGE_OBSERVATION" '
    .pr.state == "MERGED" and .pr == $observed.pr
  ' >/dev/null; then
    main=$(printf '%s\n' "$reread" | jq -r .main)
    merge_outcome_require_main "$main" || return 1
    git merge-base --is-ancestor "$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r .main)" "$main" && return 0
  fi
  merge_outcome_stop "PR or main changed during observation; rerun for read-only reconciliation if intent exists"
}

merge_outcome_reconcile() {
  local pr="$1" head state landed method route parent source_base tree phase
  merge_outcome_observe "$pr" || return 1
  head=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .head)
  if ! printf '%s\n' "$MERGE_OBSERVATION" | jq -e --argjson record "$MERGE_OUTCOME_RECORD" '
    .pr.id == $record.prId and .pr.headRefOid == $record.head and .pr.baseRefName == $record.base
  ' >/dev/null; then
    merge_outcome_stop "PR identity/head/base drift from the retained attempt"; return 1
  fi
  state=$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r .pr.state)
  phase=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .phase)
  if [ "$state" != MERGED ]; then
    merge_outcome_stable "$pr" || return 1
    if [ "$phase" = intent ] && [ "$state" = OPEN ] &&
      printf '%s\n' "$MERGE_OBSERVATION" | jq -e '.pr.isInMergeQueue or .pr.autoMergeRequest != null' >/dev/null; then
      echo "AUTO/QUEUE PENDING for PR #$pr; not merged. Retained expected head $head; no re-arm, cancellation, or immediate fallback."
      echo "Run scripts/pr merge-run $pr again to reconcile only; inspect GitHub queue/auto status if it does not complete."
      [ "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .accepted)" = true ] && return 0
    fi
    merge_outcome_stop "prior dispatch unresolved (state=$state, phase=$phase); OPEN, process death, head changes, and elapsed time do not prove non-execution"
    return 1
  fi
  landed=$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r .pr.mergeCommit.oid)
  git merge-base --is-ancestor "$landed" "$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r .main)" || {
    merge_outcome_stop "reported landed commit is unavailable or not reachable from authoritative main"; return 1;
  }
  method=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .method)
  route=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .route)
  local merge_inputs=()
  if [ "$method" = rebase ] || [ "$route" = queue ]; then
    # A rebase's final parent can be a rewritten prefix; queue policy can rebase
    # regardless of requested method. Anchor the whole source delta at its fork,
    # not recorded main (which may already contain a cherry-picked prefix).
    source_base=$(git merge-base --all "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .main)" "$head") &&
      [[ "$source_base" =~ ^[0-9a-f]{40}$ ]] || {
      merge_outcome_stop "require one source fork base between retained main/head for $method/$route; base missing, unavailable, or ambiguous"; return 1;
    }
    merge_inputs=(--merge-base="$source_base" "$landed" "$head")
  else
    parent=$(git rev-parse "$landed^1") || return 1
    if [ "$method" = merge ] && ! git merge-base --is-ancestor "$head" "$landed"; then
      merge_outcome_stop "landed merge does not retain prepared-head ancestry"; return 1
    fi
    merge_inputs=("$parent" "$head")
  fi
  tree=$(git merge-tree --write-tree "${merge_inputs[@]}") || {
    merge_outcome_stop "cannot reconstruct $method/$route landed tree at $landed"; return 1;
  }
  [ "$tree" = "$(git rev-parse "$landed^{tree}")" ] || {
    merge_outcome_stop "landed tree does not match the prepared source ($method/$route)"; return 1;
  }
  merge_outcome_stable "$pr" || return 1
  if [ "$phase" = intent ]; then
    merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c --arg landed "$landed" '.phase="merged" | .landed=$landed')" || return 1
  elif [ "$landed" != "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .landed)" ]; then
    merge_outcome_stop "remote merge receipt differs from the retained receipt"; return 1
  fi
  if [ "$method" = squash ] && [ "$route" != queue ] && [ "$tree" = "$(git rev-parse "$parent^{tree}")" ]; then
    echo "Warning: recorded squash has no net change at its landed parent ($landed). Inspect main/PR history; receipt retained, no resubmission or automatic revert." >&2
  fi
  echo "MERGED exact attempted head $head as $landed; receipt retained at $MERGE_OUTCOME_REF."
}

merge_outcome_find_comment() {
  local pr="$1" comments marker matches
  MERGE_COMPLETION_COMMENT_URL=""
  marker="<!-- openclaw-merge:$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .attempt) -->"
  comments=$(gh_plain api --hostname "$MERGE_REPO_HOST" --paginate --slurp \
    "repos/$MERGE_REPO_NAME/issues/$pr/comments?per_page=100" -H 'Cache-Control: max-age=0') || return 1
  matches=$(printf '%s\n' "$comments" | jq -ce --arg marker "$marker" \
    '[.[][] | select(.body | contains($marker))] | if length <= 1 then . else error("ambiguous completion marker") end') || return 1
  if [ "$matches" != '[]' ]; then
    MERGE_COMPLETION_COMMENT_URL=$(printf '%s\n' "$matches" | jq -er '.[0].html_url | select(type == "string" and length > 0)') || return 1
  fi
}

merge_outcome_comment_body() {
  local pr="$1" head landed method route label
  head=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .head) || return 1
  landed=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .landed) || return 1
  method=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .method) || return 1
  route=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .route) || return 1
  case "$route:$method" in
    admin:*) label="admin squash with trusted Crabbox infrastructure proof" ;;
    queue:*) label="merge queue (requested $method)" ;;
    auto:*) label="squash auto-merge" ;;
    immediate:merge) label="merge commit" ;;
    *) label="$method" ;;
  esac
  printf 'Merged via %s.\n\n- Prepared head SHA: [%s](%s/pull/%s/commits/%s)\n- Landed commit: [%s](%s/commit/%s)' \
    "$label" "$head" "$MERGE_REPO_URL" "$pr" "$head" "$landed" "$MERGE_REPO_URL" "$landed"
}

merge_outcome_post_comment() {
  local pr="$1" body="$2"
  body+=$'\n\n'"<!-- openclaw-merge:$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .attempt) -->"
  # Persist intent before POST: an interrupted or lost reply is lookup-only on recovery.
  merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c '.phase="commenting"')" || return 1
  if ! MERGE_COMPLETION_COMMENT_URL=$(gh_plain api --hostname "$MERGE_REPO_HOST" --method POST \
    "repos/$MERGE_REPO_NAME/issues/$pr/comments" --raw-field "body=$body" --jq '.html_url // empty') ||
    [ -z "$MERGE_COMPLETION_COMMENT_URL" ]; then
    echo "Merge confirmed; completion comment outcome uncertain. No second POST or cleanup. Run scripts/pr merge-run $pr for read-only reconciliation."
    return 1
  fi
  merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c '.phase="commented"')"
}

merge_outcome_head_branch() {
  local pr="$1" head_json
  head_json=$(gh_plain pr view "$pr" --repo "$MERGE_REPO_URL" --json headRefOid,headRefName,headRepository,headRepositoryOwner) || return 1
  MERGE_HEAD_REF=$(printf '%s\n' "$head_json" | jq -er --arg head "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .head)" \
    'select(.headRefOid == $head) | .headRefName | select(type == "string" and length > 0)') || return 1
  MERGE_HEAD_REPO=$(printf '%s\n' "$head_json" | jq -er '.headRepositoryOwner.login + "/" + .headRepository.name | select(test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"))') || return 1
  git check-ref-format "refs/heads/$MERGE_HEAD_REF"
}

merge_outcome_require_cleanup_absent() {
  local pr="$1" root worktrees branch ref_status=0
  root=$(repo_root) || return 1
  worktrees=$(git worktree list --porcelain) || return 1
  if [ -e "$root/.worktrees/pr-$pr" ] || [ -L "$root/.worktrees/pr-$pr" ] ||
    printf '%s\n' "$worktrees" | grep -Fxq "worktree $root/.worktrees/pr-$pr"; then
    echo "Completion requires the native worktree to be absent; inspect its ownership before cleanup." >&2
    return 1
  fi
  merge_outcome_head_branch "$pr" || return 1
  for branch in "temp/pr-$pr" "pr-$pr" "pr-$pr-prep"; do
    ref_status=0
    git show-ref --verify --quiet "refs/heads/$branch" || ref_status=$?
    [ "$ref_status" -eq 1 ] || { echo "Completion requires local branch $branch to be absent; no deletion attempted." >&2; return 1; }
  done
  ref_status=0
  git ls-remote --exit-code --refs "https://$MERGE_REPO_HOST/$MERGE_HEAD_REPO.git" "refs/heads/$MERGE_HEAD_REF" >/dev/null || ref_status=$?
  [ "$ref_status" -eq 2 ] || { echo "Completion requires authoritative remote branch absence; no deletion attempted." >&2; return 1; }
}

merge_complete() {
  local pr="$1" expected_oid="$2" phase body
  local MERGE_OUTCOME_REF MERGE_OUTCOME_OID MERGE_OUTCOME_RECORD MERGE_REPO
  local MERGE_REPO_URL MERGE_REPO_HOST MERGE_REPO_NAME MERGE_OBSERVATION
  local MERGE_HEAD_REF MERGE_HEAD_REPO MERGE_COMPLETION_COMMENT_URL
  merge_outcome_init "$pr" || return 1
  if [ "$MERGE_OUTCOME_OID" != "$expected_oid" ] ||
    ! printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -e '.phase != "intent"' >/dev/null; then
    merge_outcome_stop "completion requires the exact verified merge receipt; reconcile pending intent first"
    return 1
  fi
  merge_outcome_reconcile "$pr" || return 1
  phase=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .phase) || return 1
  if [ "$phase" = complete ]; then
    echo "merge-complete already complete for PR #$pr; no side effects."
    return 0
  fi
  # Delayed completion only observes cleanup; it never deletes recreated resources.
  merge_outcome_require_cleanup_absent "$pr" || return 1
  if [ "$phase" = merged ] && [ "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .route)" = admin ]; then
    echo "Admin completion requires its original landing audit before a first comment; preserve the receipt for owner review." >&2
    return 1
  fi
  merge_outcome_find_comment "$pr" || return 1
  if [ -n "$MERGE_COMPLETION_COMMENT_URL" ]; then
    merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c '.phase="commented"')" || return 1
  elif [ "$phase" = merged ]; then
    body=$(merge_outcome_comment_body "$pr") || return 1
    merge_outcome_post_comment "$pr" "$body" || return 1
  else
    echo "Completion comment is missing or uncertain; no second POST. Inspect the recorded attempt marker." >&2
    return 1
  fi
  merge_outcome_require_cleanup_absent "$pr" || return 1
  merge_outcome_stable "$pr" || return 1
  merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c '.phase="complete"')" || return 1
  echo "merge-complete complete for PR #$pr"
  echo "completion comment: $MERGE_COMPLETION_COMMENT_URL"
}

merge_outcome_resume() {
  local pr="$1" phase MERGE_COMPLETION_COMMENT_URL
  merge_outcome_reconcile "$pr" || return 1
  phase=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .phase)
  [ "$phase" != intent ] || return 0
  if [ "$phase" = commenting ]; then
    # Absence never permits a second POST: the first response may have been lost.
    if merge_outcome_find_comment "$pr" && [ -n "$MERGE_COMPLETION_COMMENT_URL" ]; then
      echo "Completion comment observed: $MERGE_COMPLETION_COMMENT_URL"
      merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c '.phase="commented"')" || return 1
    fi
  fi
  if [ "$phase" = complete ]; then
    echo "merge-run already complete for PR #$pr; no side effects."
  else
    echo "Merge confirmed; completion pending. Recovery does not repeat comment POST or cleanup. Inspect the completion marker in PR comments and any remaining .worktrees/pr-$pr/local branches; verify their ownership before manual cleanup."
    echo "After cleanup, explicitly finalize: scripts/pr merge-complete $pr $MERGE_OUTCOME_OID --confirmed-operator-completion"
  fi
}
