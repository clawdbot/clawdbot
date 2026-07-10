#!/usr/bin/env bash
set -euo pipefail

# Finds a prior green Full Release Validation run whose evidence still covers
# the target SHA: same rerun scope, equal-or-broader release profile/soak, and
# a target delta that is release-metadata-only per check-release-metadata-only.
# Always exits 0 with reuse=true/false; callers fail open to a full validation.

REPO="${GH_REPO:-}"
WORKFLOW_FILE="full-release-validation.yml"
TARGET_SHA=""
WORKFLOW_SHA=""
RELEASE_PROFILE=""
RUN_RELEASE_SOAK="false"
INPUTS_JSON=""
REPO_DIR="."
MAX_CANDIDATES=12
GITHUB_OUTPUT_FILE="${GITHUB_OUTPUT:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASSIFIER="${SCRIPT_DIR}/../check-release-metadata-only.mjs"
PREFLIGHT="${SCRIPT_DIR}/../release-preflight.mjs"

usage() {
  cat >&2 <<'EOF'
Usage: find-reusable-release-validation.sh --target-sha <sha> --workflow-sha <sha> \
  --release-profile <beta|stable|full> --inputs-json <json> \
  [--run-release-soak <true|false>] [--repo <owner/repo>] [--repo-dir <path>] \
  [--workflow <file>] [--max-candidates <n>] [--github-output <file>]

Scans recent successful Full Release Validation runs for a validation manifest
whose targetSha differs from --target-sha only by release metadata paths, whose
recorded lane-selection inputs match --inputs-json exactly, whose harness
(.github/workflows tree at the run's head SHA) matches --workflow-sha, and
whose recorded child runs are still green. Writes reuse=true plus evidence_*
outputs when found; reuse=false otherwise.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-sha)
      TARGET_SHA="${2:-}"
      shift 2
      ;;
    --workflow-sha)
      WORKFLOW_SHA="${2:-}"
      shift 2
      ;;
    --release-profile)
      RELEASE_PROFILE="${2:-}"
      shift 2
      ;;
    --run-release-soak)
      RUN_RELEASE_SOAK="${2:-}"
      shift 2
      ;;
    --inputs-json)
      INPUTS_JSON="${2:-}"
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      shift 2
      ;;
    --repo-dir)
      REPO_DIR="${2:-}"
      shift 2
      ;;
    --workflow)
      WORKFLOW_FILE="${2:-}"
      shift 2
      ;;
    --max-candidates)
      MAX_CANDIDATES="${2:-}"
      shift 2
      ;;
    --github-output)
      GITHUB_OUTPUT_FILE="${2:-}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

write_output() {
  local key="$1"
  local value="$2"
  if [[ -n "$GITHUB_OUTPUT_FILE" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$GITHUB_OUTPUT_FILE"
  else
    printf '%s=%s\n' "$key" "$value"
  fi
}

no_reuse() {
  echo "[evidence-reuse] no reuse: $1" >&2
  write_output reuse false
  write_output reuse_reason "$1"
  exit 0
}

profile_rank() {
  case "$1" in
    beta) echo 1 ;;
    stable) echo 2 ;;
    full) echo 3 ;;
    *) echo 0 ;;
  esac
}

