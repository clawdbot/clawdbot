#!/usr/bin/env bash
set -euo pipefail

# Finds a prior green Full Release Validation run for the exact target SHA.
# Cross-SHA evidence reuse is intentionally left to the granular delta manifest,
# which can require fresh package/install/provider closure per changed artifact.
# Always exits 0 with reuse=true/false; callers fail open to a full validation.

REPO="${GH_REPO:-}"
WORKFLOW_FILE="full-release-validation.yml"
TARGET_SHA=""
VERIFIER_WORKFLOW_SHA=""
RELEASE_PROFILE=""
RUN_RELEASE_SOAK="false"
INPUTS_JSON=""
REPO_DIR="."
MAX_CANDIDATES=12
GITHUB_OUTPUT_FILE="${GITHUB_OUTPUT:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFLIGHT="${SCRIPT_DIR}/../release-preflight.mjs"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VALIDATOR="${OPENCLAW_RELEASE_CI_SUMMARY_VALIDATOR:-${REPO_ROOT}/.agents/skills/release-openclaw-ci/scripts/release-ci-summary.mjs}"

usage() {
  cat >&2 <<'EOF'
Usage: find-reusable-release-validation.sh --target-sha <sha> --workflow-sha <sha> \
  --release-profile <beta|stable|full> --inputs-json <json> \
  [--run-release-soak <true|false>] [--repo <owner/repo>] [--repo-dir <path>] \
  [--workflow <file>] [--max-candidates <n>] [--github-output <file>]

Scans recent successful Full Release Validation runs for an exact-target
validation manifest whose recorded lane-selection inputs match --inputs-json
and whose normalized strict-v3 evidence is accepted by the current trusted-main
verifier identified by --workflow-sha. The historical producer workflow SHA
remains independent. Writes reuse=true plus evidence_* outputs when found;
reuse=false otherwise.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-sha)
      TARGET_SHA="${2:-}"
      shift 2
      ;;
    --workflow-sha)
      VERIFIER_WORKFLOW_SHA="${2:-}"
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

