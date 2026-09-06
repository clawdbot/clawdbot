import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatCrabboxGateCheckSummary } from "../../scripts/pr-lib/crabbox-gate-contract.mjs";
import { validateCrabboxMergeBypass } from "../../scripts/pr-lib/crabbox-merge-bypass.mjs";
import { validClawsweeperReviewCommentPages } from "./pr-review-artifact-fixture.js";

const baseSha = "b".repeat(40);
const headSha = "a".repeat(40);
const workflowSha = "d".repeat(40);
const mainSha = "e".repeat(40);
const planDigest = "c".repeat(64);
const runId = "run_abc123";
const leaseId = "cbx_def456";
const ciRunId = 7001;
const ciGateJobId = 7002;
const failedJobId = 7003;

type WorkflowStep = {
  conclusion: string;
  name: string;
  status: string;
};

function input() {
  return {
    actor: { login: "maintainer" },
    checkRuns: {
      check_runs: [
        {
          app: { id: 15368 },
          conclusion: "skipped",
          details_url: `https://github.com/openclaw/openclaw/actions/runs/${ciRunId}/job/${ciGateJobId}`,
          head_sha: headSha,
          id: 20,
          name: "openclaw/ci-gate",
          status: "completed",
        },
        {
          app: { id: 15368 },
          conclusion: "success",
          details_url: "https://github.com/openclaw/openclaw/actions/runs/8001",
          head_sha: headSha,
          id: 21,
          name: "openclaw/crabbox-gate",
          output: {
            summary: formatCrabboxGateCheckSummary({
              baseSha,
              headSha,
              leaseId,
              planDigest,
              runId,
              targetCount: 8,
              workflowSha,
            }),
          },
          status: "completed",
        },
      ],
    },
    expectedLeaseId: leaseId,
    expectedRunId: runId,
    headSha,
    jobs: {
      jobs: [
        {
          conclusion: "skipped",
          id: ciGateJobId,
          name: "openclaw/ci-gate",
          status: "completed",
        },
        {
          conclusion: "failure",
          id: failedJobId,
          labels: ["blacksmith-4vcpu-ubuntu-2404"],
          name: "check",
          runner_name: null as string | null,
          status: "completed",
          steps: [] as WorkflowStep[],
        },
      ],
    },
    membership: {
      role: "admin",
      state: "active",
      user: { login: "maintainer" },
    },
    finalMainRef: { object: { sha: mainSha }, ref: "refs/heads/main" },
    mainComparison: {
      ahead_by: 3,
      base_commit: { sha: workflowSha },
      behind_by: 0,
      merge_base_commit: { sha: workflowSha },
      status: "ahead",
    },
    mainRef: { object: { sha: mainSha }, ref: "refs/heads/main" },
    pullRequest: {
      base: { ref: "main", repo: { full_name: "openclaw/openclaw" }, sha: baseSha },
      draft: false,
      head: { repo: { full_name: "openclaw/openclaw" }, sha: headSha },
      number: 131091,
      state: "open",
    },
    publisherRun: {
      conclusion: "success",
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: workflowSha,
      id: 8001,
      path: ".github/workflows/pr-crabbox-gate-publisher.yml",
      status: "completed",
    },
    requiredChecks: [{ bucket: "skipping", name: "openclaw/ci-gate", state: "SKIPPED" }],
    workflowRun: {
      conclusion: "failure",
      event: "pull_request",
      head_sha: headSha,
      id: ciRunId,
      path: ".github/workflows/ci.yml",
      status: "completed",
    },
  };
}

