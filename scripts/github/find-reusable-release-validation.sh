#!/usr/bin/env bash
# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

# Finds a prior green Full Release Validation run for the exact target SHA or
# for its immediate product-equivalent predecessor. Cross-SHA reuse is limited
# to a descendant whose complete tree delta is CHANGELOG.md; package/install
# proof still runs against the release SHA after that changelog is committed.
# Always exits 0 with reuse=true/false; callers fail open to a full validation.

REPO="${GH_REPO:-}"
WORKFLOW_FILE="full-release-validation.yml"
TARGET_SHA=""
VERIFIER_WORKFLOW_SHA=""
WORKFLOW_REF=""
TRUSTED_WORKFLOW_REF=""
TRUSTED_WORKFLOW_FULL_REF=""
TRUSTED_WORKFLOW_SHA=""
RELEASE_PROFILE=""
RUN_RELEASE_SOAK="false"
INPUTS_JSON=""
REPO_DIR="."
MAX_CANDIDATES=12
GITHUB_OUTPUT_FILE="${GITHUB_OUTPUT:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREFLIGHT="${SCRIPT_DIR}/../release-preflight.mjs"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
VALIDATOR="${OPENCLAW_RELEASE_CI_SUMMARY_VALIDATOR:-${REPO_ROOT}/scripts/release-ci-summary.mjs}"

usage() {
  cat >&2 <<'EOF'
Usage: find-reusable-release-validation.sh --target-sha <sha> --workflow-sha <sha> \
  --workflow-ref <main|release-ci/sha12-timestamp> \
  [--trusted-workflow-ref <main|release-publish/sha12-run>] \
  [--trusted-workflow-full-ref <refs/heads/main|refs/tags/release-publish/sha12-run>] \
  [--trusted-workflow-sha <sha>] \
  --release-profile <beta|stable|full> --inputs-json <json> \
  [--run-release-soak <true|false>] [--repo <owner/repo>] [--repo-dir <path>] \
  [--workflow <file>] [--max-candidates <n>] [--github-output <file>]

Scans recent successful Full Release Validation runs for an exact-target
validation manifest whose recorded lane-selection inputs match --inputs-json
and whose normalized strict-v4 phased evidence is accepted by the current trusted-main
verifier identified by --workflow-sha. The historical producer workflow SHA
remains independent. A descendant target may reuse product validation only
when GitHub proves the entire delta is CHANGELOG.md. Writes reuse=true plus
evidence_* outputs when found; reuse=false otherwise.
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
    --workflow-ref)
      WORKFLOW_REF="${2:-}"
      shift 2
      ;;
    --trusted-workflow-ref)
      TRUSTED_WORKFLOW_REF="${2:-}"
      shift 2
      ;;
    --trusted-workflow-full-ref)
      TRUSTED_WORKFLOW_FULL_REF="${2:-}"
      shift 2
      ;;
    --trusted-workflow-sha)
      TRUSTED_WORKFLOW_SHA="${2:-}"
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
TRUSTED_WORKFLOW_REF="${TRUSTED_WORKFLOW_REF:-main}"
TRUSTED_WORKFLOW_FULL_REF="${TRUSTED_WORKFLOW_FULL_REF:-refs/heads/main}"
TRUSTED_WORKFLOW_SHA="${TRUSTED_WORKFLOW_SHA:-${VERIFIER_WORKFLOW_SHA}}"
if [[ ! "$TRUSTED_WORKFLOW_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Expected --trusted-workflow-sha to be a full lowercase commit SHA; got: ${TRUSTED_WORKFLOW_SHA}" >&2
  exit 2
fi
if [[ "$TRUSTED_WORKFLOW_SHA" != "$VERIFIER_WORKFLOW_SHA" ]]; then
  no_reuse "trusted workflow SHA does not match verifier source SHA"
fi
if [[ "$WORKFLOW_REF" != "main" ]]; then
  expected_release_ref="release-ci/${VERIFIER_WORKFLOW_SHA:0:12}-"
  if [[ ! "$WORKFLOW_REF" =~ ^release-ci/[0-9a-f]{12}-[1-9][0-9]*$ ]] ||
    [[ "$WORKFLOW_REF" != "$expected_release_ref"* ]]; then
    no_reuse "workflow ref is not a canonical SHA-pinned release ref"
  fi
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

trusted_workflow_route=""
if [[ "$TRUSTED_WORKFLOW_REF" == "main" ]]; then
  if [[ "$TRUSTED_WORKFLOW_FULL_REF" != "refs/heads/main" ]]; then
    no_reuse "trusted main workflow full ref is invalid"
  fi
  workflow_lineage=""
  if ! workflow_lineage="$(
    gh api "repos/${REPO}/compare/${TRUSTED_WORKFLOW_SHA}...main"
  )"; then
    no_reuse "could not verify workflow SHA against trusted main"
  fi
  if ! jq -e \
    --arg workflow_sha "$TRUSTED_WORKFLOW_SHA" '
      (.status == "ahead" or .status == "identical")
      and .merge_base_commit.sha == $workflow_sha
    ' <<< "$workflow_lineage" >/dev/null; then
    no_reuse "workflow SHA is not on trusted main lineage"
  fi
  trusted_workflow_route="main"
elif [[ "$TRUSTED_WORKFLOW_REF" =~ ^release-publish/([0-9a-f]{12})-[1-9][0-9]*$ ]] &&
  [[ "$TRUSTED_WORKFLOW_FULL_REF" == "refs/tags/${TRUSTED_WORKFLOW_REF}" ]] &&
  [[ "$TRUSTED_WORKFLOW_REF" == "release-publish/${TRUSTED_WORKFLOW_SHA:0:12}-"* ]]; then
  trusted_tag_json=""
  if ! trusted_tag_json="$(
    gh api "repos/${REPO}/git/ref/tags/${TRUSTED_WORKFLOW_REF}"
  )"; then
    no_reuse "could not verify protected trusted workflow tag"
  fi
  if ! jq -e \
    --arg workflow_sha "$TRUSTED_WORKFLOW_SHA" '
      .object.type == "commit"
      and .object.sha == $workflow_sha
    ' <<< "$trusted_tag_json" >/dev/null; then
    no_reuse "protected trusted workflow tag moved or is not lightweight"
  fi
  trusted_workflow_route="protected-tag"
