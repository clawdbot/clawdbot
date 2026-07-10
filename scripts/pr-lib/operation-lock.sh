# Per-PR process lock shared by review, prepare, merge, and worktree GC.
PR_OPERATION_LOCK_REF=""
PR_OPERATION_LOCK_OWNER_OID=""
PR_OPERATION_LOCK_CANDIDATE_PR=""
PR_OPERATION_LOCK_CANDIDATE_OID=""
PR_OPERATION_LOCK_BLOCKED_OID=""
PR_OPERATION_LOCK_BLOCKED_REASON=""

is_canonical_pr_number() {
  local pr="$1"
  case "$pr" in ''|0|0*|*[!0-9]*) return 1 ;; esac
}

pr_operation_lock_ref() {
  local pr="$1"
  is_canonical_pr_number "$pr" || return 1
  printf 'refs/openclaw/pr-operation-locks/%s\n' "$pr"
}

pr_operation_lock_zero_oid() {
  local object_format
  object_format=$(git -C "$(repo_root)" rev-parse --show-object-format 2>/dev/null) || return 1
  case "$object_format" in
    sha1) printf '%040d\n' 0 ;;
    sha256) printf '%064d\n' 0 ;;
    *) return 1 ;;
  esac
}

pr_operation_lock_process_identity() {
  local pid="$1"
  case "$pid" in ''|0|1|*[!0-9]*) return 1 ;; esac
  TZ=UTC0 LC_ALL=C ps -o state= -o lstart= -p "$pid" 2>/dev/null | awk '
    NF {
      state = $1
      $1 = ""
      sub(/^[[:space:]]+/, "")
      printf "%s\t%s\n", state, $0
      found = 1
    }
    END { exit found ? 0 : 1 }
  '
}

pr_operation_lock_process_birth() {
  local identity state birth
  identity=$(pr_operation_lock_process_identity "$1") || return 1
  IFS=$'\t' read -r state birth <<<"$identity"
  case "$state" in Z*) return 1 ;; esac
  [ -n "$birth" ] || return 1
  printf '%s\n' "$birth"
}

pr_operation_lock_process_group_status() {
  local pgid="$1"
  case "$pgid" in ''|0|1|*[!0-9]*) return 1 ;; esac
  node -e '
    const pgid = Number(process.argv[1]);
    if (!Number.isSafeInteger(pgid) || pgid <= 1 || pgid > 0x7fffffff) {
      process.stdout.write("indeterminate\n");
      process.exit(0);
    }
    try {
      process.kill(-pgid, 0);
      process.stdout.write("live\n");
    } catch (error) {
      process.stdout.write(error?.code === "ESRCH" ? "dead\n" : "indeterminate\n");
    }
  ' "$pgid"
}

