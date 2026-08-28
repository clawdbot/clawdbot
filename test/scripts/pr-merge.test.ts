import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatCrabboxGateCheckSummary } from "../../scripts/pr-lib/crabbox-gate-contract.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const commonScript = join(process.cwd(), "scripts/pr-lib/common.sh");
const mergeScript = join(process.cwd(), "scripts/pr-lib/merge.sh");
const headSha = "0123456789abcdef0123456789abcdef01234567";
const baseSha = "1111111111111111111111111111111111111111";
const workflowSha = "2222222222222222222222222222222222222222";
const mainSha = "4444444444444444444444444444444444444444";
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
  crabboxAuditSerializationFailure?: boolean;
  crabboxParentDrift?: boolean;
  existingAutoMethod?: "" | "MERGE" | "REBASE" | "SQUASH";
  mainDriftOnLateRead?: boolean;
  mergeStateStatus?: string;
  mergeable?: string;
  recommendation?: "ready" | "needs_work";
  remoteDeleteError?: string;
  remoteReadError?: string;
  remoteRefsJson?: string;
  reviewArtifacts?: "valid" | "invalid";
  sourceMessages?: string[];
  previewBody?: string | null;
  previewHead?: string;
  previewQueue?: boolean;
  previewError?: boolean;
  sourceReadError?: boolean;
  mergeMethod?: "squash" | "rebase";
  configuredTrailer?: boolean;
  signedSource?: boolean;
  bodyWriteError?: boolean;
  trailerSeparators?: string;
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
  const landedCommitEvidence = join(localDir, "merge-crabbox-landed-commit.json");
  const mainRefReads = join(root, "main-ref-reads");
  const parentAudit = join(localDir, "merge-crabbox-parent-audit.json");
  const rgCalls = join(root, "rg-calls.log");
  const mergeBody = join(root, "consumed-merge-body");
  const sourceRepo = join(root, "source");
  const trailerMarker = join(root, "trailer-command-called");
  let localHead = headSha;
  if (scenario.sourceMessages) {
    mkdirSync(sourceRepo);
    const git = (args: string[]) => {
      const result = spawnSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.com",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "core.hooksPath=/dev/null",
          ...args,
        ],
        { cwd: sourceRepo, encoding: "utf8" },
      );
      if (result.status !== 0) {
        throw new Error(`Git fixture failed: ${result.stderr}`);
      }
      return result.stdout.trim();
    };
    git(["init", "-q"]);
    git([
      "commit",
      "--allow-empty",
      "-qm",
      "Main change\n\nCo-authored-by: Main Only <main@example.com>",
    ]);
    git(["update-ref", "refs/remotes/origin/main", git(["rev-parse", "HEAD"])]);
    if (scenario.signedSource) {
      const key = join(root, "fixture-signing-key");
      const generated = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
      expect(generated.status, generated.stderr.toString()).toBe(0);
      const allowedSigners = join(root, "allowed-signers");
      writeFileSync(allowedSigners, `fixture@example.com ${readFileSync(`${key}.pub`, "utf8")}`);
      git(["config", "gpg.format", "ssh"]);
      git(["config", "user.signingKey", key]);
      git(["config", "gpg.ssh.allowedSignersFile", allowedSigners]);
    }
    for (const message of scenario.sourceMessages) {
      git([
        "-c",
        `commit.gpgsign=${scenario.signedSource ?? false}`,
        "commit",
        "--allow-empty",
        "-qm",
        message,
      ]);
    }
    localHead = git(["rev-parse", "HEAD"]);
    if (scenario.signedSource) {
      git(["verify-commit", localHead]);
      git(["notes", "add", "-m", "Unrelated operator note", localHead]);
      git(["config", "log.showSignature", "true"]);
      git(["config", "color.ui", "always"]);
      git(["config", "log.decorate", "full"]);
      git(["config", "i18n.logOutputEncoding", "ISO-8859-1"]);
    }
    git([
      "commit",
      "--allow-empty",
      "-qm",
      "Unprepared change\n\nCo-authored-by: Unprepared <unprepared@example.com>",
    ]);
  }
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
      `LOCAL_PREP_HEAD_SHA=${localHead}`,
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
                summary: formatCrabboxGateCheckSummary({
                  baseSha,
                  headSha,
                  leaseId: "cbx_def456",
                  planDigest: "c".repeat(64),
                  runId: "run_abc123",
                  targetCount: 8,
                  workflowSha,
                }),
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
    head_sha: workflowSha,
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
jq() {
  if [ "$OPENCLAW_TEST_CRABBOX_AUDIT_SERIALIZATION_FAILURE" = "true" ] && [ "\${1-}" = "-n" ]; then
    printf '{"status":'
    echo 'fixture jq serialization failure' >&2
    return 1
  fi
  command jq "$@"
}
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
mktemp() {
  if [ "$OPENCLAW_TEST_BODY_WRITE_ERROR" = "true" ] && [[ "\${1-}" = .local/merge-body.* ]]; then
    echo 'body artifact unavailable' >&2
    return 1
  fi
  command mktemp "$@"
}
pr_meta_json() {
  printf '%s\\n' '{"state":"OPEN","isDraft":false,"headRefOid":"${headSha}"}'
}
git() {
  case "\${1-}" in
    log|rev-parse|interpret-trailers|-c)
      if [ "$OPENCLAW_TEST_SOURCE_READ_ERROR" = "true" ] && [[ " $* " = *" log "* ]]; then
        echo 'source object unavailable' >&2
        return 1
      fi
      if [[ " $* " = *" interpret-trailers "* ]]; then
        command git "$@"
      elif [ -d "$OPENCLAW_TEST_SOURCE_REPO" ]; then
        command git -C "$OPENCLAW_TEST_SOURCE_REPO" "$@"
      elif [ "\${1-}" = "rev-parse" ]; then
        printf '%s\\n' '${baseSha}'
      fi
      return
      ;;
  esac
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
      local previous="" arg
      for arg in "$@"; do
        if [ "$previous" = "--body-file" ]; then
          cat "$arg" > "$OPENCLAW_TEST_MERGE_BODY"
        fi
        previous="$arg"
      done
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
              *"/check-runs?"*|*"/commits/$OPENCLAW_TEST_LANDED_SHA") ;;
              *)
                echo 'unexpected repository commit-resolution API probe' >&2
                return 1
                ;;
            esac
            ;;
        esac
      done
      case "$*" in
        *"viewerMergeBodyText"*)
          if [ "$OPENCLAW_TEST_PREVIEW_ERROR" = "true" ]; then
            echo 'preview unavailable' >&2
            return 1
          fi
          printf '%s\\n' "$OPENCLAW_TEST_MERGE_PREVIEW"
          ;;
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
        *"repos/"*"/pulls/123"*)
          printf '%s\\n' '{"number":123,"state":"open","draft":false,"head":{"sha":"${headSha}","repo":{"full_name":"openclaw/openclaw"}},"base":{"sha":"${baseSha}","ref":"main","repo":{"full_name":"openclaw/openclaw"}}}'
          ;;
        *"git/ref/heads/main"*)
          local main_reads=0
          if [ -e "$OPENCLAW_TEST_MAIN_REF_READS" ]; then
            main_reads=$(cat "$OPENCLAW_TEST_MAIN_REF_READS")
          fi
          main_reads=$((main_reads + 1))
          printf '%s\\n' "$main_reads" > "$OPENCLAW_TEST_MAIN_REF_READS"
          if [ "$OPENCLAW_TEST_MAIN_DRIFT_ON_LATE_READ" = "true" ] && [ "$main_reads" -gt 1 ]; then
            printf '%s\\n' '{"ref":"refs/heads/main","object":{"sha":"3333333333333333333333333333333333333333"}}'
          else
            printf '%s\\n' '{"ref":"refs/heads/main","object":{"sha":"${mainSha}"}}'
          fi
          ;;
        *"/compare/${workflowSha}...${mainSha}"*)
          printf '%s\\n' '{"status":"ahead","ahead_by":4,"behind_by":0,"base_commit":{"sha":"${workflowSha}"},"merge_base_commit":{"sha":"${workflowSha}"}}'
          ;;
        *"/commits/${headSha}/check-runs"*)
          printf '[%s]\\n' "$OPENCLAW_TEST_CHECK_RUNS_JSON"
          ;;
        *"/commits/${landedSha}"*)
          if [ "$OPENCLAW_TEST_CRABBOX_PARENT_DRIFT" = "true" ]; then
            printf '%s\\n' '{"sha":"${landedSha}","parents":[{"sha":"${workflowSha}"}]}'
          else
            printf '%s\\n' '{"sha":"${landedSha}","parents":[{"sha":"${mainSha}"}]}'
          fi
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
      ...(scenario.configuredTrailer
        ? {
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_0: "trailer.audit.key",
            GIT_CONFIG_VALUE_0: "Unrequested-Metadata",
            GIT_CONFIG_KEY_1: "trailer.audit.command",
            GIT_CONFIG_VALUE_1:
              'printf invoked > "$OPENCLAW_TEST_TRAILER_MARKER"; printf "unrequested value"',
          }
        : {}),
      OPENCLAW_TEST_TRAILER_MARKER: trailerMarker,
      ...(scenario.trailerSeparators
        ? {
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "trailer.separators",
            GIT_CONFIG_VALUE_0: scenario.trailerSeparators,
          }
        : {}),
      OPENCLAW_TEST_BODY_WRITE_ERROR: String(scenario.bodyWriteError ?? false),
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
      OPENCLAW_TEST_CRABBOX_AUDIT_SERIALIZATION_FAILURE: scenario.crabboxAuditSerializationFailure
        ? "true"
        : "false",
      OPENCLAW_TEST_CRABBOX_BYPASS: scenario.crabboxBypass ?? "",
      OPENCLAW_TEST_CRABBOX_PARENT_DRIFT: scenario.crabboxParentDrift ? "true" : "false",
      OPENCLAW_TEST_DISABLED_AUTO_META: disabledAutoMeta,
      OPENCLAW_TEST_GH_CALLS: calls,
      OPENCLAW_TEST_LANDED_SHA: landedSha,
      OPENCLAW_TEST_LIFECYCLE: lifecycle,
      OPENCLAW_TEST_MAIN_DRIFT_ON_LATE_READ: scenario.mainDriftOnLateRead ? "true" : "false",
      OPENCLAW_TEST_MAIN_REF_READS: mainRefReads,
      OPENCLAW_TEST_MERGE_SCRIPT: mergeScript,
      OPENCLAW_TEST_MERGE_BODY: mergeBody,
      OPENCLAW_TEST_SOURCE_REPO: sourceRepo,
      OPENCLAW_TEST_SOURCE_READ_ERROR: String(scenario.sourceReadError ?? false),
      OPENCLAW_TEST_PREVIEW_ERROR: String(scenario.previewError ?? false),
      OPENCLAW_PR_MERGE_METHOD: scenario.mergeMethod ?? "squash",
      OPENCLAW_TEST_MERGE_PREVIEW: JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              headRefOid: scenario.previewHead ?? headSha,
              isMergeQueueEnabled: scenario.previewQueue ?? false,
              viewerMergeBodyText:
                scenario.previewBody === undefined
                  ? "Server description\n\nCo-authored-by: Maintainer <maintainer@example.com>\n\n"
                  : scenario.previewBody,
            },
          },
        },
      }),
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
    landedCommitEvidence: existsSync(landedCommitEvidence)
      ? readFileSync(landedCommitEvidence, "utf8")
      : "",
    lifecycle: existsSync(lifecycle) ? readFileSync(lifecycle, "utf8") : "",
    parentAudit: existsSync(parentAudit)
      ? JSON.parse(readFileSync(parentAudit, "utf8"))
      : undefined,
    rgCalls: existsSync(rgCalls) ? readFileSync(rgCalls, "utf8") : "",
    mergeBody: existsSync(mergeBody) ? readFileSync(mergeBody, "utf8") : null,
    trailerCommandCalled: existsSync(trailerMarker),
  };
}