else
  no_reuse "trusted workflow identity is not main or an exact protected tag"
fi

# Exact-target reuse still requires internally consistent version stamps
# (for example package.json must agree with the macOS plist).
if ! (cd "$REPO_DIR" && env -u NODE_OPTIONS node "$PREFLIGHT" --macos-versions-only >&2); then
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

reuse_request="$(jq -nc \
  --arg targetSha "$TARGET_SHA" \
  --arg releaseProfile "$RELEASE_PROFILE" \
  --arg runReleaseSoak "$RUN_RELEASE_SOAK" \
  --argjson validationInputs "$expected_inputs" \
  '{targetSha: $targetSha, releaseProfile: $releaseProfile, runReleaseSoak: $runReleaseSoak, validationInputs: $validationInputs}')"

for ((index = 0; index < run_count; index += 1)); do
  run_id="$(jq -r ".[${index}].id" <<< "$runs_json")"
  validation_record=""
  if ! validation_record="$(
    node "$VALIDATOR" \
      --validate-run "$run_id" \
      --repo "$REPO" \
      --reuse-request-json "$reuse_request" \
      --trusted-workflow-ref "$TRUSTED_WORKFLOW_REF" \
      --trusted-workflow-full-ref "$TRUSTED_WORKFLOW_FULL_REF" \
      --trusted-workflow-sha "$TRUSTED_WORKFLOW_SHA" \
      --verifier-source-sha "$VERIFIER_WORKFLOW_SHA" \
      --verifier-source-file "$VALIDATOR" \
      --json
  )"; then
    validator_error="$(
      jq -r '
        if (.error | type) == "string" then
          .error
          | gsub("[\\r\\n\\t ]+"; " ")
          | gsub("^ +| +$"; "")
          | if length > 500 then .[0:497] + "..." else . end
        else
          empty
        end
      ' <<< "$validation_record" 2>/dev/null || true
    )"
    if [[ -n "$validator_error" ]]; then
      echo "[evidence-reuse] run ${run_id}: shared evidence validator rejected the run: ${validator_error}; skipping" >&2
    else
      echo "[evidence-reuse] run ${run_id}: shared evidence validator rejected the run; skipping" >&2
    fi
    continue
  fi
  if ! jq -e \
    --arg repo "$REPO" \
    --arg run_id "$run_id" \
    --arg trusted_workflow_full_ref "$TRUSTED_WORKFLOW_FULL_REF" \
    --arg trusted_workflow_ref "$TRUSTED_WORKFLOW_REF" \
    --arg trusted_workflow_route "$trusted_workflow_route" \
    --arg verifier_sha "$VERIFIER_WORKFLOW_SHA" '
      . as $record
      | .schema == "openclaw.release-validation-evidence/v4"
      and .valid == true
      and .repository == $repo
      and .producerOnTrustedMainLineage == ($trusted_workflow_route == "main")
      and .trustedWorkflowRef == $trusted_workflow_ref
      and .trustedWorkflowFullRef == $trusted_workflow_full_ref
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
        . as $parent
        | .producerOnTrustedMainLineage == ($trusted_workflow_route == "main")
        and .workflowRefType == "branch"
        and .workflowPath == ".github/workflows/full-release-validation.yml"
        and .workflowFullRef == ("refs/heads/" + .workflowRef)
        and .workflowQualifiedPath ==
          (".github/workflows/full-release-validation.yml@" + .workflowFullRef)
        and (
          .workflowRunPath == ".github/workflows/full-release-validation.yml"
          or .workflowRunPath == .workflowQualifiedPath
        )
        and if $trusted_workflow_route == "main" then
          (
            (
              .workflowRef == "main"
              and .manifestVersion == 4
              and .workflowRefProof == "manifest-v3-branch"
            )
            or (
              .manifestVersion == 4
              and .workflowRefProof == "manifest-v3-sha-pinned-main-ancestry"
              and (.workflowRef | test("^release-ci/[0-9a-f]{12}-[1-9][0-9]*$"))
              and (.workflowRef | startswith("release-ci/\($parent.workflowSha[0:12])-"))
            )
          )
        else
          .manifestVersion == 4
          and (
            .workflowRefProof == "manifest-v3-protected-tag-exact-sha"
            or .workflowRefProof == "manifest-v3-protected-tag-tooling-lineage"
          )
          and (.workflowRef | test("^release-ci/[0-9a-f]{12}-[1-9][0-9]*$"))
          and (.workflowRef | startswith("release-ci/\($parent.workflowSha[0:12])-"))
        end
      )
      and (.verifier.schemaVersion == 3)
      and (.verifier.sourceSha == $verifier_sha)
      and ([.children[].role] | sort) ==
        (if .validationInputs.coveragePolicy == "npm-beta-v1" then
          ["normalCi", "pluginPrereleaseCandidate", "pluginPrereleaseIndependent", "releaseChecksCandidate", "releaseChecksIndependent"]
        elif (
          .rerunGroup == "all"
          and ((.validationInputs.telegramWaiver // "") == "")
          and (
            ((.validationInputs.npmTelegramPackageSpec // "") | length) > 0
            or ((.validationInputs.releasePackageSpec // "") | length) > 0
          )
        ) then
          ["normalCi", "npmTelegram", "pluginPrereleaseCandidate", "pluginPrereleaseIndependent", "productPerformance", "releaseChecksCandidate", "releaseChecksIndependent"]
        else
          ["normalCi", "pluginPrereleaseCandidate", "pluginPrereleaseIndependent", "productPerformance", "releaseChecksCandidate", "releaseChecksIndependent"]
        end)
      and ([.children[].runId] | length == (unique | length))
      and ([.children[]
        | select(.role == "productPerformance")
        | .reportPublication] ==
          (if .validationInputs.coveragePolicy == "npm-beta-v1" then [] else ["artifact-only"] end))
      and all(.children[];
        .status == "completed"
        and .policyPassed == true
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
  evidence_policy="exact-target-full-validation-v1"
  changed_paths="[]"
  if [[ "$prior_sha" != "$TARGET_SHA" ]]; then
    compare_json=""
    if ! compare_json="$(
      gh api "repos/${REPO}/compare/${prior_sha}...${TARGET_SHA}"
    )"; then
      echo "[evidence-reuse] run ${run_id}: could not compare ${prior_sha}...${TARGET_SHA}; skipping" >&2
      continue
    fi
    if ! jq -e \
      --arg prior_sha "$prior_sha" '
        .status == "ahead"
        and .merge_base_commit.sha == $prior_sha
        and (.files | type == "array" and length == 1)
        and .files[0].filename == "CHANGELOG.md"
        and .files[0].status == "modified"
        and ((.files[0].previous_filename // "") == "")
      ' <<< "$compare_json" >/dev/null; then
      echo "[evidence-reuse] run ${run_id}: target ${TARGET_SHA} is not a CHANGELOG.md-only descendant of ${prior_sha}; skipping" >&2
      continue
    fi
    evidence_policy="changelog-only-release-v1"
    changed_paths='["CHANGELOG.md"]'
  fi

  run_url="$(jq -r '.root.url' <<< "$validation_record")"
  echo "[evidence-reuse] reusing ${evidence_policy} run ${run_id} (${run_url}) for ${TARGET_SHA}" >&2
  write_output reuse true
  write_output evidence_run_id "$run_id"
  write_output evidence_root_run_id "$run_id"
  write_output evidence_run_url "$run_url"
  write_output evidence_sha "$prior_sha"
  write_output evidence_policy "$evidence_policy"
  write_output changed_path_count "$(jq 'length' <<< "$changed_paths")"
  write_output changed_paths "$changed_paths"
  write_output evidence_manifest "$(jq -c '.manifest' <<< "$validation_record")"
  exit 0
done

no_reuse "no prior validation run covers ${TARGET_SHA}"