read_pr_operation_lock_owner() {
  local owner_oid="$1"
  local object_type payload parsed
  object_type=$(git -C "$(repo_root)" cat-file -t "$owner_oid" 2>/dev/null) || return 1
  [ "$object_type" = "blob" ] || return 1
  payload=$(git -C "$(repo_root)" cat-file blob "$owner_oid" 2>/dev/null) || return 1
  parsed=$(printf '%s\n' "$payload" | awk -F= '
    NR == 1 && $0 == "version=3" { next }
    NR == 2 && $0 == "state=active" { next }
    NR == 3 && NF == 2 && $1 == "pgid" && $2 ~ /^[1-9][0-9]*$/ && $2 > 1 && $2 <= 2147483647 {
      pgid = $2
      next
    }
    NR == 4 && NF == 2 && $1 == "supervisor_pid" && $2 ~ /^[1-9][0-9]*$/ && $2 > 1 && $2 <= 2147483647 {
      supervisor_pid = $2
      next
    }
    NR == 5 && NF == 2 && $1 == "supervisor_birth" && length($2) > 0 && index($2, "\t") == 0 {
      supervisor_birth = substr($0, length($1) + 2)
      next
    }
    NR == 6 && NF == 2 && $1 == "token" && length($2) > 0 && index($2, "\t") == 0 {
      token = $2
      next
    }
    { invalid = 1 }
    END {
      if (invalid || NR != 6 || pgid == "" || supervisor_pid == "" || supervisor_birth == "" || token == "") {
        exit 1
      }
      printf "%s\t%s\t%s\t%s\n", pgid, supervisor_pid, supervisor_birth, token
    }
  ') || return 1

  local owner_pgid supervisor_pid supervisor_birth owner_token
  IFS=$'\t' read -r owner_pgid supervisor_pid supervisor_birth owner_token <<<"$parsed"
  case "$owner_pgid" in ''|0|1|*[!0-9]*) return 1 ;; esac
  case "$supervisor_pid" in ''|0|1|*[!0-9]*) return 1 ;; esac
  [ -n "$supervisor_birth" ] || return 1
  if [[ ! "$owner_token" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
    return 1
  fi
  printf '%s\t%s\t%s\t%s\n' "$owner_pgid" "$supervisor_pid" "$supervisor_birth" "$owner_token"
}

clear_pr_operation_lock_state() {
  PR_OPERATION_LOCK_REF=""
  PR_OPERATION_LOCK_OWNER_OID=""
  PR_OPERATION_LOCK_CANDIDATE_PR=""
  PR_OPERATION_LOCK_CANDIDATE_OID=""
  PR_OPERATION_LOCK_BLOCKED_OID=""
  PR_OPERATION_LOCK_BLOCKED_REASON=""
}

pr_operation_lock_owner_is_current() {
  local root="$1"
  local lock_ref="$2"
  local expected_oid="$3"
  local current_oid ref_status=0
  if git -C "$root" symbolic-ref -q "$lock_ref" >/dev/null 2>&1; then
    return 2
  fi
  if current_oid=$(git -C "$root" rev-parse --verify "$lock_ref" 2>/dev/null); then
    [ "$current_oid" = "$expected_oid" ] && return 0
    return 1
  fi
  git -C "$root" show-ref --verify --quiet "$lock_ref" 2>/dev/null || ref_status=$?
  [ "$ref_status" -eq 1 ] && return 1
  return 2
}

release_pr_operation_lock() {
  if [ -z "${PR_OPERATION_LOCK_REF:-}" ] || [ -z "${PR_OPERATION_LOCK_OWNER_OID:-}" ]; then
    return 0
  fi

  if [ -n "${OPENCLAW_PR_LOCK_NOTIFY_FD:-}" ]; then
    # The outer supervisor releases only after a clean group drain. A failed,
    # interrupted, or controller-lost operation leaves this exact ref sticky.
    clear_pr_operation_lock_state
    return 0
  fi

  local root lock_ref owner_oid observed_oid ref_status
  root=$(repo_root) || return 1
  lock_ref="$PR_OPERATION_LOCK_REF"
  owner_oid="$PR_OPERATION_LOCK_OWNER_OID"

  local attempts=0
  while true; do
    # The expected old object makes release a compare-and-swap: a delayed
    # owner can never delete a successor's lock.
    if git -C "$root" update-ref --no-deref -d "$lock_ref" "$owner_oid" 2>/dev/null; then
      clear_pr_operation_lock_state
      return 0
    fi

    if observed_oid=$(git -C "$root" rev-parse --verify "$lock_ref" 2>/dev/null); then
      if [ "$observed_oid" != "$owner_oid" ]; then
        clear_pr_operation_lock_state
        return 0
      fi
    else
      ref_status=0
      git -C "$root" show-ref --verify --quiet "$lock_ref" 2>/dev/null || ref_status=$?
      if [ "$ref_status" -eq 1 ]; then
        clear_pr_operation_lock_state
        return 0
      fi
      if [ "$ref_status" -ne 0 ]; then
        break
      fi
    fi

    attempts=$((attempts + 1))
    [ "$attempts" -lt 20 ] || break
    sleep 0.05
  done

  echo "Unable to release the operation lock for ${lock_ref##*/}; the owner ref is unchanged." >&2
  return 1
}

notify_pr_operation_lock_supervisor() {
  if [ -z "${OPENCLAW_PR_LOCK_NOTIFY_FD:-}" ]; then
    return 0
  fi
  case "$OPENCLAW_PR_LOCK_NOTIFY_FD" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\t%s\n' "$PR_OPERATION_LOCK_REF" "$PR_OPERATION_LOCK_OWNER_OID" >&"$OPENCLAW_PR_LOCK_NOTIFY_FD"
}

recover_pr_operation_lock() {
  local pr="$1"
  local expected_oid="$2"
  local confirmation="${3-}"
  is_canonical_pr_number "$pr" || { echo "Invalid PR number: $pr" >&2; return 2; }
  [[ "$expected_oid" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || {
    echo "Invalid operation-lock owner OID: $expected_oid" >&2
    return 2
  }
  if [ "$confirmation" != "--confirmed-no-running-tools" ]; then
    echo "Recovery requires --confirmed-no-running-tools after checking for detached PR tools." >&2
    return 2
  fi

  local root lock_ref observed_oid
  root=$(repo_root) || return 1
  lock_ref=$(pr_operation_lock_ref "$pr") || return 1
  observed_oid=$(git -C "$root" rev-parse --verify "$lock_ref" 2>/dev/null) || {
    echo "PR #$pr has no operation lock to recover." >&2
    return 1
  }
  if [ "$observed_oid" != "$expected_oid" ]; then
    echo "PR #$pr operation-lock owner changed; refusing to delete $observed_oid." >&2
    return 1
  fi
  # PGID liveness cannot exclude a detached child or unrelated PGID reuse.
  # Recovery authority is the explicit confirmation plus this exact-OID CAS.
  if ! git -C "$root" update-ref --no-deref -d "$lock_ref" "$expected_oid" 2>/dev/null; then
    echo "PR #$pr operation-lock owner changed during recovery; nothing was deleted." >&2
    return 1
  fi
  echo "Recovered the stale operation lock for PR #$pr."
}

prepare_pr_operation_lock_candidate() {
  local pr="$1"
  if [ "${PR_OPERATION_LOCK_CANDIDATE_PR:-}" = "$pr" ] && [ -n "${PR_OPERATION_LOCK_CANDIDATE_OID:-}" ]; then
    return 0
  fi

  local root token group_status supervisor_pid supervisor_birth owner_oid
  root=$(repo_root) || return 1
  token=$(node -e 'process.stdout.write(require("node:crypto").randomUUID())') || return 1
  group_status=$(pr_operation_lock_process_group_status "$$") || return 1
  [ "$group_status" = "live" ] || return 1
  supervisor_pid="${OPENCLAW_PR_LOCK_SUPERVISOR_PID:-$$}"
  case "$supervisor_pid" in ''|0|1|*[!0-9]*) return 1 ;; esac
  supervisor_birth=$(pr_operation_lock_process_birth "$supervisor_pid") || return 1
  owner_oid=$(printf 'version=3\nstate=active\npgid=%s\nsupervisor_pid=%s\nsupervisor_birth=%s\ntoken=%s\n' \
    "$$" "$supervisor_pid" "$supervisor_birth" "$token" |
    git -C "$root" hash-object -w --stdin) || return 1
  PR_OPERATION_LOCK_CANDIDATE_PR="$pr"
  PR_OPERATION_LOCK_CANDIDATE_OID="$owner_oid"
}

try_acquire_pr_operation_lock() {
  local pr="$1"
  is_canonical_pr_number "$pr" || return 2
  PR_OPERATION_LOCK_BLOCKED_OID=""
  PR_OPERATION_LOCK_BLOCKED_REASON=""

  local root lock_ref zero_oid owner_oid
  root=$(repo_root) || return 2
  lock_ref=$(pr_operation_lock_ref "$pr") || return 2
  zero_oid=$(pr_operation_lock_zero_oid) || return 2
  prepare_pr_operation_lock_candidate "$pr" || return 2
  owner_oid="$PR_OPERATION_LOCK_CANDIDATE_OID"

  local unreadable_ref_attempts=0
  while true; do
    if git -C "$root" update-ref --no-deref "$lock_ref" "$owner_oid" "$zero_oid" 2>/dev/null; then
      PR_OPERATION_LOCK_REF="$lock_ref"
      PR_OPERATION_LOCK_OWNER_OID="$owner_oid"
      if ! notify_pr_operation_lock_supervisor; then
        PR_OPERATION_LOCK_BLOCKED_OID="$owner_oid"
        PR_OPERATION_LOCK_BLOCKED_REASON="not reported to its supervisor"
        return 2
      fi
      return 0
    fi

    local observed_oid owner_data owner_pgid supervisor_pid supervisor_birth owner_token group_status
    if git -C "$root" symbolic-ref -q "$lock_ref" >/dev/null 2>&1; then
      return 2
    fi
    if ! observed_oid=$(git -C "$root" rev-parse --verify "$lock_ref" 2>/dev/null); then
      # The supervisor may have released between our failed create-CAS and
      # this read. A newly installed successor can also appear immediately,
      # so one read miss is always a normal retry.
      unreadable_ref_attempts=$((unreadable_ref_attempts + 1))
      if [ "$unreadable_ref_attempts" -le 20 ]; then
        # A concurrent exact release can leave a short delete-to-create window,
        # including Git's transient ref lock. Bound the wait so a persistently
        # unreadable ref still fails closed.
        sleep 0.05
        continue
      fi
      return 2
    fi
    unreadable_ref_attempts=0
    if ! owner_data=$(read_pr_operation_lock_owner "$observed_oid"); then
      local owner_status=0
      pr_operation_lock_owner_is_current "$root" "$lock_ref" "$observed_oid" || owner_status=$?
      [ "$owner_status" -eq 1 ] && continue
      [ "$owner_status" -eq 0 ] || return 2
      PR_OPERATION_LOCK_BLOCKED_OID="$observed_oid"
      PR_OPERATION_LOCK_BLOCKED_REASON="unreadable"
      return 2
    fi
    IFS=$'\t' read -r owner_pgid supervisor_pid supervisor_birth owner_token <<<"$owner_data"
    local supervisor_identity supervisor_state current_supervisor_birth
    supervisor_identity=$(pr_operation_lock_process_identity "$supervisor_pid" 2>/dev/null || true)
    supervisor_state=""
    current_supervisor_birth=""
    if [ -n "$supervisor_identity" ]; then
      IFS=$'\t' read -r supervisor_state current_supervisor_birth <<<"$supervisor_identity"
    fi

    # A group is active only while the exact supervisor incarnation still owns
    # it. A reused PGID or orphaned descendant must surface explicit recovery.
    group_status=$(pr_operation_lock_process_group_status "$owner_pgid") || return 2
    case "$group_status" in
      live | dead)
        if [[ "$supervisor_state" != Z* ]] &&
          [ -n "$current_supervisor_birth" ] &&
          [ "$current_supervisor_birth" = "$supervisor_birth" ]
        then
          # A dead group can precede its controller's final drain and exact
          # release. Waiting also covers the ordinary live-operation case.
          return 1
        fi
        local owner_status=0
        pr_operation_lock_owner_is_current "$root" "$lock_ref" "$observed_oid" || owner_status=$?
        [ "$owner_status" -eq 1 ] && continue
        [ "$owner_status" -eq 0 ] || return 2
        # A missing controller cannot disprove a nested detached tool, even
        # when its old group is dead. Only exact-OID recovery may clear it.
        PR_OPERATION_LOCK_BLOCKED_OID="$observed_oid"
        PR_OPERATION_LOCK_BLOCKED_REASON="orphaned"
        return 2
        ;;
      *)
        local owner_status=0
        pr_operation_lock_owner_is_current "$root" "$lock_ref" "$observed_oid" || owner_status=$?
        [ "$owner_status" -eq 1 ] && continue
        [ "$owner_status" -eq 0 ] || return 2
        PR_OPERATION_LOCK_BLOCKED_OID="$observed_oid"
        PR_OPERATION_LOCK_BLOCKED_REASON="indeterminate"
        return 2
        ;;
    esac
  done
}