describe("Crabbox admin merge bypass verifier", () => {
  it("accepts exact trusted Crabbox proof with hosted infrastructure failure", () => {
    expect(validateCrabboxMergeBypass(input())).toMatchObject({
      actor: "maintainer",
      crabboxCheckId: 21,
      ciGateCheckId: 20,
      ciRunId,
      infrastructureJobs: [
        {
          backend: "blacksmith",
          conclusion: "failure",
          id: failedJobId,
          name: "check",
        },
      ],
      mainSha,
      planDigest,
      targetCount: 8,
      workflowSha,
    });
  });

  it.each([
    [
      "missing Crabbox check",
      (value: ReturnType<typeof input>) => {
        value.checkRuns.check_runs.pop();
      },
      /missing exact-head openclaw\/crabbox-gate/u,
    ],
    [
      "wrong app",
      (value: ReturnType<typeof input>) => {
        value.checkRuns.check_runs[1]!.app.id = 999;
      },
      /app, or result does not match/u,
    ],
    [
      "stale SHA",
      (value: ReturnType<typeof input>) => {
        value.checkRuns.check_runs[1]!.head_sha = "b".repeat(40);
      },
      /exact head/u,
    ],
    [
      "non-admin actor",
      (value: ReturnType<typeof input>) => {
        value.membership.role = "member";
      },
      /not an active openclaw organization admin/u,
    ],
    [
      "pull-ref publisher workflow",
      (value: ReturnType<typeof input>) => {
        value.publisherRun.path =
          ".github/workflows/pr-crabbox-gate-publisher.yml@refs/pull/123/merge";
      },
      /not bound to the current protected-main publisher workflow/u,
    ],
    [
      "summary and publisher SHA mismatch",
      (value: ReturnType<typeof input>) => {
        value.publisherRun.head_sha = "e".repeat(40);
      },
      /not bound to the current protected-main publisher workflow/u,
    ],
    [
      "protected main drift",
      (value: ReturnType<typeof input>) => {
        value.finalMainRef.object.sha = "f".repeat(40);
      },
      /protected main moved/u,
    ],
    [
      "publisher workflow not ancestral to main",
      (value: ReturnType<typeof input>) => {
        value.mainComparison.merge_base_commit.sha = baseSha;
      },
      /protected main is not identical or forward/u,
    ],
    [
      "non-canonical CI workflow path",
      (value: ReturnType<typeof input>) => {
        value.workflowRun.path = ".github/workflows/ci.yml@refs/pull/123/merge";
      },
      /normal CI workflow identity/u,
    ],
    [
      "failed workflow step with spoofed infrastructure text",
      (value: ReturnType<typeof input>) => {
        value.jobs.jobs[1]!.steps = [
          {
            conclusion: "failure",
            name: "The hosted runner encountered an error",
            status: "completed",
          },
        ];
      },
      /has a failed workflow step/u,
    ],
  ])("rejects %s", (_label, mutate, error) => {
    const value = input();
    mutate(value);
    expect(() => validateCrabboxMergeBypass(value)).toThrow(error);
  });

  it.each([
    [".github/workflows/pr-crabbox-gate-publisher.yml", ".github/workflows/ci.yml"],
    [
      ".github/workflows/pr-crabbox-gate-publisher.yml@refs/heads/main",
      ".github/workflows/ci.yml@refs/heads/main",
    ],
  ])("accepts protected-main workflow paths %s", (publisherPath, ciPath) => {
    const value = input();
    value.publisherRun.path = publisherPath;
    value.workflowRun.path = ciPath;
    expect(validateCrabboxMergeBypass(value).planDigest).toBe(planDigest);
  });

  it.each([
    ".github/workflows/ci.yml@refs/pull/123/merge",
    ".github/workflows/ci.yml@refs/tags/v1.0.0",
    ".github/workflows/ci.yml@refs/heads/release",
  ])("rejects non-main CI workflow path %s", (workflowPath) => {
    const value = input();
    value.workflowRun.path = workflowPath;
    expect(() => validateCrabboxMergeBypass(value)).toThrow(/normal CI workflow identity/u);
  });

  it("rejects stale base or altered summary binding", () => {
    const value = input();
    value.pullRequest.base.sha = "d".repeat(40);
    expect(() => validateCrabboxMergeBypass(value)).toThrow(/expected broker proof/u);
  });

  it("rejects another unsatisfied required check", () => {
    const value = input();
    value.requiredChecks.push({ bucket: "fail", name: "security", state: "FAILURE" });
    expect(() => validateCrabboxMergeBypass(value)).toThrow(/only unsatisfied required check/u);
  });

  it("accepts a GitHub-classified workflow startup failure", () => {
    const value = input();
    value.workflowRun.conclusion = "startup_failure";
    value.jobs.jobs.splice(1);
    expect(validateCrabboxMergeBypass(value).infrastructureJobs).toEqual([
      {
        backend: "github-actions",
        conclusion: "startup_failure",
        id: ciRunId,
        name: "workflow startup",
      },
    ]);
  });

  it("rejects a blocking job after any workflow step executed", () => {
    const value = input();
    value.jobs.jobs[1]!.steps = [
      {
        conclusion: "success",
        name: "product tests",
        status: "completed",
      },
    ];
    expect(() => validateCrabboxMergeBypass(value)).toThrow(/only no-step outages may bypass/u);
  });

  it("rejects a zero-step failure after a runner was acquired", () => {
    const value = input();
    value.jobs.jobs[1]!.runner_name = "Blacksmith runner";
    expect(() => validateCrabboxMergeBypass(value)).toThrow(/only unacquired outages may bypass/u);
  });

  it.each(["cancelled", "action_required", "stale"])("rejects a zero-step %s job", (conclusion) => {
    const value = input();
    value.jobs.jobs[1]!.conclusion = conclusion;
    expect(() => validateCrabboxMergeBypass(value)).toThrow(
      /conclusion is not a startup or provisioning outage/u,
    );
  });

  it("rejects an intentionally cancelled workflow run", () => {
    const value = input();
    value.workflowRun.conclusion = "cancelled";
    value.jobs.jobs[1]!.conclusion = "cancelled";
    expect(() => validateCrabboxMergeBypass(value)).toThrow(/normal CI workflow identity/u);
  });
});