if [[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected --target-sha to be a full lowercase commit SHA; got: ${TARGET_SHA}" >&2
  exit 2
fi
if [[ ! "$WORKFLOW_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected --workflow-sha to be a full lowercase commit SHA; got: ${WORKFLOW_SHA}" >&2
  exit 2
fi
if [[ -z "$REPO" ]]; then
  echo "Expected --repo <owner/repo> or GH_REPO." >&2
  exit 2
fi
current_rank="$(profile_rank "$RELEASE_PROFILE")"
if [[ "$current_rank" == "0" ]]; then
  no_reuse "unknown release profile ${RELEASE_PROFILE}"
fi
expected_inputs=""
if ! expected_inputs="$(jq -Sc . <<< "$INPUTS_JSON" 2>/dev/null)" || [[ -z "$expected_inputs" ]]; then
  echo "Expected --inputs-json to be a JSON object of lane-selection inputs." >&2
  exit 2
fi

# A metadata-only diff can still leave the target's version stamps mutually
# inconsistent (for example package.json bumped without the macOS plist);
# validate the target state before trusting any prior evidence.
if ! (cd "$REPO_DIR" && node "$PREFLIGHT" --macos-versions-only >&2); then
  no_reuse "target version metadata is inconsistent"
fi

# Evidence must come from an equivalent harness: workflows and their helper
# scripts run from the workflow ref, so the tree diff between the candidate
# run's head SHA and the current workflow SHA must itself be metadata-only.
harness_matches() {
  local candidate_sha="$1"
  if [[ "$candidate_sha" == "$WORKFLOW_SHA" ]]; then
    return 0
  fi
  if ! git -C "$REPO_DIR" fetch --quiet --depth=1 origin "$candidate_sha" "$WORKFLOW_SHA"; then
    return 1
  fi
  local harness_paths
  if ! harness_paths="$(git -C "$REPO_DIR" diff --name-only "$candidate_sha" "$WORKFLOW_SHA")"; then
    return 1
  fi
  if [[ -z "$harness_paths" ]]; then
    return 0
  fi
  local -a harness_path_list=()
  while IFS= read -r harness_path; do
    [[ -n "$harness_path" ]] && harness_path_list+=("$harness_path")
  done <<< "$harness_paths"
  (cd "$REPO_DIR" && node "$CLASSIFIER" --base "$candidate_sha" --head "$WORKFLOW_SHA" -- "${harness_path_list[@]}")
}

runs_json=""
if ! runs_json="$(
  gh api -X GET "repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs" \
    -F status=success -F event=workflow_dispatch -F per_page="$MAX_CANDIDATES" \
    --jq '[.workflow_runs[] | {id, html_url, head_sha}]'
)"; then
  no_reuse "could not list prior successful validation runs"
fi

run_count="$(jq 'length' <<< "$runs_json")"
if [[ "$run_count" == "0" ]]; then
  no_reuse "no prior successful validation runs"
fi

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

for ((index = 0; index < run_count; index += 1)); do
  run_id="$(jq -r ".[${index}].id" <<< "$runs_json")"
  run_url="$(jq -r ".[${index}].html_url" <<< "$runs_json")"
  run_head_sha="$(jq -r ".[${index}].head_sha // \"\"" <<< "$runs_json")"

  if [[ ! "$run_head_sha" =~ ^[0-9a-f]{40}$ ]] || ! harness_matches "$run_head_sha"; then
    echo "[evidence-reuse] run ${run_id}: harness differs from the current workflow ref beyond release metadata; skipping" >&2
    continue
  fi

  artifact_id=""
  if ! artifact_id="$(
    gh api "repos/${REPO}/actions/runs/${run_id}/artifacts?per_page=100" \
      --jq "first(.artifacts[] | select(.name == \"full-release-validation-${run_id}\" and .expired == false) | .id)"
  )"; then
    echo "[evidence-reuse] run ${run_id}: artifact listing failed; skipping" >&2
    continue
  fi
  if [[ -z "${artifact_id// }" ]]; then
    echo "[evidence-reuse] run ${run_id}: no validation manifest artifact; skipping" >&2
    continue
  fi

  manifest_zip="${work_dir}/manifest-${run_id}.zip"
  manifest_path="${work_dir}/manifest-${run_id}.json"
  if ! gh api "repos/${REPO}/actions/artifacts/${artifact_id}/zip" > "$manifest_zip"; then
    echo "[evidence-reuse] run ${run_id}: manifest download failed; skipping" >&2
    continue
  fi
  if ! unzip -p "$manifest_zip" full-release-validation-manifest.json > "$manifest_path" 2>/dev/null; then
    echo "[evidence-reuse] run ${run_id}: manifest missing from artifact; skipping" >&2
    continue
  fi

  if ! jq -e '
    (.version >= 2)
    and (.rerunGroup == "all")
    and ((.targetSha // "") | test("^[0-9a-f]{40}$"))
  ' "$manifest_path" >/dev/null 2>&1; then
    echo "[evidence-reuse] run ${run_id}: manifest is not a full-scope v2 manifest; skipping" >&2
    continue
  fi

  prior_profile="$(jq -r '.releaseProfile // ""' "$manifest_path")"
  prior_rank="$(profile_rank "$prior_profile")"
  if (( prior_rank < current_rank )); then
    echo "[evidence-reuse] run ${run_id}: profile ${prior_profile} does not cover ${RELEASE_PROFILE}; skipping" >&2
    continue
  fi
  # Lane selection (provider, mode, filters, package specs) changes what the
  # prior run proved; only exact-match manifests are reusable. Manifests
  # written before validationInputs existed never match.
  manifest_inputs="$(jq -Sc '.validationInputs // empty' "$manifest_path")"
  if [[ -z "$manifest_inputs" || "$manifest_inputs" != "$expected_inputs" ]]; then
    echo "[evidence-reuse] run ${run_id}: validation inputs differ from the current request; skipping" >&2
    continue
  fi
  prior_soak="$(jq -r '.runReleaseSoak // "false"' "$manifest_path")"
  if [[ "$RUN_RELEASE_SOAK" == "true" && "$prior_soak" != "true" ]]; then
    echo "[evidence-reuse] run ${run_id}: no soak evidence; skipping" >&2
    continue
  fi

  prior_sha="$(jq -r '.targetSha' "$manifest_path")"
  # Track count/joined separately: empty-array expansion under `set -u` breaks
  # on the bash 3.2 that macOS ships.
  changed_paths=()
  changed_path_count=0
  changed_paths_joined=""
  if [[ "$prior_sha" != "$TARGET_SHA" ]]; then
    compare_json=""
    if ! compare_json="$(
      gh api "repos/${REPO}/compare/${prior_sha}...${TARGET_SHA}" \
        --jq '{status, file_count: ((.files // []) | length), files: [(.files // [])[].filename]}'
    )"; then
      echo "[evidence-reuse] run ${run_id}: compare ${prior_sha}...${TARGET_SHA} failed; skipping" >&2
      continue
    fi
    compare_status="$(jq -r '.status' <<< "$compare_json")"
    if [[ "$compare_status" != "ahead" ]]; then
      echo "[evidence-reuse] run ${run_id}: target is ${compare_status} of prior evidence, not ahead; skipping" >&2
      continue
    fi
    file_count="$(jq -r '.file_count' <<< "$compare_json")"
    # The compare API truncates at 300 files; a truncated list cannot prove a
    # metadata-only delta, so fall back to full validation.
    if (( file_count >= 300 )); then
      echo "[evidence-reuse] run ${run_id}: delta too large to classify (${file_count} files); skipping" >&2
      continue
    fi
    while IFS= read -r changed_path; do
      if [[ -n "$changed_path" ]]; then
        changed_paths+=("$changed_path")
        changed_path_count=$((changed_path_count + 1))
        changed_paths_joined="${changed_paths_joined:+${changed_paths_joined} }${changed_path}"
      fi
    done < <(jq -r '.files[]' <<< "$compare_json")
    if (( changed_path_count == 0 )); then
      echo "[evidence-reuse] run ${run_id}: delta has no file changes" >&2
    else
      if ! git -C "$REPO_DIR" fetch --quiet --depth=1 origin "$prior_sha"; then
        echo "[evidence-reuse] run ${run_id}: could not fetch prior SHA ${prior_sha}; skipping" >&2
        continue
      fi
      if ! (cd "$REPO_DIR" && node "$CLASSIFIER" --base "$prior_sha" --head "$TARGET_SHA" -- "${changed_paths[@]}"); then
        echo "[evidence-reuse] run ${run_id}: delta is not release-metadata-only; skipping" >&2
        continue
      fi
    fi
  fi

  # Recorded child runs can be re-run to failure after the parent stays green;
  # reuse only evidence whose children are still completed/success, matching
  # the recheck the normal summary performs on its own children.
  children_healthy=1
  while IFS= read -r child_run_id; do
    [[ -n "$child_run_id" ]] || continue
    if ! child_state="$(gh api "repos/${REPO}/actions/runs/${child_run_id}" --jq '(.status // "") + "/" + (.conclusion // "")')"; then
      echo "[evidence-reuse] run ${run_id}: could not verify child run ${child_run_id}; skipping" >&2
      children_healthy=0
      break
    fi
    if [[ "$child_state" != "completed/success" ]]; then
      echo "[evidence-reuse] run ${run_id}: child run ${child_run_id} is ${child_state}; skipping" >&2
      children_healthy=0
      break
    fi
  done < <(jq -r '[.childRuns.normalCi // "", .childRuns.pluginPrerelease // "", .childRuns.releaseChecks // "", .childRuns.npmTelegram // "", (.childRuns.productPerformance.runId // "")] | map(select(. != "")) | .[]' "$manifest_path")
  if [[ "$children_healthy" != "1" ]]; then
    continue
  fi

  # A reused run may itself be a reuse manifest; evidenceReuse.runId points at
  # the chain root that actually executed the lanes.
  evidence_root_run_id="$(jq -r '.evidenceReuse.runId // empty' "$manifest_path")"
  if [[ -z "${evidence_root_run_id// }" ]]; then
    evidence_root_run_id="$run_id"
  fi

  echo "[evidence-reuse] reusing run ${run_id} (${run_url}) for ${TARGET_SHA}: prior sha ${prior_sha}, ${changed_path_count} metadata-only changed files" >&2
  write_output reuse true
  write_output evidence_run_id "$run_id"
  write_output evidence_root_run_id "$evidence_root_run_id"
  write_output evidence_run_url "$run_url"
  write_output evidence_sha "$prior_sha"
  write_output changed_path_count "$changed_path_count"
  write_output changed_paths "$changed_paths_joined"
  write_output evidence_manifest "$(jq -c . "$manifest_path")"
  exit 0
done

no_reuse "no prior validation run covers ${TARGET_SHA}"
