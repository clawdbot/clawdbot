import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const commonScript = join(process.cwd(), "scripts/pr-lib/common.sh");
const mergeScript = join(process.cwd(), "scripts/pr-lib/merge.sh");
const headSha = "0123456789abcdef0123456789abcdef01234567";
const landedSha = "fedcba9876543210fedcba9876543210fedcba98";
const describePosix = process.platform === "win32" ? describe.skip : describe;

type MergeScenario = {
  auto?: boolean;
  autoError?: string;
  autoResult?: "enabled" | "inconclusive" | "unavailable";
  checks?: "fail" | "green" | "pending";
  crabboxBypass?: "missing" | "non-admin" | "non-infra" | "stale-sha" | "valid" | "wrong-app";
  cleanupMetadataError?: string;
  commentEmpty?: boolean;
  commentFailures?: number;
  existingAutoMethod?: "" | "MERGE" | "REBASE" | "SQUASH";
  mergeStateStatus?: string;
  mergeable?: string;
  recommendation?: "ready" | "needs_work";
  remoteDeleteError?: string;
  remoteReadError?: string;
  remoteRefsJson?: string;
  reviewArtifacts?: "valid" | "invalid";
};

function runMerge(scenario: MergeScenario = {}) {
  const root = tempDirs.make("openclaw-pr-merge-");
  const localDir = join(root, ".local");
  const calls = join(root, "gh-calls.log");
  const autoCalled = join(root, "auto-called");
  const autoState = join(root, "auto-state");
  const bin = join(root, "bin");
  const commentAttempts = join(root, "comment-attempts");
  const commentBody = join(root, "comment-body");
  const lifecycle = join(root, "lifecycle.log");
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
  const usesCrabboxBypass = scenario.crabboxBypass !== undefined;
  writeFileSync(
    join(localDir, "prep.env"),
    [
      `PREP_HEAD_SHA=${headSha}`,
      `LOCAL_PREP_HEAD_SHA=${headSha}`,
      `LAST_VERIFIED_HEAD_SHA=${usesCrabboxBypass ? headSha : ""}`,
      `FULL_GATES_HEAD_SHA=${usesCrabboxBypass ? headSha : ""}`,
      `GATES_MODE=${usesCrabboxBypass ? "remote_crabbox_aws" : "full"}`,
      `REMOTE_GATES_PROVIDER=${usesCrabboxBypass ? "aws" : ""}`,
      `REMOTE_GATES_RUN_ID=${usesCrabboxBypass ? "run_abc123" : ""}`,
      `REMOTE_GATES_LEASE_ID=${usesCrabboxBypass ? "cbx_def456" : ""}`,
      "",
    ].join("\n"),
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
  const checks = usesCrabboxBypass
    ? [{ name: "openclaw/ci-gate", bucket: "fail", state: "SKIPPED" }]
    : scenario.checks === "fail"
      ? [{ name: "CI", bucket: "fail", state: "FAILURE" }]
      : scenario.checks === "pending"
        ? [{ name: "CI", bucket: "pending", state: "IN_PROGRESS" }]
        : [{ name: "CI", bucket: "pass", state: "SUCCESS" }];
  const checkRuns = {
    check_runs: [
      {
        app: { id: 15368 },
        conclusion: "skipped",
        details_url: "https://github.com/openclaw/openclaw/actions/runs/7001/job/7002",
        head_sha: headSha,
        id: 20,
        name: "openclaw/ci-gate",
        status: "completed",
      },
      ...(scenario.crabboxBypass === "missing"
        ? []
        : [
            {
              app: { id: scenario.crabboxBypass === "wrong-app" ? 999 : 15368 },
              conclusion: "success",
              details_url: "https://github.com/openclaw/openclaw/actions/runs/8001",
              head_sha: scenario.crabboxBypass === "stale-sha" ? "b".repeat(40) : headSha,
              id: 21,
              name: "openclaw/crabbox-gate",
              output: {
                summary: `Trusted Crabbox AWS proof run_abc123 / cbx_def456; build, check, and full test passed on exact head ${headSha}.`,
              },
              status: "completed",
            },
          ]),
    ],
  };
  const workflowRun = {
    conclusion: "failure",
    event: "pull_request",
    head_sha: headSha,
    id: 7001,
    path: ".github/workflows/ci.yml",
    status: "completed",
  };
  const publisherRun = {
    conclusion: "success",
    event: "workflow_dispatch",
    head_branch: "main",
    id: 8001,
    path: ".github/workflows/pr-crabbox-gate-publisher.yml",
    status: "completed",
  };
  const workflowJobs = {
    jobs: [
      {
        conclusion: "skipped",
        id: 7002,
        name: "openclaw/ci-gate",
        status: "completed",
      },
      {
        conclusion: "failure",
        id: 7003,
        labels: ["blacksmith-4vcpu-ubuntu-2404"],
        name: "check",
        runner_name: null,
        status: "completed",
        steps:
          scenario.crabboxBypass === "non-infra"
            ? [
                {
                  conclusion: "failure",
                  name: "The hosted runner encountered an error",
                  status: "completed",
                },
              ]
            : [],
      },
    ],
  };

  const shell = `
set -euo pipefail
script_parent_dir="$OPENCLAW_TEST_SCRIPTS_DIR"
source "$OPENCLAW_TEST_COMMON_SCRIPT"
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
remove_worktree_if_present() { printf 'worktree-cleanup %s\\n' "$*" >> "$OPENCLAW_TEST_LIFECYCLE"; }
delete_local_branch_if_safe() { printf 'branch-cleanup %s\\n' "$*" >> "$OPENCLAW_TEST_LIFECYCLE"; }
sleep() { :; }
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
node() {
  if [[ "\${1-}" = */scripts/watch-pr-ci.mjs ]]; then
    printf 'watch %s\\n' "$*" >> "$OPENCLAW_TEST_GH_CALLS"
    return 0
  fi
  command node "$@"
}
gh_route() {
  local route="$1"
  shift
  printf '%s %s\\n' "$route" "$*" >> "$OPENCLAW_TEST_GH_CALLS"
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
          if [ -n "$OPENCLAW_TEST_CLEANUP_METADATA_ERROR" ]; then
            printf '%s\\n' "$OPENCLAW_TEST_CLEANUP_METADATA_ERROR" >&2
            return 1
          fi
          printf '%s\\n' '{"headRefName":"topic/nested","headRepository":{"name":"fixture"},"headRepositoryOwner":{"login":"contributor"},"isCrossRepository":true,"maintainerCanModify":true}'
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
    "api "*)
      local api_arg
      for api_arg in "$@"; do
        case "$api_arg" in
          repos/*/*/commits/*)
            case "$api_arg" in
              *"/check-runs?"*) ;;
              *)
                echo 'unexpected repository commit-resolution API probe' >&2
                return 1
                ;;
            esac
            ;;
        esac
      done
      case "$*" in
        "api user")
          printf '%s\\n' '{"login":"maintainer"}'
          ;;
        *"orgs/openclaw/memberships/maintainer"*)
          if [ "$OPENCLAW_TEST_CRABBOX_BYPASS" = "non-admin" ]; then
            printf '%s\\n' '{"state":"active","role":"member","user":{"login":"maintainer"}}'
          else
            printf '%s\\n' '{"state":"active","role":"admin","user":{"login":"maintainer"}}'
          fi
          ;;
        *"/commits/${headSha}/check-runs"*)
          printf '[%s]\\n' "$OPENCLAW_TEST_CHECK_RUNS_JSON"
          ;;
        *"/actions/runs/7001/jobs"*)
          printf '[%s]\\n' "$OPENCLAW_TEST_WORKFLOW_JOBS_JSON"
          ;;
        *"/actions/runs/8001"*)
          printf '%s\\n' "$OPENCLAW_TEST_PUBLISHER_RUN_JSON"
          ;;
        *"/actions/runs/7001"*)
          printf '%s\\n' "$OPENCLAW_TEST_WORKFLOW_RUN_JSON"
          ;;
        *"issues/123/comments"*)
          local arg
          for arg in "$@"; do
            case "$arg" in
              body=*) printf '%s' "\${arg#body=}" > "$OPENCLAW_TEST_COMMENT_BODY" ;;
            esac
          done
          local attempts=0
          if [ -e "$OPENCLAW_TEST_COMMENT_ATTEMPTS" ]; then
            attempts=$(cat "$OPENCLAW_TEST_COMMENT_ATTEMPTS")
          fi
          attempts=$((attempts + 1))
          printf '%s\\n' "$attempts" > "$OPENCLAW_TEST_COMMENT_ATTEMPTS"
          printf 'comment\\n' >> "$OPENCLAW_TEST_LIFECYCLE"
          if [ "$attempts" -le "$OPENCLAW_TEST_COMMENT_FAILURES" ]; then
            echo 'transient comment failure' >&2
            return 1
          fi
          if [ "$OPENCLAW_TEST_COMMENT_EMPTY" = "true" ]; then
            return 0
          fi
          printf 'https://github.com/openclaw/openclaw/pull/123#issuecomment-1\\n'
          ;;
        *"git/refs/"*)
          printf 'remote-cleanup\\n' >> "$OPENCLAW_TEST_LIFECYCLE"
          if [ -n "$OPENCLAW_TEST_REMOTE_DELETE_ERROR" ]; then
            printf '%s\\n' "$OPENCLAW_TEST_REMOTE_DELETE_ERROR" >&2
            return 1
          fi
          ;;
        *"git/matching-refs/"*)
          printf '%s\\n' "$OPENCLAW_TEST_REMOTE_REFS_JSON"
          if [ -n "$OPENCLAW_TEST_REMOTE_READ_ERROR" ]; then
            printf '%s\\n' "$OPENCLAW_TEST_REMOTE_READ_ERROR" >&2
            return 1
          fi
          ;;
        *) : ;;
      esac
      ;;
    *) echo "unexpected gh invocation: $*" >&2; return 2 ;;
  esac
}
gh() { gh_route path "$@"; }
gh_plain() { gh_route plain "$@"; }
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
      OPENCLAW_TEST_CHECK_RUNS_JSON: JSON.stringify(checkRuns),
      OPENCLAW_TEST_CLEANUP_METADATA_ERROR: scenario.cleanupMetadataError ?? "",
      OPENCLAW_TEST_COMMENT_ATTEMPTS: commentAttempts,
      OPENCLAW_TEST_COMMENT_BODY: commentBody,
      OPENCLAW_TEST_COMMENT_EMPTY: scenario.commentEmpty ? "true" : "false",
      OPENCLAW_TEST_COMMENT_FAILURES: String(scenario.commentFailures ?? 0),
      OPENCLAW_TEST_COMMON_SCRIPT: commonScript,
      OPENCLAW_TEST_CRABBOX_BYPASS: scenario.crabboxBypass ?? "",
      OPENCLAW_TEST_DISABLED_AUTO_META: disabledAutoMeta,
      OPENCLAW_TEST_GH_CALLS: calls,
      OPENCLAW_TEST_LANDED_SHA: landedSha,
      OPENCLAW_TEST_LIFECYCLE: lifecycle,
      OPENCLAW_TEST_MERGE_SCRIPT: mergeScript,
      OPENCLAW_TEST_MERGE_STATE_STATUS: scenario.mergeStateStatus ?? "BEHIND",
      OPENCLAW_TEST_POST_AUTO_META: postAutoMeta,
      OPENCLAW_TEST_PRE_AUTO_META: preAutoMeta,
      OPENCLAW_TEST_PUBLISHER_RUN_JSON: JSON.stringify(publisherRun),
      OPENCLAW_TEST_REMOTE_DELETE_ERROR: scenario.remoteDeleteError ?? "",
      OPENCLAW_TEST_REMOTE_READ_ERROR: scenario.remoteReadError ?? "",
      OPENCLAW_TEST_REMOTE_REFS_JSON: scenario.remoteRefsJson ?? "[]",
      OPENCLAW_TEST_REVIEW_ARTIFACTS: scenario.reviewArtifacts ?? "valid",
      OPENCLAW_TEST_REVIEW_RECOMMENDATION: scenario.recommendation ?? "ready",
      OPENCLAW_TEST_RG_CALLS: rgCalls,
      OPENCLAW_TEST_ROOT: root,
      OPENCLAW_TEST_SCRIPTS_DIR: join(process.cwd(), "scripts"),
      OPENCLAW_TEST_WORKFLOW_JOBS_JSON: JSON.stringify(workflowJobs),
      OPENCLAW_TEST_WORKFLOW_RUN_JSON: JSON.stringify(workflowRun),
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
  return {
    ...result,
    calls: existsSync(calls) ? readFileSync(calls, "utf8") : "",
    commentAttempts: existsSync(commentAttempts)
      ? Number(readFileSync(commentAttempts, "utf8").trim())
      : 0,
    commentBody: existsSync(commentBody) ? readFileSync(commentBody, "utf8") : "",
    lifecycle: existsSync(lifecycle) ? readFileSync(lifecycle, "utf8") : "",
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

  it("uses admin squash only for exact trusted Crabbox and hosted infrastructure proof", () => {
    const result = runMerge({ crabboxBypass: "valid", mergeStateStatus: "CLEAN" });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.calls).toContain(
      `plain pr merge 123 --admin --squash --match-head-commit ${headSha}`,
    );
    expect(result.calls.match(/orgs\/openclaw\/memberships\/maintainer/gmu)).toHaveLength(2);
    expect(result.stdout).toContain("Crabbox admin merge bypass verified");
    expect(result.calls).toContain("openclaw/crabbox-gate");
    expect(result.calls).toContain("Hosted CI infrastructure failure");
  });

  it.each([
    ["missing trusted check", "missing"],
    ["wrong check app", "wrong-app"],
    ["stale check SHA", "stale-sha"],
    ["non-admin actor", "non-admin"],
    ["ordinary CI failure", "non-infra"],
  ] as const)("rejects Crabbox bypass with %s", (_label, crabboxBypass) => {
    const result = runMerge({ crabboxBypass });

    expect(result.status).toBe(1);
    expect(result.calls).not.toContain("pr merge 123 --admin");
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Crabbox merge bypass evidence is not sufficient",
    );
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
    expect(result.calls).toContain(`plain pr merge 123 --squash --match-head-commit ${headSha}`);
    expect(result.calls).toContain(`scripts/watch-pr-ci.mjs 123 ${headSha} --completion ci-run`);
    expect(result.calls).toContain("plain pr checks 123 --required --json name,bucket,state");
    expect(result.calls).toContain("path pr view 123 --json state,isDraft");
    expect(result.calls).not.toContain("--required --watch");
    expect(result.calls).not.toContain("--auto");
    expect(result.calls).not.toMatch(/^(?:path|plain) api .*\/commits\//mu);
    expect(result.calls).not.toContain("--json commits");
    expect(result.stdout).toContain("merge-run complete for PR #123");
    expect(result.stdout).toContain(
      "completion comment: https://github.com/openclaw/openclaw/pull/123#issuecomment-1",
    );
    expect(result.commentBody).toBe(
      `Merged via squash.\n\n- Prepared head SHA: [${headSha}](https://github.com/openclaw/openclaw/pull/123/commits/${headSha})\n- Landed commit: [${landedSha}](https://github.com/openclaw/openclaw/commit/${landedSha})`,
    );
    expect(result.rgCalls).toBe("");
    expect(result.calls.match(/^plain api .*git\/.*$/gmu)).toEqual([
      "plain api -X DELETE repos/contributor/fixture/git/refs/heads%2Ftopic%2Fnested",
    ]);
    expect(result.calls).not.toContain("matching-refs");
    expect(result.lifecycle).toBe(
      "comment\nremote-cleanup\nworktree-cleanup .worktrees/pr-123\nbranch-cleanup temp/pr-123\nbranch-cleanup pr-123\nbranch-cleanup pr-123-prep\n",
    );
  });

  it("retries transient structured comment failures exactly three times", () => {
    const result = runMerge({ commentFailures: 2, mergeStateStatus: "CLEAN" });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.commentAttempts).toBe(3);
    expect(result.lifecycle.match(/^comment$/gmu)).toHaveLength(3);
    expect(result.lifecycle).toContain("remote-cleanup");
  });

  it("keeps cleanup metadata failures nonfatal and completes local cleanup", () => {
    const cleanupMetadataError = "gh: connection reset by peer while reading PR head metadata";
    const result = runMerge({ cleanupMetadataError });

    expect(
      { exitCode: result.status, lifecycle: result.lifecycle },
      `${result.stdout}\n${result.stderr}`,
    ).toEqual({
      exitCode: 0,
      lifecycle:
        "comment\nworktree-cleanup .worktrees/pr-123\nbranch-cleanup temp/pr-123\nbranch-cleanup pr-123\nbranch-cleanup pr-123-prep\n",
    });
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Warning: unable to read PR head metadata for remote branch cleanup",
    );
    expect(result.stderr).toContain(cleanupMetadataError);
    expect(result.calls).not.toMatch(/^(?:path|plain) api .*git\//mu);
    expect(result.stdout).toContain("merge-run complete for PR #123");
  });

  it.each<MergeScenario & { name: string; warns: boolean }>([
    {
      name: "already-absent source branch completes cleanup without a false warning",
      remoteDeleteError: "gh: Reference does not exist (HTTP 422)",
      remoteRefsJson: "[]",
      warns: false,
    },
    {
      name: "transport failure after deletion accepts authoritative absence",
      remoteDeleteError: "unexpected EOF after DELETE",
      remoteRefsJson: "[]",
      warns: false,
    },
    {
      name: "longer prefix sibling is neither the target nor another deletion candidate",
      remoteRefsJson: '[{"ref":"refs/heads/topic/nested-more"}]',
      warns: false,
    },
    {
      name: "present source branch warns with the original error and remains nonfatal",
      remoteDeleteError: "gh: Resource not accessible by integration (HTTP 403)",
      remoteRefsJson: '[{"ref":"refs/heads/topic/nested-more"},{"ref":"refs/heads/topic/nested"}]',
      warns: true,
    },
    ...[
      "gh: Bad credentials (HTTP 401)",
      "gh: Not Found (HTTP 404)",
      "connection reset by peer",
    ].map((remoteReadError) => ({
      name: `inaccessible source branch remains nonfatal and warns: ${remoteReadError}`,
      remoteReadError,
      // Even an empty array cannot prove absence when the read failed.
      remoteRefsJson: "[]",
      warns: true,
    })),
    ...[
      "",
      "not JSON",
      "{}",
      "null",
      "[null]",
      "[{}]",
      '[{"ref":123}]',
      '[{"ref":""}]',
      '[{"ref":"refs/tags/topic/nested"}]',
      "[]\n[]",
    ].map((remoteRefsJson) => ({
      name: `invalid ref evidence remains nonfatal and warns: ${JSON.stringify(remoteRefsJson)}`,
      remoteRefsJson,
      warns: true,
    })),
  ])("$name", ({ warns, ...scenario }) => {
    const remoteDeleteError =
      scenario.remoteDeleteError ?? "gh: Resource not accessible by integration (HTTP 403)";
    const result = runMerge({ ...scenario, remoteDeleteError });
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status, output).toBe(0);
    expect(result.stdout).toContain("merge-run complete for PR #123");
    expect(result.lifecycle).toBe(
      "comment\nremote-cleanup\nworktree-cleanup .worktrees/pr-123\nbranch-cleanup temp/pr-123\nbranch-cleanup pr-123\nbranch-cleanup pr-123-prep\n",
    );
    if (warns) {
      expect(output).toContain(
        "Warning: failed to delete remote branch contributor/fixture:topic/nested",
      );
      expect(output).toContain(remoteDeleteError);
      if (scenario.remoteReadError) {
        expect(output).toContain(scenario.remoteReadError);
      }
    } else {
      expect(output).not.toContain("Warning:");
    }
    expect(result.calls.match(/^plain api .*git\/(?:refs|matching-refs)\/.*$/gmu)).toEqual([
      "plain api -X DELETE repos/contributor/fixture/git/refs/heads%2Ftopic%2Fnested",
      "plain api -X GET repos/contributor/fixture/git/matching-refs/heads%2Ftopic%2Fnested",
    ]);
    expect(result.calls).not.toMatch(/^path api .*git\//mu);
    expect(result.calls).not.toContain("--delete-branch");
  });

  it("fails closed without cleanup when structured comment creation never succeeds", () => {
    const result = runMerge({ commentFailures: 3, mergeStateStatus: "CLEAN" });

    expect(result.status).toBe(1);
    expect(result.commentAttempts).toBe(3);
    expect(result.stdout).toContain("Failed to post PR comment after retries");
    expect(result.lifecycle).toBe("comment\ncomment\ncomment\n");
  });

  it("treats an empty structured comment URL as failure and skips cleanup", () => {
    const result = runMerge({ commentEmpty: true, mergeStateStatus: "CLEAN" });

    expect(result.status).toBe(1);
    expect(result.commentAttempts).toBe(3);
    expect(result.stdout).toContain("Failed to post PR comment after retries");
    expect(result.lifecycle).toBe("comment\ncomment\ncomment\n");
  });

  it("enables squash auto-merge only for a verified mergeable BEHIND head", () => {
    const result = runMerge({ auto: true });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.calls).toContain(
      `plain pr merge 123 --auto --squash --match-head-commit ${headSha}`,
    );
    expect(result.calls.match(/^plain pr merge /gmu)).toHaveLength(1);
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