function runProtectedShell(
  command: string,
  { role = "admin", state = "active", denied = "", override = false, revoke = false } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "pr-crabbox-protected-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  mkdirSync(join(root, ".local"));
  writeFileSync(join(root, "calls.jsonl"), "");
  const evidence = input();
  const reviewComments = validClawsweeperReviewCommentPages(131091, headSha);
  evidence.membership.role = role;
  evidence.membership.state = state;
  writeFileSync(join(root, "input.json"), JSON.stringify(evidence));
  const gh = join(bin, "gh");
  const protectedGh = `#!${process.execPath}
const fs = require("node:fs");
const cp = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");
const value = JSON.parse(fs.readFileSync("input.json", "utf8"));
const save = () => fs.writeFileSync("input.json", JSON.stringify(value));
const fail = (message, code = 19) => { console.error(message); process.exit(code); };
const out = (data) => console.log(typeof data === "string" ? data : JSON.stringify(data));
const repo = {id:123,nameWithOwner:"openclaw/openclaw",url:"https://github.com/openclaw/openclaw"};
const reviewComments = ${JSON.stringify(reviewComments)};
const pr = {id:"fixture-pr",number:131091,url:repo.url+"/pull/131091",state:"OPEN",isDraft:false,
  headRefOid:value.headSha,headRefName:"topic",baseRefName:"main",baseRefOid:"${baseSha}",
  isCrossRepository:false,mergeable:"MERGEABLE",mergeStateStatus:"BLOCKED",mergeCommit:null,
  autoMergeRequest:null,isInMergeQueue:false,isMergeQueueEnabled:false};
if (args.some(arg => /\\{(?:owner|repo)\\}/u.test(arg))) fail("unresolved repository placeholder");
const endpoint = args.find(arg => /^(?:repos\\/|orgs\\/|user$|graphql$)/u.test(arg));
if (endpoint && endpoint === process.env.FAKE_DENIED) fail("protected refusal");
if (args[0] === "repo" && args[1] === "view") out(args.includes("--jq") ? repo.nameWithOwner : repo);
else if (args[0] === "pr" && args[1] === "checks" && args.includes("--required")) {
  // gh v2.98.0 checks.go exports JSON before applying its human-output exit codes.
  out(value.requiredChecks);
} else if (args[0] === "pr" && args[1] === "view") out(args.includes("--jq") ? pr.headRefOid : pr);
else if (args[0] === "pr" && args[1] === "merge") out("synthetic merge request accepted");
else if (args[0] === "workflow" && args[1] === "run") { value.dispatched = true; save(); }
else if (endpoint === "graphql" && args.some(arg => arg.includes("viewerMergeBodyText"))) {
  out({data:{repository:{pullRequest:{...pr,viewerMergeBodyText:"Reviewed fixture body"}}}});
}
else if (endpoint === "graphql" && args.some(arg => arg.includes("repository(owner:"))) {
  out({data:{repository:{...repo,ref:{target:{oid:"${mainSha}"}},pullRequest:pr}}});
} else if (endpoint === "user") out(args[args.indexOf("--jq")+1] === ".login" ? "relay-reader" : {login:"relay-reader"});
else if (endpoint === "graphql" && args.includes("query=query { viewer { login } }")) {
  const json = JSON.stringify({data:{viewer:value.actor}});
  if (args.includes("--include")) out("HTTP/2.0 200 OK\\n\\n" + json);
  else out(cp.execFileSync("jq", ["-r", args[args.indexOf("--jq") + 1]], {input:json,encoding:"utf8"}).trim());
} else {
  if (!endpoint) fail("unexpected command");
  const mutable = endpoint.startsWith("orgs/") ||
    (!process.env.FAKE_DISPATCH && !/\\/compare\\/|\\/commits\\/[a-f0-9]{40}$/u.test(endpoint));
  if (mutable && !args.some((arg,i) => ["-H", "--header"].includes(arg) && args[i+1] === "Cache-Control: max-age=0")) fail("missing live header", 18);
  if (endpoint.includes("/check-runs?") || endpoint.includes("/jobs?") || endpoint.includes("/issues/131091/comments?")) {
    if (!args.includes("--paginate") || !args.includes("--slurp")) fail("missing pagination");
  }
  const prefix = "repos/openclaw/openclaw/";
  if (endpoint === prefix + "pulls/131091") out(value.pullRequest);
  else if (endpoint === prefix + "issues/131091/comments?per_page=100") out(reviewComments);
  else if (endpoint === prefix + "commits/" + value.headSha + "/check-runs?filter=latest&per_page=100") out(value.checkRuns.check_runs.map(check => ({check_runs:[check]})));
  else if (endpoint === prefix + "actions/workflows/pr-crabbox-gate-publisher.yml/runs") out({workflow_runs:value.dispatched ? [{...value.publisherRun,html_url:repo.url+"/actions/runs/8001",display_title:"PR Crabbox gate #131091 / "+value.headSha}] : []});
  else if (endpoint === prefix + "actions/runs/8001") out({...value.publisherRun,html_url:repo.url+"/actions/runs/8001"});
  else if (endpoint === prefix + "actions/runs/7001") out(value.workflowRun);
  else if (endpoint === prefix + "actions/runs/7001/jobs?filter=latest&per_page=100") out(value.jobs.jobs.map(job => ({jobs:[job]})));
  else if (endpoint === "orgs/openclaw/memberships/maintainer") {
    value.membershipReads = (value.membershipReads || 0) + 1;
    if (process.env.FAKE_REVOKE && value.membershipReads === 2) value.membership.role = "member";
    save(); out(value.membership);
  }
  else if (endpoint === "orgs/openclaw/memberships/relay-reader") out({role:"admin",state:"active",user:{login:"relay-reader"}});
  else if (endpoint === prefix + "git/ref/heads/main") out(value.mainRef);
  else if (endpoint === prefix + "compare/${workflowSha}...${mainSha}") out(value.mainComparison);
  else if (endpoint === "repos/prepared/base/commits/${headSha}") out({parents:[{sha:"${mainSha}"}]});
  else fail("unexpected endpoint: " + endpoint);
}
`;
  writeFileSync(gh, override ? "#!/bin/sh\nexit 19\n" : protectedGh);
  const selected = join(root, "selected-gh");
  writeFileSync(selected, protectedGh);
  chmodSync(gh, 0o755);
  chmodSync(selected, 0o755);
  // Keep all network-capable executables task-local, including explicit gh selection.
  // Node only substitutes the unrelated CI wait; both authorization verifiers run unchanged.
  for (const [name, body] of Object.entries({
    node: `case "$1" in */watch-pr-ci.mjs) exit 0;; esac\nexec '${process.execPath}' "$@"`,
    git: `case "$1" in
      fetch|cat-file|merge-base) exit 0;;
      merge-tree) echo candidate-tree;;
      rev-parse) echo main-tree;;
      -c) exit 0;;
      *) echo "unexpected fixture git: $*" >&2; exit 19;;
    esac`,
    aws: "exit 19",
    crabbox: "exit 19",
  })) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        [
          "set -euo pipefail",
          `script_parent_dir='${process.cwd()}/scripts'`,
          'source "$script_parent_dir/lib/plain-gh.sh"',
          'source "$script_parent_dir/pr-lib/common.sh"',
          'source "$script_parent_dir/pr-lib/gates.sh"',
          'source "$script_parent_dir/pr-lib/merge.sh"',
          command,
        ].join("\n"),
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          HOME: root,
          PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
          GH_TOKEN: "synthetic-token",
          OPENCLAW_GH_BIN: override ? selected : "",
          FAKE_DENIED: denied,
          FAKE_DISPATCH: command.includes("finalize_remote_crabbox_aws_gate") ? "1" : "",
          FAKE_REVOKE: revoke ? "1" : "",
          GATES_MODE: "remote_crabbox_aws",
          REMOTE_GATES_PROVIDER: "aws",
          FULL_GATES_HEAD_SHA: headSha,
          LAST_VERIFIED_HEAD_SHA: headSha,
          REMOTE_GATES_RUN_ID: runId,
          REMOTE_GATES_LEASE_ID: leaseId,
          MERGE_REPO_NAME: "prepared/base",
        },
      },
    );
    const readArtifact = (name: string) => {
      const file = join(root, ".local", name);
      return existsSync(file) && readFileSync(file, "utf8").trim()
        ? JSON.parse(readFileSync(file, "utf8"))
        : undefined;
    };
    return {
      ...result,
      proof: readArtifact("merge-crabbox-bypass.json"),
      audit: readArtifact("merge-crabbox-parent-audit.json"),
      intent: readArtifact("intent.json"),
      calls: readFileSync(join(root, "calls.jsonl"), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Crabbox protected gh request producers", () => {
  it("verifies fresh paginated proof using the authenticated writer and actual repository", () => {
    const result = runProtectedShell(`verify_crabbox_admin_merge_bypass 131091 ${headSha}`);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.proof).toMatchObject({ actor: "maintainer", mainSha, workflowSha, ciRunId });
    expect(result.calls.at(-1)).toContain("repos/openclaw/openclaw/git/ref/heads/main");
    expect(result.calls.filter((args) => args.includes("--paginate"))).toHaveLength(2);
  });

  it.each([false, true])(
    "checks the selected writer's live admin membership (override=%s)",
    (override) => {
      const result = runProtectedShell("require_active_org_admin_for_crabbox_gate", { override });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("maintainer");
    },
  );

  it.each([
    { role: "member", state: "active" },
    { role: "admin", state: "pending" },
  ])("rejects writer membership $state/$role despite the relay's admin identity", (membership) => {
    const result = runProtectedShell("require_active_org_admin_for_crabbox_gate", membership);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires an active openclaw organization admin");
  });

  it("keeps protected refusal terminal without alternate identity or dispatch", () => {
    const result = runProtectedShell("require_active_org_admin_for_crabbox_gate", {
      denied: "graphql",
    });
    expect(result.status).toBe(19);
    expect(result.stderr).toContain("protected refusal");
    expect(result.calls).toHaveLength(1);
  });

  it("audits the immutable landed commit in the prepared repository", () => {
    const result = runProtectedShell(`record_crabbox_landing_parent_audit ${headSha} ${mainSha}`);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.audit).toEqual({
      status: "match",
      landedSha: headSha,
      expectedParentSha: mainSha,
      actualParentSha: mainSha,
    });
    expect(result.calls).toHaveLength(1);
  });
});

