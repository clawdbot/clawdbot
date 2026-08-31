import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  collectHostedGateEvidence as collectHostedGateEvidenceRaw,
  HOSTED_GATE_MAX_AGE_HOURS,
  loadPullRequestCommitShas,
  notApplicableScheduledHostedWorkflows,
  parseArgs,
  parseWorkflowRunPage,
  SCHEDULED_HOSTED_WORKFLOWS,
  workflowRunQueryPaths,
  workflowRunPageCount,
} from "../../scripts/verify-pr-hosted-gates.mts";

const sha = "773ffd87a1e1e34451ad6e38fda37380c2569a50";
const mainSha = "d".repeat(40);
const previousSha = "8d86c44c6144f8f726a460914cddb8c9c201f119";
const scheduledFallbackSha = "ad620a11e5d9ed3888b6afb3c35c4c30e8054f4e";
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
  "--main-sha",
  mainSha,
];

type WorkflowRunFixture = {
  id: number;
  run_number: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string;
  head_repository: { full_name: string };
  pull_requests: Array<{ number: number }>;
  path: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  display_title?: string;
};

function successfulRun(name: string, id: number, updatedAt: string): WorkflowRunFixture {
  return {
    id,
    run_number: id,
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

function pendingCiRun(id: number, updatedAt: string, status = "queued") {
  return { ...successfulRun("CI", id, updatedAt), status, conclusion: null };
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
  options: Omit<CollectHostedGateOptions, "nowMs" | "pr" | "mainSha">,
) {
  return collectHostedGateEvidenceRaw({ nowMs, pr, mainSha, ...options });
}

type GitExec = (args: string[], options?: { input?: string }) => string;
type CollectHostedGateOptions = Parameters<typeof collectHostedGateEvidenceRaw>[0];

function priorSuccessfulCiRun(overrides: Partial<WorkflowRunFixture> = {}): WorkflowRunFixture {
  return {
    ...successfulRun("CI", 101, "2026-06-17T09:55:00Z"),
    head_sha: previousSha,
    ...overrides,
  };
}

type PatchIdExecOptions = {
  currentPatchId?: string;
  priorPatchId?: string;
  unfetchableShas?: Set<string>;
  failCommand?: string;
};

function createPatchIdExec({
  currentPatchId: suppliedCurrentPatchId = "a".repeat(40),
  priorPatchId,
  unfetchableShas = new Set<string>(),
  failCommand = "",
}: PatchIdExecOptions = {}) {
  const currentPatchId: string = suppliedCurrentPatchId;
  const resolvedPriorPatchId = priorPatchId ?? currentPatchId;
  const calls: string[] = [];
  const execGit: GitExec = (args, options = {}) => {
    const command = args.join(" ");
    calls.push(command);
    if (command === failCommand) {
      throw new Error(`mock failure: ${command}`);
    }
    switch (args[0]) {
      case "cat-file": {
        const candidateSha = args[2]?.replace(/\^\{commit\}$/u, "") ?? "";
        if (unfetchableShas.has(candidateSha)) {
          throw new Error("missing object");
        }
        return "";
      }
      case "fetch":
        if (unfetchableShas.has(args[2] ?? "")) {
          throw new Error("unfetchable object");
        }
        return "";
      case "merge-base":
        return `${(args[2] === sha ? "b" : "c").repeat(40)}\n`;
      case "diff":
        return `diff:${args[2]}`;
      case "patch-id": {
        const patchId = options.input === `diff:${sha}` ? currentPatchId : resolvedPriorPatchId;
        return `${patchId} ${"0".repeat(40)}\n`;
      }
      default:
        throw new Error(`unexpected git command: ${command}`);
    }
  };
  return { calls, execGit };
}

function patchReuseOptions(
  candidate: WorkflowRunFixture = priorSuccessfulCiRun(),
  execGit = createPatchIdExec().execGit,
) {
  return {
    loadCiReuseCandidates: () => [candidate],
    execGit,
  };
}

describe("verify-pr-hosted-gates", () => {
  it("compares patch IDs against one main snapshot while the shared ref advances", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "openclaw-patch-snapshot-")));
    const git: GitExec = (args, options) => {
      const result = spawnSync("git", args, { cwd: root, encoding: "utf8", input: options?.input });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    try {
      git(["init", "-q", "-b", "main"]);
      git(["config", "user.name", "OpenClaw Test"]);
      git(["config", "user.email", "test@example.invalid"]);
      git(["config", "commit.gpgSign", "false"]);
      git(["config", "core.hooksPath", "/dev/null"]);
      writeFileSync(join(root, "subject.txt"), "base\n");
      git(["add", "."]);
      git(["commit", "-qm", "base"]);
      const snapshot = git(["rev-parse", "HEAD"]).trim();
      git(["update-ref", "refs/remotes/origin/main", snapshot]);
      writeFileSync(join(root, "subject.txt"), "reviewed\n");
      git(["commit", "-qam", "reviewed"]);
      const target = git(["rev-parse", "HEAD"]).trim();
      git(["commit", "--allow-empty", "-qm", "same tree, different commit"]);
      const candidate = git(["rev-parse", "HEAD"]).trim();
      let comparisons = 0;
      const evidence = collectHostedGateEvidenceRaw({
        sha: target,
        mainSha: snapshot,
        pr,
        nowMs,
        workflowRuns: [],
        loadCiReuseCandidates: () => [priorSuccessfulCiRun({ head_sha: candidate })],
        execGit: (args, options) => {
          const result = git(args, options);
          if (args[0] === "patch-id" && ++comparisons === 1)
            git(["update-ref", "refs/remotes/origin/main", candidate]);
          return result;
        },
      });
      expect(evidence.reusedFromSha).toBe(candidate);
      expect(evidence.patchIdMatched).toBe(true);
      expect(comparisons).toBe(2);
      expect(git(["rev-parse", "refs/remotes/origin/main"]).trim()).toBe(candidate);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts from an older target cwd without current normalization helpers", () => {
    const targetRoot = mkdtempSync(join(tmpdir(), "openclaw-hosted-gates-old-cwd-"));
    try {
      const normalizationRoot = join(targetRoot, "packages/normalization-core/src");
      mkdirSync(normalizationRoot, { recursive: true });
      writeFileSync(
        join(targetRoot, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: {
              "@openclaw/normalization-core/*": ["packages/normalization-core/src/*"],
            },
          },
        }),
      );
      writeFileSync(join(normalizationRoot, "number-coercion.ts"), "export const legacy = true;\n");
      writeFileSync(
        join(normalizationRoot, "record-coerce.ts"),
        [
          "export function isRecord(value: unknown): value is Record<string, unknown> {",
          '  return typeof value === "object" && value !== null && !Array.isArray(value);',
          "}",
          "export function readStringField(record: Record<string, unknown>, key: string) {",
          "  const value = record[key];",
          '  return typeof value === "string" ? value : undefined;',
          "}",
          "",
        ].join("\n"),
      );

      const result = spawnSync(
        process.execPath,
        [join(process.cwd(), "scripts/verify-pr-hosted-gates.mjs"), "--older-cwd-startup-probe"],
        {
          cwd: targetRoot,
          encoding: "utf8",
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown option: --older-cwd-startup-probe");
    } finally {
      rmSync(targetRoot, { force: true, recursive: true });
    }
  });

  it("derives hosted-gate applicability from declared workflow path filters", () => {
    expect(notApplicableScheduledHostedWorkflows([".github/workflows/ci.yml"])).toEqual([]);
    expect(
      notApplicableScheduledHostedWorkflows(["test/e2e/qa-lab/runtime/script-evidence.ts"]),
    ).toEqual([
      "Blacksmith Testbox",
      "Blacksmith ARM Testbox",
      "Blacksmith Build Artifacts Testbox",
    ]);
    expect(notApplicableScheduledHostedWorkflows(["CHANGELOG.md"])).toEqual(
      SCHEDULED_HOSTED_WORKFLOWS,
    );
  });

  it("requires an authoritative ARM run when declared workflow paths apply", () => {
    const workflowRuns = [
      successfulRun("CI", 1, "2026-06-17T10:47:00Z"),
      successfulRun("Blacksmith Testbox", 2, "2026-06-17T10:48:00Z"),
      successfulRun("Blacksmith Build Artifacts Testbox", 3, "2026-06-17T10:49:00Z"),
      successfulRun("Workflow Sanity", 4, "2026-06-17T10:50:00Z"),
    ];

    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns,
        notApplicableScheduledWorkflows: [],
      }),
    ).toThrow(`Missing successful recent Blacksmith ARM Testbox workflow for ${sha}`);
  });

  it("records path-filtered hosted gates as not applicable for QA-only changes", () => {
    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns: [
        successfulRun("CI", 1, "2026-06-17T10:47:00Z"),
        successfulRun("Workflow Sanity", 2, "2026-06-17T10:48:00Z"),
      ],
      notApplicableScheduledWorkflows: [
        "Blacksmith Testbox",
        "Blacksmith ARM Testbox",
        "Blacksmith Build Artifacts Testbox",
      ],
    });

    expect(evidence.workflows).toEqual([
      expect.objectContaining({ name: "CI", id: 1 }),
      expect.objectContaining({ name: "Workflow Sanity", id: 2 }),
    ]);
    expect(evidence.notApplicableWorkflows).toEqual([
      "Blacksmith Testbox",
      "Blacksmith ARM Testbox",
      "Blacksmith Build Artifacts Testbox",
    ]);
  });

  it("does not require path-inapplicable ARM proof for queued artifact fallback", () => {
    const workflowRuns = queuedBuildArtifactFallbackRuns().filter(
      (run) => run.name !== "Blacksmith ARM Testbox",
    );
    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns,
      notApplicableScheduledWorkflows: ["Blacksmith ARM Testbox"],
    });

    expect(evidence.fallbackCoveredWorkflows).toEqual([
      {
        name: BUILD_ARTIFACTS_WORKFLOW,
        coveredBy: "CI release gate",
        reason: "scheduled workflow is queued",
      },
    ]);
    expect(evidence.notApplicableWorkflows).toEqual(["Blacksmith ARM Testbox"]);
  });

  it("reuses successful recent CI from a patch-identical pre-rebase head", () => {
    const candidate = priorSuccessfulCiRun();
    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns: [],
      ...patchReuseOptions(candidate),
    });

    expect(evidence).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ id: 101, name: "CI", headSha: previousSha })],
      reusedFromSha: previousSha,
      reusedRunId: 101,
      patchIdMatched: true,
    });
  });

  it("rejects a successful prior-head CI run whose patch differs", () => {
    const { execGit } = createPatchIdExec({ priorPatchId: "d".repeat(40) });
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [],
        ...patchReuseOptions(priorSuccessfulCiRun(), execGit),
      }),
    ).toThrow(`Missing successful recent CI workflow for ${sha}`);
  });

  it("rejects patch-identical CI reuse after the 24-hour window", () => {
    let gitCalled = false;
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [],
        loadCiReuseCandidates: () => [priorSuccessfulCiRun({ updated_at: "2026-06-16T10:54:59Z" })],
        execGit: () => {
          gitCalled = true;
          throw new Error("stale candidates must be filtered before git");
        },
      }),
    ).toThrow(`Missing successful recent CI workflow for ${sha}`);
    expect(gitCalled).toBe(false);
  });

  it("skips an unfetchable prior head", () => {
    const { calls, execGit } = createPatchIdExec({
      unfetchableShas: new Set([previousSha]),
    });
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [],
        ...patchReuseOptions(priorSuccessfulCiRun(), execGit),
      }),
    ).toThrow(`Missing successful recent CI workflow for ${sha}`);
    expect(calls).toContain(`fetch origin ${previousSha}`);
  });

  it("fails closed when patch-id computation errors", () => {
    const { execGit } = createPatchIdExec({
      failCommand: `merge-base ${mainSha} ${previousSha}`,
    });
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [],
        ...patchReuseOptions(priorSuccessfulCiRun(), execGit),
      }),
    ).toThrow(`Missing successful recent CI workflow for ${sha}`);
  });

  it("filters prior runs by successful qualifying CI shape", () => {
    const invalidCandidates = [
      priorSuccessfulCiRun({ id: 1, conclusion: "failure" }),
      priorSuccessfulCiRun({ id: 2, name: "Docs" }),
      priorSuccessfulCiRun({
        id: 3,
        event: "workflow_dispatch",
        display_title: `CI release gate ${previousSha}`,
        path: ".github/workflows/not-ci.yml",
      }),
    ];
    let gitCalled = false;
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [],
        loadCiReuseCandidates: () => invalidCandidates,
        execGit: () => {
          gitCalled = true;
          throw new Error("invalid candidates must be filtered before git");
        },
      }),
    ).toThrow(`Missing successful recent CI workflow for ${sha}`);
    expect(gitCalled).toBe(false);
  });

  it("accepts a patch-identical prior release-gate run with the exact dispatch title", () => {
    const candidate = priorSuccessfulCiRun({
      id: 102,
      event: "workflow_dispatch",
      path: ".github/workflows/ci.yml",
      display_title: `CI release gate ${previousSha}`,
    });
    expect(
      collectHostedGateEvidence({
        sha,
        workflowRuns: [],
        ...patchReuseOptions(candidate),
      }),
    ).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ id: 102, event: "workflow_dispatch" })],
      reusedFromSha: previousSha,
      reusedRunId: 102,
      patchIdMatched: true,
    });
  });

  it("short-circuits reuse discovery when exact-head CI already succeeds", () => {
    let reuseCalled = false;
    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns: [successfulRun("CI", 1, "2026-06-17T10:47:00Z")],
      loadCiReuseCandidates: () => {
        reuseCalled = true;
        throw new Error("exact-head success must not inspect reuse candidates");
      },
      execGit: () => {
        reuseCalled = true;
        throw new Error("exact-head success must not execute git reuse proof");
      },
    });

    expect(evidence).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ id: 1, headSha: sha })],
    });
    expect(reuseCalled).toBe(false);
  });

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
    const priorRun = {
      ...successfulRun("CI", 1, "2026-06-16T21:55:00Z"),
      head_sha: previousSha,
    };
    const evidence = collectHostedGateEvidence({
      sha,
      recentSha: previousSha,
      workflowRuns: [
        priorRun,
        {
          ...successfulRun("CI", 2, "2026-06-17T10:54:00Z"),
          status: "in_progress",
          conclusion: null,
        },
      ],
      ...patchReuseOptions(priorRun),
    });

    expect(evidence).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ name: "CI", id: 1, headSha: previousSha })],
      reusedFromSha: previousSha,
      reusedRunId: 1,
      patchIdMatched: true,
    });
  });

  it("accepts recent green evidence from an earlier head of the same PR", () => {
    const priorRun = {
      ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
      head_sha: previousSha,
    };
    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns: [
        priorRun,
        {
          ...successfulRun("CI", 2, "2026-06-17T10:54:00Z"),
          status: "in_progress",
          conclusion: null,
        },
      ],
      ...patchReuseOptions(priorRun),
    });

    expect(evidence).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ name: "CI", id: 1, headSha: previousSha })],
      reusedFromSha: previousSha,
      reusedRunId: 1,
      patchIdMatched: true,
    });
  });

  it("accepts a recent green fork head when GitHub omits pull request links", () => {
    const headBranch = "fix/token-listener";
    const headRepository = "contributor/openclaw";
    const priorRun = {
      ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
      head_sha: previousSha,
      head_branch: headBranch,
      head_repository: { full_name: headRepository },
      pull_requests: [],
    };
    const evidence = collectHostedGateEvidence({
      sha,
      pullRequestCommitShas: [previousSha, sha],
      pullRequestHeadBranch: headBranch,
      pullRequestHeadRepository: headRepository,
      workflowRuns: [
        priorRun,
        {
          ...successfulRun("CI", 2, "2026-06-17T10:54:00Z"),
          head_branch: headBranch,
          head_repository: { full_name: headRepository },
          pull_requests: [],
          conclusion: "failure",
        },
      ],
      ...patchReuseOptions(priorRun),
    });

    expect(evidence).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ name: "CI", id: 1, headSha: previousSha })],
      reusedFromSha: previousSha,
      reusedRunId: 1,
      patchIdMatched: true,
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

  it("loads the complete PR commit set with one local rev-list command", () => {
    const baseSha = "a".repeat(40);
    const shas = Array.from({ length: 301 }, (_, index) =>
      (index + 1).toString(16).padStart(40, "0"),
    );
    const headSha = expectDefined(shas.at(-1), "generated head sha");
    const calls: string[][] = [];

    expect(
      loadPullRequestCommitShas({ baseSha, headSha }, (args) => {
        calls.push(args);
        return `${shas.join("\n")}\n`;
      }),
    ).toEqual(shas);
    expect(calls).toEqual([["rev-list", "--reverse", `${baseSha}..${headSha}`]]);
  });

  it.each([
    ["uppercase", "A".repeat(40)],
    ["too short", "a".repeat(39)],
    ["too long", "a".repeat(65)],
    ["leading whitespace", ` ${"a".repeat(40)}`],
    ["multiple fields", `${"a".repeat(40)} ${"b".repeat(40)}`],
    ["blank line", `${"a".repeat(40)}\n\n${"b".repeat(40)}`],
  ])("rejects malformed rev-list object ids: %s", (_case, output) => {
    expect(() =>
      loadPullRequestCommitShas(
        { baseSha: "c".repeat(40), headSha: "b".repeat(40) },
        () => `${output}\n`,
      ),
    ).toThrow("Expected pull request commit object ids from git rev-list.");
  });

  it("rejects empty rev-list output and output missing the requested head", () => {
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    expect(() => loadPullRequestCommitShas({ baseSha, headSha }, () => "")).toThrow(
      "Expected pull request commit object ids from git rev-list.",
    );
    expect(() =>
      loadPullRequestCommitShas({ baseSha, headSha }, () => `${"c".repeat(40)}\n`),
    ).toThrow(`Expected pull request commit list to contain head ${headSha}.`);
  });

  it("propagates rev-list command failures", () => {
    const commandError = new Error("git rev-list failed");
    expect(() =>
      loadPullRequestCommitShas({ baseSha: "a".repeat(40), headSha: "b".repeat(40) }, () => {
        throw commandError;
      }),
    ).toThrow(commandError);
  });

  it("keeps complete membership when the PR head is behind the current base", () => {
    const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "openclaw-pr-commit-set-")));
    const git = (args: string[]) => {
      const result = spawnSync("git", args, { cwd: fixtureRoot, encoding: "utf8" });
      expect(result.status, `git ${args.join(" ")}\n${result.stderr}`).toBe(0);
      return result.stdout;
    };
    try {
      git(["init", "-q", "-b", "main"]);
      git(["config", "user.name", "OpenClaw Test"]);
      git(["config", "user.email", "test@example.invalid"]);
      git(["commit", "-q", "--allow-empty", "-m", "root"]);
      git(["branch", "feature"]);
      git(["commit", "-q", "--allow-empty", "-m", "main one"]);
      git(["commit", "-q", "--allow-empty", "-m", "main two"]);
      const baseSha = git(["rev-parse", "HEAD"]).trim();
      git(["switch", "-q", "feature"]);
      git(["commit", "-q", "--allow-empty", "-m", "feature one"]);
      const firstFeatureSha = git(["rev-parse", "HEAD"]).trim();
      git(["commit", "-q", "--allow-empty", "-m", "feature two"]);
      const headSha = git(["rev-parse", "HEAD"]).trim();

      expect(loadPullRequestCommitShas({ baseSha, headSha }, (args) => git(args))).toEqual([
        firstFeatureSha,
        headSha,
      ]);
      expect(Number(git(["rev-list", "--count", `${headSha}..${baseSha}`]).trim())).toBe(2);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
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

    expect(() =>
      collectHostedGateEvidence({
        sha,
        recentSha: previousSha,
        workflowRuns,
        ...patchReuseOptions(workflowRuns[0]),
      }),
    ).toThrow(`Missing successful recent Blacksmith ARM Testbox workflow for ${previousSha}`);

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
      ...patchReuseOptions(workflowRuns[0]),
    });
    expect(evidence.workflows).toEqual([
      expect.objectContaining({ name: "CI", headSha: previousSha }),
      expect.objectContaining({ name: "Blacksmith ARM Testbox", headSha: previousSha }),
    ]);
    expect(evidence).toMatchObject({
      reusedFromSha: previousSha,
      reusedRunId: 1,
      patchIdMatched: true,
    });
  });

  it("keeps the existing scheduled-workflow fallback after CI reuses another head", () => {
    const priorCiRun = priorSuccessfulCiRun({ id: 1 });
    const evidence = collectHostedGateEvidence({
      sha,
      workflowRuns: [
        priorCiRun,
        {
          ...successfulRun("CI", 2, "2026-06-17T10:54:00Z"),
          status: "in_progress",
          conclusion: null,
        },
        {
          ...successfulRun("Blacksmith ARM Testbox", 3, "2026-06-17T10:54:00Z"),
          status: "queued",
          conclusion: null,
        },
        {
          ...successfulRun("Blacksmith ARM Testbox", 4, "2026-06-17T10:53:00Z"),
          head_sha: scheduledFallbackSha,
        },
      ],
      ...patchReuseOptions(priorCiRun),
    });

    expect(evidence).toMatchObject({
      headSha: sha,
      evidenceHeadSha: scheduledFallbackSha,
      reusedFromSha: previousSha,
      reusedRunId: 1,
      patchIdMatched: true,
      workflows: [
        expect.objectContaining({ name: "CI", headSha: previousSha }),
        expect.objectContaining({
          name: "Blacksmith ARM Testbox",
          headSha: scheduledFallbackSha,
        }),
      ],
    });
  });

  it.each(["failure", "cancelled", "skipped"])(
    "reuses recent same-PR green evidence after a current-head %s run",
    (conclusion) => {
      const priorRun = {
        ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
        head_sha: previousSha,
      };
      const evidence = collectHostedGateEvidence({
        sha,
        recentSha: previousSha,
        workflowRuns: [
          priorRun,
          {
            ...successfulRun("CI", 2, "2026-06-17T10:54:00Z"),
            conclusion,
          },
        ],
        ...patchReuseOptions(priorRun),
      });

      expect(evidence).toEqual({
        headSha: sha,
        workflows: [expect.objectContaining({ name: "CI", id: 1, headSha: previousSha })],
        reusedFromSha: previousSha,
        reusedRunId: 1,
        patchIdMatched: true,
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
          {
            ...successfulRun("Blacksmith ARM Testbox", 4, "2026-06-17T10:54:00Z"),
            status: "queued",
            conclusion: null,
          },
        ],
        ...patchReuseOptions({
          ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
          head_sha: previousSha,
        }),
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
          {
            ...successfulRun("Blacksmith ARM Testbox", 4, "2026-06-17T10:54:00Z"),
            status: "queued",
            conclusion: null,
          },
        ],
        ...patchReuseOptions({
          ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
          head_sha: previousSha,
        }),
      }),
    ).toThrow(`Missing successful recent Blacksmith ARM Testbox workflow for ${previousSha}`);
  });

  it("reuses pre-rebase green evidence after a failed current-head manual gate", () => {
    const priorRun = {
      ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"),
      head_sha: previousSha,
    };
    const evidence = collectHostedGateEvidence({
      sha,
      recentSha: previousSha,
      workflowRuns: [
        priorRun,
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
      ...patchReuseOptions(priorRun),
    });

    expect(evidence).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ name: "CI", id: 1, headSha: previousSha })],
      reusedFromSha: previousSha,
      reusedRunId: 1,
      patchIdMatched: true,
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
    ).toThrow(`Missing successful recent CI workflow for ${sha}`);

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
    ).toThrow(`Missing successful recent CI workflow for ${sha}`);
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
    ["stale", successfulRun("CI", 1, "2026-06-16T10:54:59Z")],
    ["cancelled", { ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"), conclusion: "cancelled" }],
    ["skipped", { ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"), conclusion: "skipped" }],
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

  it.each(["cancelled", "skipped"])("rejects neutral-only scheduled CI (%s)", (conclusion) => {
    expect(() =>
      collectHostedGateEvidence({
        sha,
        workflowRuns: [{ ...successfulRun("CI", 1, "2026-06-17T10:50:00Z"), conclusion }],
      }),
    ).toThrow("Missing successful recent CI workflow");
  });

  it.each(["cancelled", "skipped"])(
    "retains a recent scheduled success after a newer neutral run (%s)",
    (conclusion) => {
      const success = successfulRun("CI", 1, "2026-06-17T10:47:00Z");
      const neutral = { ...successfulRun("CI", 2, "2026-06-17T10:48:00Z"), conclusion };
      const collect = () => collectHostedGateEvidence({ sha, workflowRuns: [success, neutral] });
      expect(collect()).toEqual({
        headSha: sha,
        workflows: [expect.objectContaining({ name: "CI", id: 1 })],
      });
      for (const status of ["queued", "in_progress"]) {
        Object.assign(neutral, { status, conclusion: null });
        expect(collect).toThrow("Missing successful recent CI workflow");
      }
    },
  );

  it.each([
    [
      "queued over older manual",
      [releaseGateRun(1, "2026-06-17T10:49:00Z"), pendingCiRun(2, "2026-06-17T10:50:00Z")],
      null,
    ],
    [
      "in-progress over older manual",
      [
        releaseGateRun(1, "2026-06-17T10:49:00Z"),
        pendingCiRun(2, "2026-06-17T10:50:00Z", "in_progress"),
      ],
      null,
    ],
    [
      "pending over neutral and manual",
      [
        { ...successfulRun("CI", 1, "2026-06-17T10:48:00Z"), conclusion: "skipped" },
        releaseGateRun(2, "2026-06-17T10:49:00Z"),
        pendingCiRun(3, "2026-06-17T10:50:00Z"),
      ],
      null,
    ],
    [
      "newer manual over older pending",
      [
        pendingCiRun(1, "2026-06-17T10:48:00Z", "in_progress"),
        releaseGateRun(2, "2026-06-17T10:49:00Z"),
      ],
      2,
    ],
  ])("applies the %s policy", (_case, workflowRuns, expectedId) => {
    const collect = () => collectHostedGateEvidence({ sha, workflowRuns });
    if (expectedId === null) {
      expect(collect).toThrow("Missing successful recent CI workflow");
      return;
    }
    expect(collect()).toEqual({
      headSha: sha,
      workflows: [expect.objectContaining({ name: `CI release gate ${sha}`, id: expectedId })],
    });
  });

  it("orders runs by creation sequence when completion updates invert", () => {
    const olderSuccess = successfulRun("CI", 1, "2026-06-17T10:54:00Z");
    const newerFailure = {
      ...successfulRun("CI", 2, "2026-06-17T10:49:00Z"),
      conclusion: "failure",
    };
    expect(() =>
      collectHostedGateEvidence({ sha, workflowRuns: [olderSuccess, newerFailure] }),
    ).toThrow("Missing successful recent CI workflow");
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

  it.each(["cancelled", "skipped"])(
    "keeps an older scheduled failure blocking after a newer neutral run (%s)",
    (conclusion) => {
      expect(() =>
        collectHostedGateEvidence({
          sha,
          workflowRuns: [
            { ...successfulRun("CI", 1, "2026-06-17T10:47:00Z"), conclusion: "failure" },
            { ...successfulRun("CI", 2, "2026-06-17T10:48:00Z"), conclusion },
            releaseGateRun(3, "2026-06-17T10:49:00Z"),
          ],
        }),
      ).toThrow("Missing successful recent CI workflow");
    },
  );

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
      index === staleRunIndex
        ? Object.assign({}, run, { updated_at: "2026-06-16T10:54:59Z" })
        : run,
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
      mainSha,
      pr,
      recentSha: "",
      output: ".local/gates-hosted-checks.json",
      changelogOnly: false,
    });
    expect(() => parseArgs(["--repo", "openclaw/openclaw"])).toThrow("Usage:");
    expect(() => parseArgs(requiredCliArgs.with(1, "-h"))).toThrow("Expected --repo <value>.");
    expect(() => parseArgs(requiredCliArgs.with(3, "-h"))).toThrow("Expected --sha <value>.");
    expect(() => parseArgs(requiredCliArgs.with(5, "-h"))).toThrow("Expected --pr <value>.");
    for (const [value, expected] of [
      ["1", 1],
      ["001", 1],
      [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ] as const) {
      expect(parseArgs(requiredCliArgs.with(5, value)).pr).toBe(expected);
    }
    for (const value of [
      "zero",
      "0",
      String(Number.MAX_SAFE_INTEGER + 1),
      "1e3",
      "0x10",
      "0b10",
      "1.5",
      "+1",
      " 1 ",
    ]) {
      expect(() => parseArgs(requiredCliArgs.with(5, value))).toThrow(
        "Expected --pr <positive-integer>.",
      );
    }
    expect(() => parseArgs(requiredCliArgs.with(7, "-h"))).toThrow("Expected --output <value>.");
    expect(() => parseArgs(requiredCliArgs.with(9, "origin/main"))).toThrow("Usage:");
  });

  it("rejects malformed PR numbers before invoking GitHub", () => {
    const result = spawnSync(
      process.execPath,
      [
        join(process.cwd(), "scripts/verify-pr-hosted-gates.mjs"),
        ...requiredCliArgs.with(5, "1e3"),
      ],
      { encoding: "utf8", env: { ...process.env, PATH: "" } },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Expected --pr <positive-integer>.");
    expect(result.stderr).not.toContain("spawnSync gh");
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
