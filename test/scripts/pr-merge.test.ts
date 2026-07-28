import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const mergeScript = join(process.cwd(), "scripts/pr-lib/merge.sh");
const headSha = "0123456789abcdef0123456789abcdef01234567";
const landedSha = "fedcba9876543210fedcba9876543210fedcba98";
const describePosix = process.platform === "win32" ? describe.skip : describe;

type MergeScenario = {
  auto?: boolean;
  autoError?: string;
  autoResult?: "enabled" | "inconclusive" | "unavailable";
  checks?: "fail" | "green" | "pending";
  existingAutoMethod?: "" | "MERGE" | "REBASE" | "SQUASH";
  mergeStateStatus?: string;
  mergeable?: string;
  recommendation?: "ready" | "needs_work";
  reviewArtifacts?: "valid" | "invalid";
};

function runMerge(scenario: MergeScenario = {}) {
  const root = tempDirs.make("openclaw-pr-merge-");
  const localDir = join(root, ".local");
  const calls = join(root, "gh-calls.log");
  const autoCalled = join(root, "auto-called");
  const autoState = join(root, "auto-state");
  const bin = join(root, "bin");
  const rgCalls = join(root, "rg-calls.log");
  mkdirSync(bin, { recursive: true });
  mkdirSync(localDir, { recursive: true });
  writeFileSync(
    join(bin, "rg"),
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(process.env.OPENCLAW_TEST_RG_CALLS, JSON.stringify(args) + "\\n");
const pattern = args.at(-2);
const file = args.at(-1);
const flags = args.includes("-i") ? "i" : "";
process.exit(new RegExp(pattern, flags).test(readFileSync(file, "utf8")) ? 0 : 1);
`,
  );
  chmodSync(join(bin, "rg"), 0o755);
  writeFileSync(
    join(localDir, "prep.env"),
    `PREP_HEAD_SHA=${headSha}\nLOCAL_PREP_HEAD_SHA=${headSha}\n`,
  );
  for (const artifact of ["review.md", "review.json", "prep.md"]) {
    writeFileSync(join(localDir, artifact), "fixture\n");
  }

  const existingAutoMethod = scenario.existingAutoMethod ?? "";
  const preAutoMeta = JSON.stringify({
    state: "OPEN",
    headRefOid: headSha,
    mergeable: scenario.mergeable ?? "MERGEABLE",
    mergeStateStatus: scenario.mergeStateStatus ?? "BEHIND",
    autoMergeRequest: existingAutoMethod ? { mergeMethod: existingAutoMethod } : null,
  });
  const postAutoMeta = JSON.stringify({
    state: "OPEN",
    headRefOid: headSha,
    mergeable: "MERGEABLE",
    mergeStateStatus: "BEHIND",
    autoMergeRequest: scenario.autoResult === "unavailable" ? null : { mergeMethod: "SQUASH" },
  });
  const disabledAutoMeta = JSON.stringify({
    state: "OPEN",
    headRefOid: headSha,
    mergeable: scenario.mergeable ?? "MERGEABLE",
    mergeStateStatus: scenario.mergeStateStatus ?? "BEHIND",
    autoMergeRequest: null,
  });
  const checks =
    scenario.checks === "fail"
      ? [{ name: "CI", bucket: "fail", state: "FAILURE" }]
      : scenario.checks === "pending"
        ? [{ name: "CI", bucket: "pending", state: "IN_PROGRESS" }]
        : [{ name: "CI", bucket: "pass", state: "SUCCESS" }];

  const shell = `
set -euo pipefail
source "$OPENCLAW_TEST_MERGE_SCRIPT"
enter_worktree() { :; }
require_artifact() { :; }
validate_review_artifact_data() {
  if [ "$OPENCLAW_TEST_REVIEW_ARTIFACTS" != "valid" ]; then
    echo 'review artifact validation failed' >&2
    return 1
  fi
}
require_ready_review_recommendation() {
  if [ "$OPENCLAW_TEST_REVIEW_RECOMMENDATION" != "ready" ]; then
    echo 'review recommendation is not ready' >&2
    return 1
  fi
}
verify_prep_branch_matches_prepared_head() { :; }
mark_pr_operation_side_effects_started() { :; }
mainline_drift_requires_sync() { return 1; }
print_relevant_log_excerpt() { cat "$1"; }
repo_root() { printf '%s\\n' "$OPENCLAW_TEST_ROOT"; }
remove_worktree_if_present() { :; }
delete_local_branch_if_safe() { :; }
pr_meta_json() {
  printf '%s\\n' '{"state":"OPEN","isDraft":false,"headRefOid":"${headSha}"}'
}
git() {
  if [ "\${1-}" = "merge-base" ]; then
    if [ "$OPENCLAW_TEST_MERGE_STATE_STATUS" = "BEHIND" ]; then
      return 1
    fi
    return 0
  fi
  return 0
}
gh() {
  printf '%s\\n' "$*" >> "$OPENCLAW_TEST_GH_CALLS"
  case "$1 $2" in
    "pr checks")
      case " $* " in
        *" --json "*)
          printf '%s\\n' "$OPENCLAW_TEST_CHECKS_JSON"
          return "$OPENCLAW_TEST_CHECKS_EXIT_STATUS"
          ;;
      esac
      ;;
    "pr view")
      case "$*" in
        *"--json state,isDraft"*)
          printf '%s\\n' '{"state":"OPEN","isDraft":false}'
          ;;
        *"--json state,headRefOid,mergeable,mergeStateStatus,autoMergeRequest"*)
          if [ -e "$OPENCLAW_TEST_AUTO_STATE" ] && [ "$(cat "$OPENCLAW_TEST_AUTO_STATE")" = "enabled" ]; then
            printf '%s\\n' "$OPENCLAW_TEST_POST_AUTO_META"
          elif [ -e "$OPENCLAW_TEST_AUTO_STATE" ]; then
            printf '%s\\n' "$OPENCLAW_TEST_DISABLED_AUTO_META"
          else
            printf '%s\\n' "$OPENCLAW_TEST_PRE_AUTO_META"
          fi
          ;;
        *"--json state,headRefOid,autoMergeRequest"*)
          if [ -e "$OPENCLAW_TEST_AUTO_STATE" ] && [ "$(cat "$OPENCLAW_TEST_AUTO_STATE")" = "disabled" ]; then
            printf '%s\\n' "$OPENCLAW_TEST_DISABLED_AUTO_META"
          else
            printf '%s\\n' "$OPENCLAW_TEST_POST_AUTO_META"
          fi
          ;;
        *"--json state --jq .state"*) printf 'MERGED\\n' ;;
        *"--json mergeCommit"*) printf '%s\\n' "$OPENCLAW_TEST_LANDED_SHA" ;;
        *"--json commits"*) printf '1\\n' ;;
        *"--json headRefName,headRepository"*)
          printf '%s\\n' '{"headRefName":"feature","headRepository":{"name":"openclaw"},"headRepositoryOwner":{"login":"openclaw"},"isCrossRepository":false,"maintainerCanModify":true}'
          ;;
        *"--json url"*) printf 'https://github.com/openclaw/openclaw/pull/123\\n' ;;
        *) printf '%s\\n' '{"state":"OPEN"}' ;;
      esac
      ;;
    "pr merge")
      case " $* " in
        *" --disable-auto "*)
          printf 'disabled\\n' > "$OPENCLAW_TEST_AUTO_STATE"
          ;;
        *" --auto "*)
          : > "$OPENCLAW_TEST_AUTO_CALLED"
          printf 'enabled\\n' > "$OPENCLAW_TEST_AUTO_STATE"
          if [ "$OPENCLAW_TEST_AUTO_RESULT" = "unavailable" ]; then
            echo "$OPENCLAW_TEST_AUTO_ERROR" >&2
            return 1
          fi
          if [ "$OPENCLAW_TEST_AUTO_RESULT" = "inconclusive" ]; then
            echo 'transport closed after mutation' >&2
            return 1
          fi
          ;;
      esac
      ;;
    "repo view") printf 'openclaw/openclaw\\n' ;;
    "pr comment") printf 'https://github.com/openclaw/openclaw/pull/123#issuecomment-1\\n' ;;
    "api "*) : ;;
    *) echo "unexpected gh invocation: $*" >&2; return 2 ;;
  esac
}
merge_run 123 "$OPENCLAW_TEST_AUTO_REQUESTED"
`;

  const result = spawnSync("bash", ["-c", shell], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_TEST_AUTO_CALLED: autoCalled,
      OPENCLAW_TEST_AUTO_ERROR:
        scenario.autoError ?? "GraphQL: Pull request auto merge is not allowed for this repository",
      OPENCLAW_TEST_AUTO_REQUESTED: scenario.auto ? "true" : "false",
      OPENCLAW_TEST_AUTO_RESULT: scenario.autoResult ?? "enabled",
      OPENCLAW_TEST_AUTO_STATE: autoState,
      OPENCLAW_TEST_CHECKS_EXIT_STATUS: scenario.checks === "pending" ? "8" : "0",
      OPENCLAW_TEST_CHECKS_JSON: JSON.stringify(checks),
      OPENCLAW_TEST_DISABLED_AUTO_META: disabledAutoMeta,
      OPENCLAW_TEST_GH_CALLS: calls,
      OPENCLAW_TEST_LANDED_SHA: landedSha,
      OPENCLAW_TEST_MERGE_SCRIPT: mergeScript,
      OPENCLAW_TEST_MERGE_STATE_STATUS: scenario.mergeStateStatus ?? "BEHIND",
      OPENCLAW_TEST_POST_AUTO_META: postAutoMeta,
      OPENCLAW_TEST_PRE_AUTO_META: preAutoMeta,
      OPENCLAW_TEST_REVIEW_ARTIFACTS: scenario.reviewArtifacts ?? "valid",
      OPENCLAW_TEST_REVIEW_RECOMMENDATION: scenario.recommendation ?? "ready",
      OPENCLAW_TEST_RG_CALLS: rgCalls,
      OPENCLAW_TEST_ROOT: root,
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
  return {
    ...result,
    calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
    rgCalls: existsSync(rgCalls) ? readFileSync(rgCalls, "utf8") : "",
  };
}

describePosix("scripts/pr merge-run", () => {
  it("refuses to merge when review artifact validation fails", () => {
    const result = runMerge({ reviewArtifacts: "invalid" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("review artifact validation failed");
    expect(result.calls).not.toContain("pr merge");
  });

  it("refuses to merge when the review recommendation is not ready", () => {
    const result = runMerge({ recommendation: "needs_work" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("review recommendation is not ready");
    expect(result.calls).not.toContain("pr merge");
  });

  it("does not enable auto-merge when exact-head required CI is failing", () => {
    const result = runMerge({ auto: true, checks: "fail" });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Required checks are failing.");
    expect(result.calls).not.toContain("pr merge");
  });

  it("does not mistake pending required checks for a GitHub API failure", () => {
    const result = runMerge({ auto: true, checks: "pending" });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Required checks are still pending.");
    expect(result.stderr).not.toContain("unable to verify the required GitHub checks");
    expect(result.calls).not.toContain("pr merge");
  });

  it("fails a conflicting PR without attempting auto-merge", () => {
    const result = runMerge({
      auto: true,
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("GitHub reports merge conflicts");
    expect(result.calls).not.toContain("pr merge");
  });

  it("keeps the default immediate pinned squash merge unchanged", () => {
    const result = runMerge({ mergeStateStatus: "CLEAN" });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.calls).toContain(`pr merge 123 --squash --match-head-commit ${headSha}`);
    expect(result.calls).not.toContain("--auto");
    expect(result.stdout).toContain("merge-run complete for PR #123");
  });

  it("enables squash auto-merge only for a verified mergeable BEHIND head", () => {
    const result = runMerge({ auto: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.calls).toContain(`pr merge 123 --auto --squash --match-head-commit ${headSha}`);
    expect(result.calls.match(/^pr merge /gmu)).toHaveLength(1);
    expect(result.stdout).toContain("AUTO-MERGE ENABLED");
    expect(result.stdout).toContain("required checks and branch up-to-dateness");
  });

  it("falls back to the immediate merge when BEHIND is not the only obstacle", () => {
    const result = runMerge({ auto: true, mergeStateStatus: "BLOCKED" });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.calls).not.toContain("--auto");
    expect(result.calls).toContain(`pr merge 123 --squash --match-head-commit ${headSha}`);
    expect(result.stdout).toContain("expected MERGEABLE/BEHIND");
    expect(result.stdout).toContain("Falling back");
  });

  it("re-arms an existing auto-merge request with the verified head", () => {
    const result = runMerge({ auto: true, existingAutoMethod: "MERGE" });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.calls).toContain("pr merge 123 --disable-auto");
    expect(result.calls).toContain(`pr merge 123 --auto --squash --match-head-commit ${headSha}`);
    expect(result.stdout).toContain("re-arming it as pinned SQUASH");
    expect(result.stdout).toContain("AUTO-MERGE ENABLED");
  });

  it("clears an inconclusive auto-merge request instead of trusting its method", () => {
    const result = runMerge({ auto: true, autoResult: "inconclusive" });

    expect(result.status).toBe(1);
    expect(result.calls).toContain(`pr merge 123 --auto --squash --match-head-commit ${headSha}`);
    expect(result.calls).toContain("pr merge 123 --disable-auto");
    expect(result.stdout).toContain("clearing the observed SQUASH request");
    expect(result.stdout).toContain("cleared safely");
  });

  it("reports unavailable auto-merge and falls back to the immediate pinned merge", () => {
    const result = runMerge({ auto: true, autoResult: "unavailable" });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.calls).toContain(`pr merge 123 --auto --squash --match-head-commit ${headSha}`);
    expect(result.calls).toContain(`pr merge 123 --squash --match-head-commit ${headSha}`);
    expect(result.rgCalls).toContain('"-q","-i","--"');
    expect(result.stdout).toContain("auto-merge is unavailable");
    expect(result.stdout).toContain("falling back");
  });

  it("recognizes unavailable auto-merge wording in reverse order", () => {
    const result = runMerge({
      auto: true,
      autoError: "GraphQL: Branch protection must be enabled before using auto-merge",
      autoResult: "unavailable",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.calls).toContain(`pr merge 123 --squash --match-head-commit ${headSha}`);
    expect(result.stdout).toContain("auto-merge is unavailable");
  });
});