// Replace local preparation and Git persistence only. merge_run, merge_verify,
// live identity/membership reads, bypass validation and the merge request remain real.
const mergeAuthorizationCommand = `
enter_worktree() { PR_MAIN_SHA=${mainSha}; }
refresh_main_snapshot() { PR_MAIN_SHA=${mainSha}; }
verify_prep_branch_matches_prepared_head() { :; }
validate_review_artifact_data() { :; }
require_ready_review_recommendation() { :; }
mark_pr_operation_side_effects_started() { :; }
is_canonical_pr_number() { [[ "$1" =~ ^[1-9][0-9]*$ ]]; }
merge_outcome_load_local() { MERGE_OUTCOME_OID=""; MERGE_OUTCOME_RECORD=""; }
merge_outcome_write() { MERGE_OUTCOME_RECORD="$1"; printf '%s\\n' "$1" > .local/intent.json; }
for artifact in review.md review.json pr-meta.env pr-meta.json prep.md; do
  echo fixture > ".local/$artifact"
done
printf '%s\\n' PREP_HEAD_SHA=${headSha} PREP_REPLACED_HOSTED_ANCESTRY=false PREP_AUTHOR_ACCESS=maintainer > .local/prep.env
echo GATES_MODE=remote_crabbox_aws > .local/gates.env
merge_run 131091
`;

