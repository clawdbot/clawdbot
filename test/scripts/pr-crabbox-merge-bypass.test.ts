import { describe, expect, it } from "vitest";
import { validateCrabboxMergeBypass } from "../../scripts/pr-lib/crabbox-merge-bypass.mjs";

const headSha = "a".repeat(40);
const runId = "run_abc123";
const leaseId = "cbx_def456";
const ciRunId = 7001;
const ciGateJobId = 7002;
const failedJobId = 7003;

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
            summary: `Trusted Crabbox AWS proof ${runId} / ${leaseId}; build, check, and check:changed passed on exact head ${headSha}.`,
          },
          status: "completed",
        },
      ],
    },
    expectedLeaseId: leaseId,
    expectedRunId: runId,
    headSha,
    jobLogs: {
      [failedJobId]: "The hosted runner encountered an error while running this job.",
    },
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
          runner_name: "Blacksmith runner",
          status: "completed",
        },
      ],
    },
    membership: {
      role: "admin",
      state: "active",
      user: { login: "maintainer" },
    },
    publisherRun: {
      conclusion: "success",
      event: "workflow_dispatch",
      head_branch: "main",
      id: 8001,
      path: ".github/workflows/pr-crabbox-gate-publisher.yml@refs/heads/main",
      status: "completed",
    },
    requiredChecks: [{ bucket: "fail", name: "openclaw/ci-gate", state: "SKIPPED" }],
    workflowRun: {
      conclusion: "failure",
      event: "pull_request",
      head_sha: headSha,
      id: ciRunId,
      path: ".github/workflows/ci.yml@refs/pull/123/merge",
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
      "untrusted publisher workflow",
      (value: ReturnType<typeof input>) => {
        value.publisherRun.path = ".github/workflows/ci.yml@refs/heads/main";
      },
      /not bound to the protected-main publisher workflow/u,
    ],
    [
      "non-infrastructure failure",
      (value: ReturnType<typeof input>) => {
        value.jobLogs[failedJobId] = "AssertionError: expected true to be false";
      },
      /not a recognized infrastructure failure/u,
    ],
  ])("rejects %s", (_label, mutate, error) => {
    const value = input();
    mutate(value);
    expect(() => validateCrabboxMergeBypass(value)).toThrow(error);
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
    value.jobLogs = {};
    expect(validateCrabboxMergeBypass(value).infrastructureJobs).toEqual([
      {
        backend: "github-actions",
        conclusion: "startup_failure",
        id: ciRunId,
        name: "workflow startup",
      },
    ]);
  });
});
