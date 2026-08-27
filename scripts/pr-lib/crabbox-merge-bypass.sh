read_required_checks_for_crabbox_bypass() {
  local pr="$1"
  local output_file="$2"
  local error_file
  local status
  error_file=$(mktemp)
  if gh_plain pr checks "$pr" --required --json name,bucket,state >"$output_file" 2>"$error_file"; then
    status=0
  else
    status=$?
  fi
  if [ "$status" -ne 0 ] && [ "$status" -ne 1 ] && [ "$status" -ne 8 ]; then
    echo "Crabbox merge bypass failed: unable to refresh required checks." >&2
    cat "$error_file" >&2
    rm -f "$error_file"
    return 1
  fi
  rm -f "$error_file"
  if ! jq -e 'type == "array"' "$output_file" >/dev/null; then
    echo "Crabbox merge bypass failed: invalid required-check evidence." >&2
    return 1
  fi
}

verify_crabbox_admin_merge_bypass() {
  local pr="$1"
  local head_sha="$2"
  if [ "${GATES_MODE:-}" != "remote_crabbox_aws" ] ||
    [ "${REMOTE_GATES_PROVIDER:-}" != "aws" ] ||
    [ "${FULL_GATES_HEAD_SHA:-}" != "$head_sha" ] ||
    [ "${LAST_VERIFIED_HEAD_SHA:-}" != "$head_sha" ] ||
    [[ "${REMOTE_GATES_RUN_ID:-}" != run_* ]] ||
    [[ "${REMOTE_GATES_LEASE_ID:-}" != cbx_* ]]; then
    echo "Crabbox merge bypass requires exact prepared remote_crabbox_aws gate artifacts." >&2
    return 1
  fi

  local proof_dir=".local/merge-crabbox-bypass"
  rm -rf "$proof_dir"
  mkdir -p "$proof_dir"
  read_required_checks_for_crabbox_bypass "$pr" "$proof_dir/required-checks.json" || return 1
  gh_plain api user >"$proof_dir/actor.json" || return 1
  local actor
  actor=$(jq -r '.login // empty' "$proof_dir/actor.json")
  if [ -z "$actor" ]; then
    echo "Crabbox merge bypass failed: authenticated actor login is missing." >&2
    return 1
  fi

  if ! gh_plain api --paginate --slurp \
    "repos/{owner}/{repo}/commits/$head_sha/check-runs?filter=latest&per_page=100" \
    >"$proof_dir/check-run-pages.json"; then
    echo "Crabbox merge bypass failed: unable to read exact-head check runs." >&2
    return 1
  fi
  jq '{check_runs: [.[] | .check_runs[]]}' \
    "$proof_dir/check-run-pages.json" >"$proof_dir/check-runs.json" || return 1
  local crabbox_details_url
  crabbox_details_url=$(
    jq -r '
      [.check_runs[] | select(.name == "openclaw/crabbox-gate")]
      | sort_by(.id)
      | last
      | .details_url // empty
    ' "$proof_dir/check-runs.json"
  )
  if [[ "$crabbox_details_url" =~ ^https://github.com/openclaw/openclaw/actions/runs/([0-9]+)$ ]]; then
    local crabbox_publisher_run_id="${BASH_REMATCH[1]}"
  else
    echo "Crabbox merge bypass failed: trusted gate has no exact Actions run URL." >&2
    return 1
  fi
  gh_plain api "repos/{owner}/{repo}/actions/runs/$crabbox_publisher_run_id" \
    >"$proof_dir/publisher-run.json" || return 1

  local ci_details_url
  ci_details_url=$(
    jq -r '
      [.check_runs[] | select(.name == "openclaw/ci-gate")]
      | sort_by(.id)
      | last
      | .details_url // empty
    ' "$proof_dir/check-runs.json"
  )
  if [[ "$ci_details_url" =~ ^https://github.com/openclaw/openclaw/actions/runs/([0-9]+)/job/([0-9]+)$ ]]; then
    local ci_run_id="${BASH_REMATCH[1]}"
    local ci_gate_job_id="${BASH_REMATCH[2]}"
  else
    echo "Crabbox merge bypass failed: normal CI gate has no exact Actions run/job URL." >&2
    return 1
  fi

  gh_plain api "repos/{owner}/{repo}/actions/runs/$ci_run_id" \
    >"$proof_dir/workflow-run.json" || return 1
  if ! gh_plain api --paginate --slurp \
    "repos/{owner}/{repo}/actions/runs/$ci_run_id/jobs?filter=latest&per_page=100" \
    >"$proof_dir/job-pages.json"; then
    echo "Crabbox merge bypass failed: unable to read normal CI jobs." >&2
    return 1
  fi
  jq '{jobs: [.[] | .jobs[]]}' "$proof_dir/job-pages.json" >"$proof_dir/jobs.json" || return 1

  local encoded_actor
  encoded_actor=$(jq -rn --arg value "$actor" '$value | @uri')
  gh_plain api "orgs/openclaw/memberships/$encoded_actor" \
    >"$proof_dir/membership.json" || return 1
  if ! node "$script_parent_dir/pr-lib/crabbox-merge-bypass.mjs" \
    --actor "$proof_dir/actor.json" \
    --membership "$proof_dir/membership.json" \
    --publisher-run "$proof_dir/publisher-run.json" \
    --required-checks "$proof_dir/required-checks.json" \
    --check-runs "$proof_dir/check-runs.json" \
    --workflow-run "$proof_dir/workflow-run.json" \
    --jobs "$proof_dir/jobs.json" \
    --head "$head_sha" \
    --run-id "$REMOTE_GATES_RUN_ID" \
    --lease-id "$REMOTE_GATES_LEASE_ID" \
    >.local/merge-crabbox-bypass.json; then
    echo "Crabbox merge bypass evidence is not sufficient." >&2
    return 1
  fi
  jq -r '
    "Crabbox admin merge bypass verified: actor=\(.actor) ci_run=\(.ciRunId) infrastructure=" +
    ([.infrastructureJobs[] | "\(.backend):\(.name)"] | join(","))
  ' .local/merge-crabbox-bypass.json
}