describePosix("scripts/pr merge-run", () => {
  it("preserves canonical GitHub trailers despite configured separators", () => {
    const credit = "Co-authored-by: Contributor <contributor@example.com>";
    const result = runMerge({ sourceMessages: [`Repair\n\n${credit}`], trailerSeparators: "%" });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.mergeBody).toBe(
      `Server description\n\nCo-authored-by: Maintainer <maintainer@example.com>\n${credit}\n`,
    );
  });

  it("does not execute configured trailer commands or add unrelated metadata", () => {
    const credit = "Co-authored-by: Contributor <contributor@example.com>";
    const result = runMerge({ sourceMessages: [`Repair\n\n${credit}`], configuredTrailer: true });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.trailerCommandCalled).toBe(false);
    expect(result.mergeBody).toContain(credit);
    expect(result.mergeBody).not.toContain("Unrequested-Metadata");
  });

  it("preserves source coauthors with the server authors in one parsed trailer block", () => {
    const credit = "Co-authored-by: 唐梓夷0668001293 <tang.ziyi@example.com>";
    const result = runMerge({
      sourceMessages: [
        `Owner repair\n\n${credit}`,
        `Second repair\n\n${credit}\nCo-authored-by: Another Contributor <another@example.com>`,
      ],
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.mergeBody, "the merge must consume an explicit attribution body").not.toBeNull();
    expect(result.mergeBody).toContain("Server description");
    const parsed = spawnSync("git", ["interpret-trailers", "--parse", "--no-divider"], {
      encoding: "utf8",
      input: `Synthetic subject\n\n${result.mergeBody ?? ""}`,
    });
    expect(parsed.status, parsed.stderr).toBe(0);
    expect(parsed.stdout.trim().split("\n")).toEqual([
      "Co-authored-by: Maintainer <maintainer@example.com>",
      credit,
      "Co-authored-by: Another Contributor <another@example.com>",
    ]);
    expect(result.mergeBody).not.toContain("Main Only");
    expect(result.mergeBody).not.toContain("Unprepared");
    expect(result.calls).toContain(`--match-head-commit ${headSha}`);
  });

  it("extracts only UTF-8 credit from signed commits despite configured log presentation", () => {
    const credit = "Co-authored-by: Élodie <elodie@example.com>";
    const result = runMerge({ sourceMessages: [`Repair\n\n${credit}`], signedSource: true });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.mergeBody).toBe(
      `Server description\n\nCo-authored-by: Maintainer <maintainer@example.com>\n${credit}\n`,
    );
  });

  it.each([
    "",
    "Server description",
    "Co-authored-by: Maintainer <maintainer@example.com>",
    "Server description\n\nCo-authored-by: Maintainer <maintainer@example.com>\n\n \t\n",
    "Server description\n\n---\n\nMore context\n\nCo-authored-by: Maintainer <maintainer@example.com>",
  ])("preserves the preview and its parsed trailers for body %j", (previewBody) => {
    const credit = "Co-authored-by: Contributor <contributor@example.com>";
    const result = runMerge({ sourceMessages: [`Repair\n\n${credit}`], previewBody });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const preview = previewBody.trimEnd();
    const separator = !preview ? "" : preview.includes("Co-authored-by:") ? "\n" : "\n\n";
    expect(result.mergeBody).toBe(`${preview}${separator}${credit}\n`);
  });

  it("does not duplicate an existing trailer or mistake prose for a trailer", () => {
    const credit = "Co-authored-by: Contributor <contributor@example.com>";
    const previewBody = `Quoted example: ${credit}\n\nNot a trailer.`;
    const present = runMerge({ sourceMessages: [`Repair\n\n${credit}`], previewBody: credit });
    expect(present.status, present.stderr).toBe(0);
    expect(present.mergeBody).toBe(`${credit}\n`);
    const prose = runMerge({ sourceMessages: [`Repair\n\n${credit}`], previewBody });
    expect(prose.status, prose.stderr).toBe(0);
    expect(prose.mergeBody).toBe(`${previewBody}\n\n${credit}\n`);
  });

  it.each<MergeScenario>([
    { previewError: true },
    { previewBody: null },
    { previewHead: "b".repeat(40) },
    { previewQueue: true },
    { sourceReadError: true },
    { bodyWriteError: true },
  ])("refuses before merge when attribution evidence is unavailable: %j", (failure) => {
    const result = runMerge({
      sourceMessages: ["Repair\n\nCo-authored-by: Contributor <contributor@example.com>"],
      ...failure,
    });
    expect(result.status).toBe(1);
    expect(result.calls).not.toContain("pr merge");
    expect(result.mergeBody).toBeNull();
  });

  it.each<MergeScenario>([
    { auto: true },
    { auto: true, existingAutoMethod: "MERGE" },
    { auto: true, autoResult: "unavailable" },
    { crabboxBypass: "valid", mergeStateStatus: "CLEAN" },
  ])("passes the verified body to every existing squash submission route: %j", (route) => {
    const credit = "Co-authored-by: Contributor <contributor@example.com>";
    const result = runMerge({ sourceMessages: [`Repair\n\n${credit}`], ...route });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.mergeBody).toContain(credit);
    const submissions = result.calls
      .split("\n")
      .filter((line) => line.startsWith("plain pr merge "));
    expect(submissions.length).toBeGreaterThan(0);
    for (const submission of submissions) {
      if (submission.includes("--disable-auto")) {
        expect(submission).not.toContain("--body-file");
      } else {
        expect(submission).toContain(`--match-head-commit ${headSha} --body-file `);
      }
    }
  });

  it("keeps no-credit and rebase submissions free of a squash body override", () => {
    for (const scenario of [
      { sourceMessages: ["Ordinary repair"] },
      {
        sourceMessages: ["Repair\n\nCo-authored-by: Contributor <contributor@example.com>"],
        mergeMethod: "rebase" as const,
      },
    ]) {
      const result = runMerge(scenario);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.mergeBody).toBeNull();
      expect(result.calls).not.toContain("viewerMergeBodyText");
      expect(result.calls).not.toContain("--body-file");
    }
  });

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
    expect(result.calls).toContain("git/ref/heads/main");
    expect(result.calls).toContain("Hosted CI infrastructure failure");
    const finalMainRead = result.calls.lastIndexOf("git/ref/heads/main");
    const mergeMutation = result.calls.indexOf("plain pr merge 123 --admin");
    expect(finalMainRead).toBeGreaterThan(-1);
    expect(mergeMutation).toBeGreaterThan(finalMainRead);
    expect(result.calls.slice(finalMainRead, mergeMutation)).not.toContain("plain api");
    expect(result.stdout).toContain(
      `Crabbox landing parent audit matched: landed=${landedSha} parent=${mainSha}`,
    );
    expect(result.parentAudit).toEqual({
      actualParentSha: mainSha,
      expectedParentSha: mainSha,
      landedSha,
      status: "match",
    });
    expect(result.calls).toContain(
      `Landing parent audit: match (expected \`${mainSha}\`, actual \`${mainSha}\`)`,
    );
  });

  it("rejects protected main moving at the final pre-merge read", () => {
    const result = runMerge({
      crabboxBypass: "valid",
      mainDriftOnLateRead: true,
      mergeStateStatus: "CLEAN",
    });

    expect(result.status).toBe(1);
    expect(result.calls).not.toContain("plain pr merge 123 --admin");
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "Crabbox merge bypass evidence is not sufficient",
    );
  });

  it("rejects a workflow-only squash parent after main advanced before merge", () => {
    const result = runMerge({
      crabboxBypass: "valid",
      crabboxParentDrift: true,
      mergeStateStatus: "CLEAN",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.calls).toContain(
      `plain pr merge 123 --admin --squash --match-head-commit ${headSha}`,
    );
    expect(result.stdout).toContain(
      `Crabbox landing parent audit drift: landed=${landedSha} expected_parent=${mainSha} actual_parent=${workflowSha}`,
    );
    expect(result.stdout).toContain("The merge already completed after intervening main movement");
    expect(result.parentAudit).toEqual({
      actualParentSha: workflowSha,
      expectedParentSha: mainSha,
      landedSha,
      status: "drift",
    });
    expect(result.calls).toContain(
      `Landing parent audit: drift after intervening main movement; merge already completed (expected \`${mainSha}\`, actual \`${workflowSha}\`)`,
    );
  });

  it("fails after merge without a false audit or completion comment when audit serialization fails", () => {
    const result = runMerge({
      crabboxAuditSerializationFailure: true,
      crabboxBypass: "valid",
      mergeStateStatus: "CLEAN",
    });

    expect(result.status).toBe(1);
    expect(result.calls).toContain(
      `plain pr merge 123 --admin --squash --match-head-commit ${headSha}`,
    );
    expect(result.calls).toContain(`plain api repos/{owner}/{repo}/commits/${landedSha}`);
    expect(result.landedCommitEvidence).toContain(`"sha":"${landedSha}"`);
    expect(result.parentAudit).toBeUndefined();
    expect(result.commentAttempts).toBe(0);
    expect(result.commentBody).toBe("");
    expect(result.stdout).not.toContain("Crabbox landing parent audit matched");
    expect(result.stderr).toContain(
      "merge completed; post-merge audit failed: unable to serialize landing parent evidence.",
    );
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
