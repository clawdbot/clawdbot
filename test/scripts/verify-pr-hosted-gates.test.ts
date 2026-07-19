import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  collectHostedGateEvidence as collectHostedGateEvidenceRaw,
  compareCommitPageCount,
  HOSTED_GATE_MAX_AGE_HOURS,
  parseArgs,
  parseWorkflowRunPage,
  SCHEDULED_HOSTED_WORKFLOWS,
  workflowRunQueryPaths,
  workflowRunPageCount,
} from "../../scripts/verify-pr-hosted-gates.mjs";

const sha = "773ffd87a1e1e34451ad6e38fda37380c2569a50";
const previousSha = "8d86c44c6144f8f726a460914cddb8c9c201f119";
const pr = 100606;
const nowMs = Date.parse("2026-06-17T10:55:00Z");
const BUILD_ARTIFACTS_WORKFLOW = "Blacksmith Build Artifacts Testbox";
const requiredCliArgs = [
  "--repo",
  "openclaw/openclaw",
  "--sha",
  sha,
  "--pr",
  String(pr),
  "--output",
  ".local/gates-hosted-checks.json",
];

function successfulRun(name: string, id: number, updatedAt: string) {
  return {
    id,
    name,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: sha,
    head_branch: "codex/clean-expanded-tool-calls",
    head_repository: { full_name: "openclaw/openclaw" },
    pull_requests: [{ number: pr }],
    path: ".github/workflows/ci.yml",
    created_at: "2026-06-17T10:46:24Z",
    updated_at: updatedAt,
    html_url: `https://github.com/openclaw/openclaw/actions/runs/${id}`,
  };
}

function releaseGateRun(id: number, updatedAt: string) {
  return {
    ...successfulRun(`CI release gate ${sha}`, id, updatedAt),
    event: "workflow_dispatch",
    display_title: `CI release gate ${sha}`,
  };
}

function queuedBuildArtifactFallbackRuns() {
  return [
    releaseGateRun(1, "2026-06-17T10:49:00Z"),
    successfulRun("CI", 3, "2026-06-17T10:51:00Z"),
    successfulRun("Blacksmith Testbox", 4, "2026-06-17T10:52:00Z"),
    successfulRun("Blacksmith ARM Testbox", 5, "2026-06-17T10:53:00Z"),
    successfulRun("Workflow Sanity", 6, "2026-06-17T10:54:00Z"),
    {
      ...successfulRun(BUILD_ARTIFACTS_WORKFLOW, 2, "2026-06-17T10:50:00Z"),
      status: "queued",
      conclusion: null,
    },
  ];
}

function collectHostedGateEvidence(
  options: Omit<Parameters<typeof collectHostedGateEvidenceRaw>[0], "nowMs" | "pr">,
) {
  return collectHostedGateEvidenceRaw({ nowMs, pr, ...options });
}