acquire_pr_operation_lock() {
  local pr="$1"
  local announced=false
  local lock_status=0
  while true; do
    try_acquire_pr_operation_lock "$pr" || lock_status=$?
    if [ "$lock_status" -eq 0 ]; then
      return 0
    fi
    if [ "$lock_status" -ne 1 ]; then
      if [ -n "$PR_OPERATION_LOCK_BLOCKED_OID" ]; then
        echo "The prior PR #$pr operation lock is $PR_OPERATION_LOCK_BLOCKED_REASON; detached child tools cannot be ruled out." >&2
        print_pr_operation_lock_recovery_guidance "$pr"
      fi
      echo "Unable to acquire the operation lock for PR #$pr." >&2
      return "$lock_status"
    fi
    if [ "$announced" = "false" ]; then
      echo "Waiting for the active scripts/pr operation on PR #$pr to finish..." >&2
      announced=true
    fi
    lock_status=0
    sleep 0.2
  done
}

print_pr_operation_lock_recovery_guidance() {
  local pr="$1"
  [ -n "${PR_OPERATION_LOCK_BLOCKED_OID:-}" ] || return 1
  echo "After verifying that no PR #$pr tools remain, recover the exact owner with:" >&2
  echo "  scripts/pr lock-recover $pr $PR_OPERATION_LOCK_BLOCKED_OID --confirmed-no-running-tools" >&2
}
