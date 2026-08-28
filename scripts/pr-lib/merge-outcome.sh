# Remote outcome outlives the process lock and all disposable prepare artifacts.
# These private commits retain the actual head/main/landed objects as parents;
# textual OIDs in a blob alone would not keep historical proof alive through GC.
merge_outcome_stop() {
  echo "Merge outcome: $*" >&2
  echo "No merge retry. Repeated merge-run only reconciles a recorded attempt. Inspect the PR timeline, main history, and $MERGE_OUTCOME_REF; unresolved uncertainty requires operator action outside this automatic path." >&2
  return 1
}

merge_outcome_init() {
  local pr="$1" identity
  is_canonical_pr_number "$pr" || return 1
  MERGE_OUTCOME_REF="refs/openclaw/pr-merge-outcomes/$pr"
  identity=$(gh_plain repo view --json id,nameWithOwner,url) || return 1
  MERGE_REPO=$(printf '%s\n' "$identity" | jq -ce '
    . as $repo | select((.id | type == "string" and length > 0) and
      (.nameWithOwner | test("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")) and
      (.url | test("^https://[A-Za-z0-9.-]+/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$") and endswith("/" + $repo.nameWithOwner)))
  ') || { merge_outcome_stop "invalid repository identity"; return 1; }
  MERGE_REPO_URL=$(printf '%s\n' "$MERGE_REPO" | jq -r .url)
  MERGE_REPO_HOST="${MERGE_REPO_URL#https://}"
  MERGE_REPO_HOST="${MERGE_REPO_HOST%%/*}"
  MERGE_REPO_NAME=$(printf '%s\n' "$MERGE_REPO" | jq -r .nameWithOwner)
  MERGE_OUTCOME_OID=""
  MERGE_OUTCOME_RECORD=""
  if git symbolic-ref -q "$MERGE_OUTCOME_REF" >/dev/null 2>&1; then
    merge_outcome_stop "symbolic outcome ref; inspect without deleting it"
    return 1
  fi
  local ref_status=0
  if MERGE_OUTCOME_OID=$(git rev-parse --verify "$MERGE_OUTCOME_REF" 2>/dev/null); then
    local parents retained
    [ "$(git cat-file -t "$MERGE_OUTCOME_OID")" = commit ] || { merge_outcome_stop "outcome ref is not a commit"; return 1; }
    MERGE_OUTCOME_RECORD=$(git show "$MERGE_OUTCOME_OID:outcome.json" | jq -ce \
      --argjson repo "$MERGE_REPO" --argjson pr "$pr" '
      def oid: type == "string" and test("^[0-9a-f]{40}$");
      select(.version == 1 and .repo == $repo and .pr == $pr and .base == "main" and
        (.prId | type == "string" and length > 0) and (.head | oid) and (.main | oid) and
        (.attempt | test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")) and
        (.method == "squash" or .method == "merge" or .method == "rebase") and
        (.route == "immediate" or .route == "admin" or .route == "auto" or .route == "queue") and
        (.accepted | type == "boolean") and
        (if .phase == "intent" then .landed == null else
          (.phase == "merged" or .phase == "commenting" or .phase == "commented" or .phase == "complete") and (.landed | oid) end))
    ') || { merge_outcome_stop "corrupt or mismatched retained record"; return 1; }
    parents=$(git cat-file commit "$MERGE_OUTCOME_OID" | awk 'NF == 0 {exit} $1 == "parent" {printf "%s ", $2}') || return 1
    for retained in $(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r '[.head,.main,.landed] | .[] | select(. != null)'); do
      case " $parents " in *" $retained "*) ;; *) merge_outcome_stop "record does not retain required commit $retained"; return 1 ;; esac
      git cat-file -e "$retained^{commit}" || { merge_outcome_stop "required historical commit $retained is unavailable"; return 1; }
    done
  else
    git show-ref --verify --quiet "$MERGE_OUTCOME_REF" 2>/dev/null || ref_status=$?
    [ "$ref_status" -eq 1 ] || { merge_outcome_stop "unreadable outcome ref"; return 1; }
  fi
}

merge_outcome_write() {
  local record="$1" blob tree next parent
  mark_pr_operation_side_effects_started || return 1
  local parents=()
  for parent in $(printf '%s\n' "$record" | jq -r '[.head,.main,.landed] | unique | .[] | select(. != null)'); do
    parents+=(-p "$parent")
  done
  [ -z "$MERGE_OUTCOME_OID" ] || parents+=(-p "$MERGE_OUTCOME_OID")
  blob=$(printf '%s\n' "$record" | git hash-object -w --stdin) || return 1
  tree=$(printf '100644 blob %s\toutcome.json\n' "$blob" | git mktree) || return 1
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
    -f 'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){id url nameWithOwner ref(qualifiedName:"refs/heads/main"){target{oid}} pullRequest(number:$number){id number url state headRefOid baseRefName isDraft mergeCommit{oid} autoMergeRequest{mergeMethod} isInMergeQueue isMergeQueueEnabled mergeable mergeStateStatus}}}') || return 1
  printf '%s\n' "$response" | jq -ce --argjson repo "$MERGE_REPO" --argjson pr "$1" '
    def oid: type == "string" and test("^[0-9a-f]{40}$");
    select(.errors == null) | .data.repository |
    select({id,url,nameWithOwner} == $repo and (.ref.target.oid | oid)) |
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

merge_outcome_observe() {
  local pr="$1" oid
  MERGE_OBSERVATION=$(merge_outcome_read_remote "$pr") || {
    merge_outcome_stop "authoritative PR/main metadata unavailable or invalid"; return 1;
  }
  # Fetch immutable objects only. Do not replace a pinned observation with the
  # moving origin/main tracking ref or FETCH_HEAD.
  oid=$(printf '%s\n' "$MERGE_OBSERVATION" | jq -r .main)
  if ! git cat-file -e "$oid^{commit}" 2>/dev/null; then
    git fetch --no-tags --no-write-fetch-head "$MERGE_REPO_URL" "$oid" || { merge_outcome_stop "cannot fetch authoritative main $oid"; return 1; }
  fi
  git cat-file -e "$oid^{commit}" || return 1
}

merge_outcome_stable() {
  local reread
  reread=$(merge_outcome_read_remote "$1") || return 1
  [ "$reread" = "$MERGE_OBSERVATION" ] || {
    merge_outcome_stop "PR or main changed during observation; rerun for read-only reconciliation if intent exists"
    return 1
  }
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

merge_outcome_resume() {
  local pr="$1" phase comments marker comment_url
  merge_outcome_reconcile "$pr" || return 1
  phase=$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .phase)
  [ "$phase" != intent ] || return 0
  if [ "$phase" = commenting ]; then
    marker="<!-- openclaw-merge:$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -r .attempt) -->"
    # Absence never permits a second POST: the first response may have been lost.
    if comments=$(gh_plain api --hostname "$MERGE_REPO_HOST" --paginate --slurp \
      "repos/$MERGE_REPO_NAME/issues/$pr/comments?per_page=100") &&
      comment_url=$(printf '%s\n' "$comments" | jq -er --arg marker "$marker" \
        '[.[][] | select(.body | contains($marker))] | select(length == 1) | .[0].html_url | select(type == "string" and length > 0)'); then
      echo "Completion comment observed: $comment_url"
      merge_outcome_write "$(printf '%s\n' "$MERGE_OUTCOME_RECORD" | jq -c '.phase="commented"')" || return 1
    fi
  fi
  if [ "$phase" = complete ]; then
    echo "merge-run already complete for PR #$pr; no side effects."
  else
    echo "Merge confirmed; completion pending. Recovery does not repeat comment POST or cleanup. Inspect the completion marker in PR comments and any remaining .worktrees/pr-$pr/local branches; verify their ownership before manual cleanup."
  fi
}