describe("Crabbox authorization before final effects", () => {
  it.each(["member", "admin"])("gates remote dispatch on the authenticated %s", (role) => {
    const result = runProtectedShell(`finalize_remote_crabbox_aws_gate 131091 ${headSha}`, {
      role,
    });
    expect(result.status, result.stdout + result.stderr).toBe(role === "admin" ? 0 : 1);
    const viewer = result.calls.findIndex((args) => args.includes("graphql"));
    const membership = result.calls.findIndex((args) =>
      args.includes("orgs/openclaw/memberships/maintainer"),
    );
    const dispatches = result.calls.filter((args) => args[0] === "workflow" && args[1] === "run");
    expect(viewer).toBeGreaterThanOrEqual(0);
    expect(membership).toBeGreaterThan(viewer);
    expect(result.calls.some((args) => args.includes("user"))).toBe(false);
    expect(result.calls.filter((args) => args[0] === "pr" && args[1] === "merge")).toEqual([]);
    expect(dispatches).toHaveLength(role === "admin" ? 1 : 0);
    if (role === "admin") {
      expect(result.calls.indexOf(dispatches[0]!)).toBeGreaterThan(membership);
      expect(dispatches[0]).toEqual([
        "workflow",
        "run",
        "pr-crabbox-gate-publisher.yml",
        "--ref",
        "main",
        "-f",
        "pr_number=131091",
        "-f",
        `head_sha=${headSha}`,
        "-f",
        `base_sha=${baseSha}`,
      ]);
    } else {
      expect(result.stderr).toContain("requires an active openclaw organization admin");
    }
  });

  it.each([
    { role: "member", revoke: false, reads: 1, merges: 0 },
    { role: "admin", revoke: false, reads: 2, merges: 1 },
    { role: "admin", revoke: true, reads: 2, merges: 0 },
  ])(
    "gates admin merge on $role membership (revoked=$revoke)",
    ({ role, revoke, reads, merges }) => {
      const result = runProtectedShell(mergeAuthorizationCommand, { role, revoke });
      const output = result.stdout + result.stderr;
      expect(result.status, output).toBe(1);
      const viewers = result.calls.filter((args) =>
        args.includes("query=query { viewer { login } }"),
      );
      const memberships = result.calls.filter((args) =>
        args.includes("orgs/openclaw/memberships/maintainer"),
      );
      const requests = result.calls.filter((args) => args[0] === "pr" && args[1] === "merge");
      expect(viewers).toHaveLength(reads);
      expect(memberships).toHaveLength(reads);
      expect(requests).toHaveLength(merges);
      expect(result.calls.some((args) => args.includes("user") || args[0] === "workflow")).toBe(
        false,
      );
      if (merges) {
        expect(requests[0]).toEqual([
          "pr",
          "merge",
          "131091",
          "--repo",
          "https://github.com/openclaw/openclaw",
          "--squash",
          "--admin",
          "--match-head-commit",
          headSha,
          "--body-file",
          expect.any(String),
        ]);
        expect(result.calls.indexOf(requests[0]!)).toBeGreaterThan(
          result.calls.indexOf(memberships[1]!),
        );
        expect(result.intent).toMatchObject({ route: "admin", head: headSha, accepted: true });
        // The fake accepts the request without claiming a real merge receipt.
        expect(output).toContain("prior dispatch unresolved");
      } else {
        expect(output).toContain("maintainer is not an active openclaw organization admin");
        expect(result.intent).toBeUndefined();
      }
      if (revoke) {
        expect(output).toContain("merge-verify passed for PR #131091");
        expect(
          result.calls.filter((args) => args.some((arg) => arg.includes("ref(qualifiedName:"))),
        ).toHaveLength(2);
      }
    },
  );
});