describe("verify-pr-hosted-gates", () => {
  it("accepts an in-progress CI run whose own attempt's ci-gate job succeeded", () => {
    const inProgressRun = {
      ...successfulRun("CI", 42, "2026-06-17T10:52:00Z"),
      status: "in_progress",
      conclusion: null,
      run_attempt: 2,
    };
    const gateJob = {
      name: "openclaw/ci-gate",
      run_id: 42,
      run_attempt: 2,
      status: "completed",
      conclusion: "success",
      completed_at: "2026-06-17T10:51:30Z",
    };

    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns: [inProgressRun],
      ciGateJobs: [gateJob],
    });
    expect(evidence.workflows.map((workflow: { id: unknown }) => workflow.id)).toContain(42);

    // A prior attempt's gate (same run id, older run_attempt) cannot vouch for
    // a partial rerun in progress.
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [inProgressRun],
        ciGateJobs: [{ ...gateJob, run_attempt: 1 }],
      }),
    ).toThrow(/Missing successful recent CI workflow/);

    // A gate job from a different run, a failed gate, and a missing gate all
    // fall back to requiring run completion.
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [inProgressRun],
        ciGateJobs: [{ ...gateJob, run_id: 41 }],
      }),
    ).toThrow(/Missing successful recent CI workflow/);
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [inProgressRun],
        ciGateJobs: [{ ...gateJob, conclusion: "failure" }],
      }),
    ).toThrow(/Missing successful recent CI workflow/);
    expect(() =>
      collectHostedGateEvidence({ sha, workflowRuns: [inProgressRun], ciGateJobs: [] }),
    ).toThrow(/Missing successful recent CI workflow/);
  });

  it("lets a gate-proven pending rerun win over an older terminal failure", () => {
    const failedRun = {
      ...successfulRun("CI", 40, "2026-06-17T10:40:00Z"),
      conclusion: "failure",
    };
    const pendingRerun = {
      ...successfulRun("CI", 42, "2026-06-17T10:52:00Z"),
      status: "in_progress",
      conclusion: null,
      run_attempt: 1,
      created_at: "2026-06-17T10:50:00Z",
    };
    const gateJob = {
      name: "openclaw/ci-gate",
      run_id: 42,
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      completed_at: "2026-06-17T10:51:30Z",
    };

    // The newer pending run is re-resolving the failure; its successful gate
    // proves the selected lanes, so the stale failure must not block.
    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns: [failedRun, pendingRerun],
      ciGateJobs: [gateJob],
    });
    expect(evidence.workflows.map((workflow: { id: unknown }) => workflow.id)).toContain(42);

    // Without gate proof the pending run still blocks (no early acceptance),
    // and a failure that IS the latest scheduled run still blocks outright.
    expect(() =>
      collectHostedGateEvidence({ sha, workflowRuns: [failedRun, pendingRerun], ciGateJobs: [] }),
    ).toThrow(/Missing successful recent CI workflow/);
    expect(() =>
      collectHostedGateEvidence({ sha, workflowRuns: [failedRun], ciGateJobs: [gateJob] }),
    ).toThrow(/Missing successful recent CI workflow/);

    // A stalled OLDER run's gate must not mask a newer terminal failure.
    const stalledOlderRun = { ...pendingRerun, created_at: "2026-06-17T10:40:00Z" };
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [failedRun, stalledOlderRun],
        ciGateJobs: [gateJob],
      }),
    ).toThrow(/Missing successful recent CI workflow/);
  });

  it("requires the latest scheduled workflow run to pass", () => {
    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns: [
        successfulRun("CI", 1, "2026-06-17T10:47:00Z"),
        {
          ...successfulRun("Blacksmith Testbox", 2, "2026-06-17T10:47:30Z"),
          event: "workflow_dispatch",
        },
        successfulRun("Blacksmith Testbox", 3, "2026-06-17T10:48:00Z"),
        successfulRun("Blacksmith ARM Testbox", 4, "2026-06-17T10:49:00Z"),
        successfulRun("Blacksmith Build Artifacts Testbox", 5, "2026-06-17T10:50:00Z"),
        successfulRun("Workflow Sanity", 6, "2026-06-17T10:51:00Z"),
      ],
    });

    expect(evidence).toEqual({
      headSha: sha,
      workflows: [
        expect.objectContaining({ name: "CI", id: 1 }),
        expect.objectContaining({ name: "Blacksmith Testbox", id: 3 }),
        expect.objectContaining({ name: "Blacksmith ARM Testbox", id: 4 }),
        expect.objectContaining({ name: "Blacksmith Build Artifacts Testbox", id: 5 }),
        expect.objectContaining({ name: "Workflow Sanity", id: 6 }),
      ],
    });
  });

  it("rejects a failed rerun of a workflow that was scheduled for the exact head", () => {
    const workflowRuns = ["CI", ...SCHEDULED_HOSTED_WORKFLOWS].map((name, index) =>
      successfulRun(name, index + 1, `2026-06-17T10:4${index}:00Z`),
    );
    workflowRuns[2] = {
      ...expectDefined(workflowRuns[2], "Blacksmith ARM Testbox workflow run"),
      conclusion: "failure",
      updated_at: "2026-06-17T10:50:00Z",
    };

    expect(() => collectHostedGateEvidence({ sha, workflowRuns })).toThrow(
      "Missing successful recent Blacksmith ARM Testbox workflow",
    );
  });

  it("accepts a sole scheduled CI run at the 24-hour boundary", () => {
    expect(
      collectHostedGateEvidence({
        sha,
        workflowRuns: [successfulRun("CI", 1, "2026-06-16T10:55:00Z")],
      }),
    ).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ name: "CI", id: 1 })],
    });
  });

  it("accepts 13-hour green evidence from the recorded pre-rebase head", () => {
    const evidence = collectHostedGateEvidence({
      sha,
      recentSha: previousSha,
      workflowRuns: [
        {
          ...successfulRun("CI", 1, "2026-06-16T21:55:00Z"),
          head_sha: previousSha,
        },
        {
          ...successfulRun("CI", 2, "2026-06-17T10:54:00Z"),
          status: "in_progress",
          conclusion: null,
        },
      ],
    });

    expect(evidence).toEqual({
      headSha: sha,
      evidenceHeadSha: previousSha,
      workflows: [expect.objectContaining({ name: "CI", id: 1, headSha: previousSha })],
    });
  });

  it("accepts recent green evidence from an earlier head of the same PR", () => {
    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns: [
        {
          ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
          head_sha: previousSha,
        },
        {
          ...successfulRun("CI", 2, "2026-06-17T10:54:00Z"),
          status: "in_progress",
          conclusion: null,
        },
      ],
    });

    expect(evidence).toEqual({
      headSha: sha,
      evidenceHeadSha: previousSha,
      workflows: [expect.objectContaining({ name: "CI", id: 1, headSha: previousSha })],
    });
  });

  it("accepts a recent green fork head when GitHub omits pull request links", () => {
    const headBranch = "fix/token-listener";
    const headRepository = "contributor/openclaw";
    const evidence = collectHostedGateEvidence({
      sha,
      pullRequestCommitShas: [previousSha, sha],
      pullRequestHeadBranch: headBranch,
      pullRequestHeadRepository: headRepository,
      workflowRuns: [
        {
          ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
          head_sha: previousSha,
          head_branch: headBranch,
          head_repository: { full_name: headRepository },
          pull_requests: [],
        },
        {
          ...successfulRun("CI", 2, "2026-06-17T10:54:00Z"),
          head_branch: headBranch,
          head_repository: { full_name: headRepository },
          pull_requests: [],
          conclusion: "failure",
        },
      ],
    });

    expect(evidence).toEqual({
      headSha: sha,
      evidenceHeadSha: previousSha,
      workflows: [expect.objectContaining({ name: "CI", id: 1, headSha: previousSha })],
    });
  });

  it("rejects an unlinked fork run whose head is absent from the PR commit list", () => {
    expect(() =>
      collectHostedGateEvidence({
        sha,
        pullRequestCommitShas: [sha],
        pullRequestHeadBranch: "fix/token-listener",
        pullRequestHeadRepository: "other/openclaw",
        workflowRuns: [
          {
            ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
            head_sha: previousSha,
            head_branch: "fix/token-listener",
            head_repository: { full_name: "other/openclaw" },
            pull_requests: [],
          },
          {
            ...successfulRun("CI", 2, "2026-06-17T10:54:00Z"),
            conclusion: "failure",
          },
        ],
      }),
    ).toThrow(`Missing successful recent CI workflow for ${sha}`);
  });

  it("rejects a commit-list run explicitly linked to another PR", () => {
    expect(() =>
      collectHostedGateEvidence({
        sha,
        pullRequestCommitShas: [previousSha, sha],
        pullRequestHeadBranch: "fix/token-listener",
        pullRequestHeadRepository: "contributor/openclaw",
        workflowRuns: [
          {
            ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
            head_sha: previousSha,
            pull_requests: [{ number: pr + 1 }],
          },
          {
            ...successfulRun("CI", 2, "2026-06-17T10:54:00Z"),
            conclusion: "failure",
          },
        ],
      }),
    ).toThrow(`Missing successful recent CI workflow for ${sha}`);
  });

  it("paginates comparisons beyond the pull-request endpoint's 250-commit cap", () => {
    expect(compareCommitPageCount(0)).toBe(1);
    expect(compareCommitPageCount(250)).toBe(3);
    expect(compareCommitPageCount(251)).toBe(3);
    expect(compareCommitPageCount(301)).toBe(4);
  });

  it("requires recent evidence for scheduled gates observed on the target head", () => {
    const targetArmRun = {
      ...successfulRun("Blacksmith ARM Testbox", 3, "2026-06-17T10:54:00Z"),
      status: "queued",
      conclusion: null,
    };
    const workflowRuns = [
      {
        ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
        head_sha: previousSha,
      },
      {
        ...successfulRun("CI", 2, "2026-06-17T10:54:00Z"),
        status: "in_progress",
        conclusion: null,
      },
      targetArmRun,
    ];

    expect(() => collectHostedGateEvidence({ sha, recentSha: previousSha, workflowRuns })).toThrow(
      `Missing successful recent Blacksmith ARM Testbox workflow for ${previousSha}`,
    );

    const evidence = collectHostedGateEvidence({
      sha,
      recentSha: previousSha,
      workflowRuns: [
        ...workflowRuns,
        {
          ...successfulRun("Blacksmith ARM Testbox", 4, "2026-06-17T10:51:00Z"),
          head_sha: previousSha,
        },
      ],
    });
    expect(evidence.workflows).toEqual([
      expect.objectContaining({ name: "CI", headSha: previousSha }),
      expect.objectContaining({ name: "Blacksmith ARM Testbox", headSha: previousSha }),
    ]);
  });

  it.each(["failure", "cancelled", "skipped"])(
    "reuses recent same-PR green evidence after a current-head %s run",
    (conclusion) => {
      const evidence = collectHostedGateEvidence({
        sha,
        recentSha: previousSha,
        workflowRuns: [
          {
            ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
            head_sha: previousSha,
          },
          {
            ...successfulRun("CI", 2, "2026-06-17T10:54:00Z"),
            conclusion,
          },
        ],
      });

      expect(evidence).toEqual({
        headSha: sha,
        evidenceHeadSha: previousSha,
        workflows: [expect.objectContaining({ name: "CI", id: 1, headSha: previousSha })],
      });
    },
  );

  it("does not reuse green evidence from another PR", () => {
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          {
            ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
            head_sha: previousSha,
            pull_requests: [{ number: pr + 1 }],
          },
          {
            ...successfulRun("CI", 2, "2026-06-17T10:54:00Z"),
            status: "in_progress",
            conclusion: null,
          },
        ],
      }),
    ).toThrow(`Missing successful recent CI workflow for ${sha}`);
  });

  it("requires the complete recent gate cohort from the recorded head", () => {
    expect(() =>
      collectHostedGateEvidence({
        sha,
        recentSha: previousSha,
        workflowRuns: [
          {
            ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
            head_sha: previousSha,
          },
          {
            ...successfulRun("Blacksmith ARM Testbox", 2, "2026-06-17T10:51:00Z"),
            head_sha: previousSha,
            conclusion: "failure",
          },
          {
            ...successfulRun("CI", 3, "2026-06-17T10:54:00Z"),
            status: "in_progress",
            conclusion: null,
          },
        ],
      }),
    ).toThrow(`Missing successful recent Blacksmith ARM Testbox workflow for ${previousSha}`);
  });

  it("does not drop an applicable scheduled gate when its success is stale", () => {
    expect(() =>
      collectHostedGateEvidence({
        sha,
        recentSha: previousSha,
        workflowRuns: [
          {
            ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
            head_sha: previousSha,
          },
          {
            ...successfulRun("Blacksmith ARM Testbox", 2, "2026-06-16T10:54:59Z"),
            head_sha: previousSha,
          },
          {
            ...successfulRun("CI", 3, "2026-06-17T10:54:00Z"),
            status: "in_progress",
            conclusion: null,
          },
        ],
      }),
    ).toThrow(`Missing successful recent Blacksmith ARM Testbox workflow for ${previousSha}`);
  });

  it("reuses pre-rebase green evidence after a failed current-head manual gate", () => {
    const evidence = collectHostedGateEvidence({
      sha,
      recentSha: previousSha,
      workflowRuns: [
        {
          ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
          head_sha: previousSha,
        },
        {
          ...successfulRun("CI", 2, "2026-06-17T10:53:00Z"),
          status: "in_progress",
          conclusion: null,
        },
        {
          ...successfulRun(`CI release gate ${sha}`, 3, "2026-06-17T10:54:00Z"),
          event: "workflow_dispatch",
          display_title: `CI release gate ${sha}`,
          conclusion: "failure",
        },
      ],
    });

    expect(evidence).toEqual({
      headSha: sha,
      evidenceHeadSha: previousSha,
      workflows: [expect.objectContaining({ name: "CI", id: 1, headSha: previousSha })],
    });
  });

  it("rejects stale or unrecorded fallback heads", () => {
    const unrelatedSha = "ec159b0222cf4fa21b318317a7c5a29d52c846d2";
    const currentPending = {
      ...successfulRun("CI", 2, "2026-06-17T10:54:00Z"),
      status: "in_progress",
      conclusion: null,
    };
    const staleRun = {
      ...successfulRun("CI", 3, "2026-06-16T10:54:59Z"),
      head_sha: previousSha,
    };
    expect(() =>
      collectHostedGateEvidence({
        sha,
        recentSha: previousSha,
        workflowRuns: [staleRun, currentPending],
      }),
    ).toThrow(`Missing successful recent CI workflow for ${previousSha}`);

    const recentUnrelatedRun = {
      ...successfulRun("CI", 4, "2026-06-17T10:50:00Z"),
      head_sha: unrelatedSha,
      pull_requests: [{ number: pr + 1 }],
    };
    expect(() =>
      collectHostedGateEvidence({
        sha,
        recentSha: previousSha,
        workflowRuns: [recentUnrelatedRun, currentPending],
      }),
    ).toThrow(`Missing successful recent CI workflow for ${previousSha}`);
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [{ ...recentUnrelatedRun, head_sha: previousSha }, currentPending],
      }),
    ).toThrow(`Missing successful recent CI workflow for ${sha}`);
  });

  it("allows a later scheduled success to clear an earlier current-head failure", () => {
    expect(
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          {
            ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
            conclusion: "failure",
          },
          successfulRun("CI", 2, "2026-06-17T10:52:00Z"),
        ],
      }),
    ).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ name: "CI", id: 2, headSha: sha })],
    });
  });

  it("does not let a late failure from an obsolete head override a green target head", () => {
    expect(
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
          {
            ...successfulRun("CI", 2, "2026-06-17T10:54:00Z"),
            head_sha: previousSha,
            conclusion: "failure",
          },
        ],
      }),
    ).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ name: "CI", id: 1, headSha: sha })],
    });
  });

  it("uses the latest CI run when an older duplicate was cancelled", () => {
    expect(
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          {
            ...successfulRun("CI", 1, "2026-06-17T10:47:00Z"),
            conclusion: "cancelled",
          },
          successfulRun("CI", 2, "2026-06-17T10:48:00Z"),
        ],
      }),
    ).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ name: "CI", id: 2 })],
    });
  });

  it("accepts an exact-SHA manual CI release gate at the 24-hour boundary", () => {
    expect(
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          {
            ...successfulRun(`CI release gate ${sha}`, 1, "2026-06-16T10:55:00Z"),
            event: "workflow_dispatch",
            path: ".github/workflows/ci.yml@refs/heads/release-controls",
            display_title: `CI release gate ${sha}`,
          },
        ],
      }),
    ).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ name: `CI release gate ${sha}`, id: 1 })],
    });
  });

  it.each([
    ["scheduled", successfulRun("CI", 1, "2026-06-16T10:54:59Z")],
    ["manual", releaseGateRun(2, "2026-06-16T10:54:59Z")],
  ])("rejects exact-head %s CI evidence older than 24 hours", (_kind, run) => {
    expect(() => collectHostedGateEvidence({ sha, workflowRuns: [run] })).toThrow(
      `Missing successful recent CI workflow for ${sha}`,
    );
  });

  it.each([
    [
      "queued",
      {
        ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
        status: "queued",
        conclusion: null,
      },
    ],
    ["stale", successfulRun("CI", 1, "2026-06-16T10:54:59Z")],
  ])("prefers a fresh exact release gate while scheduled CI is %s", (_state, scheduledRun) => {
    expect(
      collectHostedGateEvidence({
        sha,
        workflowRuns: [scheduledRun, releaseGateRun(2, "2026-06-17T10:49:00Z")],
      }),
    ).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ name: `CI release gate ${sha}`, id: 2 })],
    });
  });

  it("rejects a completed scheduled CI failure even when a fallback passed", () => {
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          {
            ...successfulRun("CI", 1, "2026-06-16T10:54:59Z"),
            conclusion: "failure",
          },
          {
            ...successfulRun(`CI release gate ${sha}`, 2, "2026-06-17T10:49:00Z"),
            event: "workflow_dispatch",
            display_title: `CI release gate ${sha}`,
          },
        ],
      }),
    ).toThrow("Missing successful recent CI workflow");
  });

  it("does not mask a failed CI run with a queued rerun and release-gate fallback", () => {
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          {
            ...successfulRun("CI", 1, "2026-06-17T10:47:00Z"),
            conclusion: "failure",
          },
          {
            ...successfulRun("CI", 2, "2026-06-17T10:48:00Z"),
            status: "in_progress",
            conclusion: null,
          },
          {
            ...successfulRun(`CI release gate ${sha}`, 3, "2026-06-17T10:49:00Z"),
            event: "workflow_dispatch",
            display_title: `CI release gate ${sha}`,
          },
        ],
      }),
    ).toThrow("Missing successful recent CI workflow");
  });

  it("covers a queued artifact Testbox only with a completed exact CI fallback", () => {
    expect(
      collectHostedGateEvidence({
        sha,
        workflowRuns: queuedBuildArtifactFallbackRuns(),
      }),
    ).toEqual({
      headSha: sha,
      workflows: [
        expect.objectContaining({ name: "CI", id: 3 }),
        expect.objectContaining({ name: "Blacksmith Testbox", id: 4 }),
        expect.objectContaining({ name: "Blacksmith ARM Testbox", id: 5 }),
        expect.objectContaining({ name: "Workflow Sanity", id: 6 }),
      ],
      fallbackCoveredWorkflows: [
        {
          name: BUILD_ARTIFACTS_WORKFLOW,
          coveredBy: "CI release gate",
          reason: "scheduled workflow is queued",
        },
      ],
    });
  });

  it.each([
    ["release gate", 0],
    ["supporting gate", 4],
    ["queued artifact run", 5],
  ])("does not cover queued artifacts with a stale %s", (_kind, staleRunIndex) => {
    const workflowRuns = queuedBuildArtifactFallbackRuns().map((run, index) =>
      index === staleRunIndex ? { ...run, updated_at: "2026-06-16T10:54:59Z" } : run,
    );
    expect(() => collectHostedGateEvidence({ sha, workflowRuns })).toThrow(
      "Missing successful recent Blacksmith Build Artifacts Testbox workflow",
    );
  });

  it("keeps an older failed artifact run blocking a fresh queued retry", () => {
    const workflowRuns = [
      ...queuedBuildArtifactFallbackRuns(),
      {
        ...successfulRun(BUILD_ARTIFACTS_WORKFLOW, 7, "2026-06-16T10:54:59Z"),
        conclusion: "failure",
      },
    ];
    expect(() => collectHostedGateEvidence({ sha, workflowRuns })).toThrow(
      "Missing successful recent Blacksmith Build Artifacts Testbox workflow",
    );
  });

  it("does not cover queued artifacts until all supporting workflow gates pass", () => {
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          {
            ...successfulRun(`CI release gate ${sha}`, 1, "2026-06-17T10:49:00Z"),
            event: "workflow_dispatch",
            display_title: `CI release gate ${sha}`,
          },
          {
            ...successfulRun(BUILD_ARTIFACTS_WORKFLOW, 2, "2026-06-17T10:50:00Z"),
            status: "queued",
            conclusion: null,
          },
        ],
      }),
    ).toThrow("Missing successful recent Blacksmith Build Artifacts Testbox workflow");
  });

  it("keeps active or terminal non-successful artifact Testboxes blocking", () => {
    const ciFallback = {
      ...successfulRun(`CI release gate ${sha}`, 1, "2026-06-17T10:49:00Z"),
      event: "workflow_dispatch",
      display_title: `CI release gate ${sha}`,
    };

    for (const artifactRun of [
      {
        ...successfulRun(BUILD_ARTIFACTS_WORKFLOW, 2, "2026-06-17T10:50:00Z"),
        status: "in_progress",
        conclusion: null,
      },
      {
        ...successfulRun(BUILD_ARTIFACTS_WORKFLOW, 3, "2026-06-17T10:51:00Z"),
        conclusion: "failure",
      },
    ]) {
      expect(() =>
        collectHostedGateEvidence({
          sha,
          workflowRuns: [ciFallback, artifactRun],
        }),
      ).toThrow("Missing successful recent Blacksmith Build Artifacts Testbox workflow");
    }

    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          ciFallback,
          {
            ...successfulRun(BUILD_ARTIFACTS_WORKFLOW, 4, "2026-06-17T10:52:00Z"),
            conclusion: "failure",
          },
          {
            ...successfulRun(BUILD_ARTIFACTS_WORKFLOW, 5, "2026-06-17T10:53:00Z"),
            status: "queued",
            conclusion: null,
          },
        ],
      }),
    ).toThrow("Missing successful recent Blacksmith Build Artifacts Testbox workflow");
  });

  it("rejects an unmarked manual CI run", () => {
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          {
            ...successfulRun(`CI release gate ${sha}`, 1, "2026-06-17T10:47:00Z"),
            event: "workflow_dispatch",
            display_title: "CI",
          },
        ],
      }),
    ).toThrow("Missing successful recent CI workflow");
  });

  it("rejects a manual release-gate title from another workflow", () => {
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [
          {
            ...successfulRun(`CI release gate ${sha}`, 1, "2026-06-17T10:47:00Z"),
            event: "workflow_dispatch",
            path: ".github/workflows/something-else.yml",
            display_title: `CI release gate ${sha}`,
          },
        ],
      }),
    ).toThrow("Missing successful recent CI workflow");
  });

  it("requires CI for docs unless the head changes only CHANGELOG.md", () => {
    expect(() => collectHostedGateEvidence({ sha, workflowRuns: [] })).toThrow(
      "Missing successful recent CI workflow",
    );
    expect(collectHostedGateEvidence({ sha, workflowRuns: [], changelogOnly: true })).toEqual({
      headSha: sha,
      workflows: [],
    });
  });

  it("parses required CLI arguments", () => {
    expect(parseArgs(requiredCliArgs)).toEqual({
      repo: "openclaw/openclaw",
      sha,
      pr,
      recentSha: "",
      output: ".local/gates-hosted-checks.json",
      changelogOnly: false,
    });
    expect(() => parseArgs(["--repo", "openclaw/openclaw"])).toThrow("Usage:");
    expect(() => parseArgs(requiredCliArgs.with(1, "-h"))).toThrow("Expected --repo <value>.");
    expect(() => parseArgs(requiredCliArgs.with(3, "-h"))).toThrow("Expected --sha <value>.");
    expect(() => parseArgs(requiredCliArgs.with(5, "zero"))).toThrow(
      "Expected --pr <positive-integer>.",
    );
    expect(() => parseArgs(requiredCliArgs.with(requiredCliArgs.length - 1, "-h"))).toThrow(
      "Expected --output <value>.",
    );
  });

  it("rejects duplicate hosted gate verifier CLI arguments", () => {
    const duplicateCases = [
      ["--repo", [...requiredCliArgs, "--repo", "fork/openclaw"]],
      ["--sha", [...requiredCliArgs, "--sha", "other-sha"]],
      ["--pr", [...requiredCliArgs, "--pr", "7"]],
      ["--recent-sha", [...requiredCliArgs, "--recent-sha", "one", "--recent-sha", "other"]],
      ["--output", [...requiredCliArgs, "--output", "two.json"]],
      ["--changelog-only", [...requiredCliArgs, "--changelog-only", "--changelog-only"]],
    ] satisfies Array<[string, string[]]>;

    for (const [flag, args] of duplicateCases) {
      expect(() => parseArgs(args), flag).toThrow(`${flag} was provided more than once.`);
    }
  });

  it("accepts one workflow-runs page emitted through a colorizing GitHub CLI shim", () => {
    expect(
      parseWorkflowRunPage(
        '\u001B[1;37m{"total_count":101,"workflow_runs":[{"id":1,"name":"CI"}]}\u001B[0m',
      ),
    ).toEqual({ totalCount: 101, workflowRuns: [{ id: 1, name: "CI" }] });
  });

  it("queries the target and recorded pre-rebase SHAs", () => {
    expect(
      workflowRunQueryPaths("openclaw/openclaw", {
        sha,
        recentSha: previousSha,
      }),
    ).toEqual([
      `repos/openclaw/openclaw/actions/runs?head_sha=${sha}&per_page=30&page=1`,
      `repos/openclaw/openclaw/actions/runs?head_sha=${previousSha}&per_page=30&page=1`,
    ]);
    expect(HOSTED_GATE_MAX_AGE_HOURS).toBe(24);
  });

  it("queries recent pull-request runs for the head branch", () => {
    expect(
      workflowRunQueryPaths("openclaw/openclaw", {
        sha,
        recentSha: "",
        headBranch: "codex/relax hosted gates",
      }),
    ).toEqual([
      `repos/openclaw/openclaw/actions/runs?head_sha=${sha}&per_page=30&page=1`,
      "repos/openclaw/openclaw/actions/runs?branch=codex%2Frelax%20hosted%20gates&event=pull_request&per_page=30&page=1",
    ]);
  });

  it("uses relay-safe pages and bounds pagination to GitHub's search result limit", () => {
    expect(workflowRunPageCount(0)).toBe(0);
    expect(workflowRunPageCount(101)).toBe(4);
    expect(workflowRunPageCount(10_000)).toBe(34);
    expect(workflowRunQueryPaths("openclaw/openclaw", { sha, recentSha: "" }, 34)).toEqual([
      `repos/openclaw/openclaw/actions/runs?head_sha=${sha}&per_page=30&page=34`,
    ]);
  });
});