if [[ ! "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected --target-sha to be a full lowercase commit SHA; got: ${TARGET_SHA}" >&2
  exit 2
fi
if [[ ! "$VERIFIER_WORKFLOW_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected --workflow-sha to be a full lowercase commit SHA; got: ${VERIFIER_WORKFLOW_SHA}" >&2
  exit 2
fi
if [[ -z "$REPO" ]]; then
  echo "Expected --repo <owner/repo> or GH_REPO." >&2
  exit 2
fi
if [[ "$RUN_RELEASE_SOAK" != "true" && "$RUN_RELEASE_SOAK" != "false" ]]; then
  echo "Expected --run-release-soak to be true or false; got: ${RUN_RELEASE_SOAK}" >&2
  exit 2
fi
case "$RELEASE_PROFILE" in
  beta|stable|full) ;;
  *) no_reuse "unknown release profile ${RELEASE_PROFILE}" ;;
esac
expected_inputs=""
if ! expected_inputs="$(jq -Sc 'if type == "object" then . else error("expected object") end' <<< "$INPUTS_JSON" 2>/dev/null)" || [[ -z "$expected_inputs" ]]; then
  echo "Expected --inputs-json to be a JSON object of lane-selection inputs." >&2
  exit 2
fi

# Exact-target reuse still requires internally consistent version stamps
# (for example package.json must agree with the macOS plist).
if ! (cd "$REPO_DIR" && node "$PREFLIGHT" --macos-versions-only >&2); then
  no_reuse "target version metadata is inconsistent"
fi

runs_json=""
if ! runs_json="$(
  gh api -X GET "repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs" \
    -F status=success -F event=workflow_dispatch -F per_page="$MAX_CANDIDATES" \
    --jq '[.workflow_runs[] | {id}]'
)"; then
  no_reuse "could not list prior successful validation runs"
fi

run_count="$(jq 'length' <<< "$runs_json")"
if [[ "$run_count" == "0" ]]; then
  no_reuse "no prior successful validation runs"
fi

for ((index = 0; index < run_count; index += 1)); do
  run_id="$(jq -r ".[${index}].id" <<< "$runs_json")"
  validation_record=""
  if ! validation_record="$(
    node "$VALIDATOR" \
      --validate-run "$run_id" \
      --repo "$REPO" \
      --trusted-workflow-ref main \
      --json
  )"; then
    echo "[evidence-reuse] run ${run_id}: shared evidence validator rejected the run; skipping" >&2
    continue
  fi
  if ! jq -e \
    --arg repo "$REPO" \
    --arg run_id "$run_id" \
    --arg verifier_sha "$VERIFIER_WORKFLOW_SHA" '
      . as $record
      | .schema == "openclaw.release-validation-evidence/v3"
      and .valid == true
      and .repository == $repo
      and .producerOnTrustedMainLineage == true
      and .trustedWorkflowRef == "main"
      and .trustedWorkflowFullRef == "refs/heads/main"
      and .directRoot == true
      and .evidenceReuse == null
      and .rerunGroup == "all"
      and .controls.performanceReportPublication == "artifact-only"
      and .conclusions.current == "success"
      and .conclusions.root == "success"
      and .conclusions.allRequiredSucceeded == true
      and (.current == .root)
      and (.root.runId | tostring) == $run_id
      and (.root.workflowSha | type == "string" and test("^[0-9a-f]{40}$"))
      and (.root.targetSha | type == "string" and test("^[0-9a-f]{40}$"))
      and (.root.artifact.digest | type == "string" and test("^sha256:[0-9a-f]{64}$"))
      and all($record.current, $record.root;
        .producerOnTrustedMainLineage == true
        and .workflowFullRef == "refs/heads/main"
        and .workflowRefType == "branch"
        and .workflowPath == ".github/workflows/full-release-validation.yml"
        and .workflowQualifiedPath ==
          ".github/workflows/full-release-validation.yml@refs/heads/main"
        and (
          .workflowRunPath == ".github/workflows/full-release-validation.yml"
          or .workflowRunPath ==
            ".github/workflows/full-release-validation.yml@refs/heads/main"
        )
        and (
          (.manifestVersion == 3 and .workflowRefProof == "manifest-v3-branch")
          or (
            .manifestVersion == 2
            and .workflowRefProof == "legacy-v2-main-ancestry"
          )
        )
      )
      and (.verifier.schemaVersion == 3)
      and (.verifier.sourceSha == $verifier_sha)
      and ([.children[].role] | sort) ==
        ["normalCi", "pluginPrerelease", "productPerformance", "releaseChecks"]
      and ([.children[].runId] | length == (unique | length))
      and ([.children[]
        | select(.role == "productPerformance")
        | .reportPublication] == ["artifact-only"])
      and all(.children[];
        .status == "completed"
        and .conclusion == "success"
        and .workflowSha == $record.root.workflowSha
        and (.sourceParentRunId | tostring) == $run_id
      )
    ' <<< "$validation_record" >/dev/null 2>&1; then
    echo "[evidence-reuse] run ${run_id}: normalized evidence is not a strict direct-root full validation; skipping" >&2
    continue
  fi

  prior_profile="$(jq -r '.releaseProfile // ""' <<< "$validation_record")"
  if [[ "$prior_profile" != "$RELEASE_PROFILE" ]]; then
    echo "[evidence-reuse] run ${run_id}: profile ${prior_profile} differs from ${RELEASE_PROFILE}; skipping" >&2
    continue
  fi
  # Lane selection (provider, mode, filters, package specs) changes what the
  # prior run proved; only exact-match manifests are reusable. Manifests
  # written before validationInputs existed never match.
  manifest_inputs="$(jq -Sc '.validationInputs // empty' <<< "$validation_record")"
  if [[ -z "$manifest_inputs" || "$manifest_inputs" != "$expected_inputs" ]]; then
    echo "[evidence-reuse] run ${run_id}: validation inputs differ from the current request; skipping" >&2
    continue
  fi
  prior_soak="$(jq -r '.runReleaseSoak // false' <<< "$validation_record")"
  if [[ "$prior_soak" != "$RUN_RELEASE_SOAK" ]]; then
    echo "[evidence-reuse] run ${run_id}: soak ${prior_soak} differs from ${RUN_RELEASE_SOAK}; skipping" >&2
    continue
  fi

  prior_sha="$(jq -r '.root.targetSha' <<< "$validation_record")"
  if [[ "$prior_sha" != "$TARGET_SHA" ]]; then
    echo "[evidence-reuse] run ${run_id}: target ${prior_sha} differs from ${TARGET_SHA}; cross-SHA reuse requires granular artifact evidence" >&2
    continue
  fi

  run_url="$(jq -r '.root.url' <<< "$validation_record")"
  echo "[evidence-reuse] reusing exact-target run ${run_id} (${run_url}) for ${TARGET_SHA}" >&2
  write_output reuse true
  write_output evidence_run_id "$run_id"
  write_output evidence_root_run_id "$run_id"
  write_output evidence_run_url "$run_url"
  write_output evidence_sha "$prior_sha"
  write_output changed_path_count "0"
  write_output changed_paths "[]"
  write_output evidence_manifest "$(jq -c '.manifest' <<< "$validation_record")"
  exit 0
done

no_reuse "no prior validation run covers ${TARGET_SHA}"
