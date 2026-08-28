import { describe, expect, it } from "vitest";
import { formatCrabboxGateCheckSummary } from "../../scripts/pr-lib/crabbox-gate-contract.mjs";
import { validateCrabboxMergeBypass } from "../../scripts/pr-lib/crabbox-merge-bypass.mjs";

const baseSha = "b".repeat(40);
const headSha = "a".repeat(40);
const workflowSha = "d".repeat(40);
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
    mainRef: { object: { sha: workflowSha }, ref: "refs/heads/main" },
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
    requiredChecks: [{ bucket: "fail", name: "openclaw/ci-gate", state: "SKIPPED" }],
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
        value.mainRef.object.sha = "e".repeat(40);
      },
      /not bound to the current protected-main publisher workflow/u,
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
