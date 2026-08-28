import { describe, expect, it } from "vitest";
import {
  continueFailed,
  createClient,
  inspectContinuation,
  loadPlan,
  preflightContinuation,
} from "../../scripts/frv.mjs";
import { buildFullReleaseCandidateRequest } from "../../scripts/full-release-candidate-contract.mjs";
import {
  buildReleaseExecutionPlan,
  buildReleaseExecutionPlanArtifact,
  releaseChildSpec,
  releaseCompositeJobsSha256,
  releaseExecutionPlanSha256,
  validateReleaseExecutionPlanArtifact,
} from "../../scripts/full-release-validation-policy.mjs";

const SHA = "a".repeat(40);
const TARGET_SHA = "b".repeat(40);
const SOURCE_REF = `release-ci/${SHA.slice(0, 12)}-77`;
const REPOSITORY = "openclaw/openclaw";

function job(name: string, conclusion = "success") {
  return {
    completed_at: "2026-08-22T00:01:00Z",
    conclusion,
    html_url: `https://example.invalid/jobs/${name}`,
    name,
    started_at: "2026-08-22T00:00:00Z",
    status: "completed",
  };
}

function child(key: string, runId: string) {
  const spec = releaseChildSpec(key);
  return {
    displayTitle: `${spec.displayName} full-release-validation-77-1${spec.suffix}`,
    key,
    required: true,
    runAttempt: 1,
    runId,
    selected: true,
    sourceParentAttempt: 1,
    url: `https://github.com/${REPOSITORY}/actions/runs/${runId}`,
    workflow: spec.workflow,
    workflowRef: SOURCE_REF,
    workflowSha: SHA,
  };
}

function requiredChildren() {
  return [
    child("normalCi", "101"),
    child("pluginPrerelease", "202"),
    child("releaseChecks", "303"),
    child("productPerformance", "404"),
  ];
}

function plan(children = requiredChildren()) {
  return {
    children,
    parentRunAttempt: 1,
    parentRunId: "77",
    releaseProfile: "beta",
    rerunGroup: "all",
    targetSha: TARGET_SHA,
    trustedWorkflow: { fullRef: "refs/heads/main", ref: "main", sha: SHA },
    workflowRef: SOURCE_REF,
    workflowSha: SHA,
  };
}

function executionPlanArtifact() {
  const children = requiredChildren();
  const built = buildReleaseExecutionPlan({
    children: Object.fromEntries(
      children.map((entry) => [
        entry.key,
        {
          result: "success",
          runAttempt: entry.runAttempt,
          runId: entry.runId,
          url: entry.url,
        },
      ]),
    ),
    dockerPreflightResult: "success",
    parentRunAttempt: 1,
    parentRunId: "77",
    candidateBindingResult: "success",
    rerunGroup: "all",
    resolveTargetResult: "success",
    workflowRef: SOURCE_REF,
    workflowSha: SHA,
  });
  return buildReleaseExecutionPlanArtifact({
    attemptEvidenceVersion: 1,
    children: built.children,
    evidenceReuse: { requested: false },
    expected: {
      parentRunAttempt: 1,
      parentRunId: "77",
      repository: REPOSITORY,
      targetSha: TARGET_SHA,
      workflowRef: SOURCE_REF,
      workflowSha: SHA,
    },
    gates: built.gates,
    releaseProfile: "beta",
    rerunGroup: "all",
    trustedWorkflow: { fullRef: "refs/heads/main", ref: "main", sha: SHA },
  });
}

function currentV2ExecutionPlanArtifact() {
  const priorV1 = executionPlanArtifact();
  const candidateRequest = buildFullReleaseCandidateRequest({
    repository: REPOSITORY,
    targetSha: TARGET_SHA,
    toolingSha: SHA,
    releaseProfile: "beta",
    releaseSoak: false,
    upgradeSurvivorBaseline: "openclaw@latest",
    upgradeSurvivorBaselines: "",
    upgradeSurvivorScenarios: "",
    allowFrozenTargetScenarioOmissions: false,
    allowUnreleasedChangelog: false,
    sharedImagePolicy: "no-push-artifact",
  });
  return buildReleaseExecutionPlanArtifact({
    attemptEvidenceVersion: 2,
    candidate: null,
    children: priorV1.children,
    evidenceReuse: priorV1.evidenceReuse,
    expected: {
      candidateRequest,
      parentRunAttempt: 1,
      parentRunId: "77",
      repository: REPOSITORY,
      targetSha: TARGET_SHA,
      workflowRef: SOURCE_REF,
      workflowSha: SHA,
    },
    gates: priorV1.gates,
    releaseProfile: "beta",
    rerunGroup: "all",
    trustedWorkflow: priorV1.trustedWorkflow,
  });
}

function historicalExecutionPlanArtifact() {
  const artifact = structuredClone(executionPlanArtifact());
  delete artifact.attemptEvidenceVersion;
  for (const entry of artifact.children) {
    delete entry.sourceParentAttempt;
  }
  artifact.sha256 = releaseExecutionPlanSha256(artifact);
  return artifact;
}

function runFor(entry: ReturnType<typeof child>, attempt: number, conclusion: string | null) {
  return {
    actor: { login: "github-actions[bot]" },
    conclusion,
    display_title: entry.displayTitle,
    event: "workflow_dispatch",
    head_branch: entry.workflowRef,
    head_sha: entry.workflowSha,
    html_url: entry.url,
    id: Number(entry.runId),
    path: `.github/workflows/${entry.workflow}`,
    repository: { full_name: REPOSITORY },
    run_attempt: attempt,
    status: conclusion === null ? "in_progress" : "completed",
    triggering_actor: {
      login: attempt === entry.runAttempt ? "github-actions[bot]" : "release-operator",
    },
  };
}

function rootRun(attempt = 1, conclusion: string | null = "failure") {
  return {
    conclusion,
    display_title: "Full Release Validation",
    event: "workflow_dispatch",
    head_branch: SOURCE_REF,
    head_sha: SHA,
    id: 77,
    path: ".github/workflows/full-release-validation.yml",
    repository: { full_name: REPOSITORY },
    run_attempt: attempt,
    status: conclusion === null ? "in_progress" : "completed",
  };
}

function preflightMethods(
  children: ReturnType<typeof child>[],
  childRun: (entry: ReturnType<typeof child>) => Record<string, unknown>,
  options: { failFast?: boolean; childRunIdOverride?: string } = {},
) {
  const byRunId = new Map(children.map((entry) => [entry.runId, entry]));
  const parentJobs = [
    {
      conclusion: "success",
      id: 1,
      name: "Resolve target ref",
      run_attempt: 1,
      status: "completed",
    },
    ...children.map((entry, index) => ({
      conclusion: "failure",
      id: index + 2,
      name: releaseChildSpec(entry.key).parentJobName,
      run_attempt: 1,
      status: "completed",
    })),
  ];
  return {
    getJobLog: async (jobId: number) => {
      if (jobId === 1) {
        return [
          "RERUN_GROUP: all",
          `FAIL_FAST: ${options.failFast === true ? "true" : "false"}`,
          `TARGET_SHA: ${TARGET_SHA}`,
        ].join("\n");
      }
      const entry = children[jobId - 2]!;
      const runId = options.childRunIdOverride ?? entry.runId;
      return [
        `TARGET_SHA: ${TARGET_SHA}`,
        ...(entry.key === "productPerformance" ? ["-f publish_reports=false"] : []),
        `Dispatched ${entry.workflow}: https://github.com/${REPOSITORY}/actions/runs/${runId} (attempt 1)`,
      ].join("\n");
    },
    getParentJobs: async () => parentJobs,
    getRunAttempt: async (runId: string) =>
      runId === "77" ? rootRun() : childRun(byRunId.get(runId)!),
  };
}

function controllerClient(
  children: ReturnType<typeof child>[],
  childRuns: Map<string, { attempt: number; conclusion: string | null }>,
  parent: { attempt: number; conclusion: string | null },
) {
  const byRunId = new Map(children.map((entry) => [entry.runId, entry]));
  return {
    ...preflightMethods(children, (entry) => runFor(entry, 1, "failure")),
    getAttemptJobs: async (runId: string, attempt: number) => [
      job(
        "test",
        attempt === childRuns.get(runId)?.attempt
          ? (childRuns.get(runId)?.conclusion ?? "")
          : "failure",
      ),
    ],
    getRun: async (runId: string) =>
      runId === "77"
        ? rootRun(parent.attempt, parent.conclusion)
        : runFor(
            byRunId.get(runId)!,
            childRuns.get(runId)!.attempt,
            childRuns.get(runId)!.conclusion,
          ),
    repository: REPOSITORY,
  };
}

describe("FRV immutable plan eligibility", () => {
  it("keeps digest-valid prior-v1 plans eligible for continuation", async () => {
    const priorV1 = executionPlanArtifact();
    expect(priorV1.sha256).toBe("391b70ff928e90c190cd7f3c324660de536afe8cfc8a11be11ef0939a1693ea2");
    expect(validateReleaseExecutionPlanArtifact(priorV1)).toMatchObject({
      attemptEvidenceVersion: 1,
      parentRunId: "77",
      rerunGroup: "all",
    });
    expect(priorV1).not.toHaveProperty("candidate");
    await expect(
      loadPlan({ repository: REPOSITORY, runId: "77" }, async () => priorV1),
    ).resolves.toMatchObject({
      attemptEvidenceVersion: 1,
      parentRunId: "77",
      rerunGroup: "all",
    });
  });

  it("accepts current v2 all-group plans", async () => {
    await expect(
      loadPlan({ repository: REPOSITORY, runId: "77" }, async () =>
        currentV2ExecutionPlanArtifact(),
      ),
    ).resolves.toMatchObject({
      attemptEvidenceVersion: 2,
      parentRunId: "77",
      rerunGroup: "all",
    });
  });

  it("keeps historical plan verification but rejects it for continuation", async () => {
    const historical = historicalExecutionPlanArtifact();
    expect(validateReleaseExecutionPlanArtifact(historical)).not.toHaveProperty(
      "attemptEvidenceVersion",
    );
    await expect(
      loadPlan({ repository: REPOSITORY, runId: "77" }, async () => historical),
    ).rejects.toThrow("run predates attempt-aware immutable plans; run a fresh all-group FRV");
  });

  it("rejects missing plans and focused roots", async () => {
    await expect(
      loadPlan({ repository: REPOSITORY, runId: "77" }, async () => undefined),
    ).rejects.toThrow("run has no authenticated immutable FRV plan");
    const focused = structuredClone(executionPlanArtifact());
    focused.rerunGroup = "ci";
    focused.sha256 = releaseExecutionPlanSha256(focused);
    await expect(
      loadPlan({ repository: REPOSITORY, runId: "77" }, async () => focused),
    ).rejects.toThrow("FRV continuation requires an all-group root");
  });
});

describe("FRV continuation preflight", () => {
  it("rejects fail-fast roots before any rerun mutation", async () => {
    const selected = child("normalCi", "101");
    let mutations = 0;
    const client = {
      ...preflightMethods([selected], (entry) => runFor(entry, 1, "failure"), {
        failFast: true,
      }),
      getAttemptJobs: async () => [job("test", "failure")],
      getRun: async () => runFor(selected, 1, "failure"),
      repository: REPOSITORY,
      rerunFailed: async () => {
        mutations += 1;
      },
      rerunParent: async () => {
        mutations += 1;
      },
      verify: async () => "{}",
    };
    await expect(continueFailed(plan([selected]), "77", client)).rejects.toThrow(
      "source full release root is not an exact fail-fast-disabled all-group target",
    );
    expect(mutations).toBe(0);
  });

  it("rejects parent provenance drift before mutation", async () => {
    const selected = child("normalCi", "101");
    let mutations = 0;
    const methods = preflightMethods([selected], (entry) => runFor(entry, 1, "failure"));
    await expect(
      continueFailed(plan([selected]), "77", {
        ...methods,
        getAttemptJobs: async () => [job("test", "failure")],
        getRun: async () => runFor(selected, 1, "failure"),
        getRunAttempt: async (runId: string) => {
          const run = await methods.getRunAttempt(runId);
          return runId === "77" ? { ...run, repository: { full_name: "someone/else" } } : run;
        },
        repository: REPOSITORY,
        rerunFailed: async () => {
          mutations += 1;
        },
      }),
    ).rejects.toThrow("source full release parent identity changed");
    expect(mutations).toBe(0);
  });

  it("requires every selected child to be emitted by its exact parent job", async () => {
    const selected = child("normalCi", "101");
    await expect(
      preflightContinuation(plan([selected]), "77", {
        ...preflightMethods([selected], (entry) => runFor(entry, 1, "failure"), {
          childRunIdOverride: "999",
        }),
      }),
    ).rejects.toThrow("release child is not uniquely emitted by its parent job");
  });
});

describe("FRV same-parent recovery", () => {
  it("reports the effective attempt and composite job evidence", async () => {
    const selected = child("normalCi", "101");
    const result = await inspectContinuation(plan([selected]), {
      getAttemptJobs: async (_runId: string, attempt: number) => [
        job("test", attempt === 1 ? "failure" : "success"),
      ],
      getRun: async () => runFor(selected, 2, "success"),
      repository: REPOSITORY,
    });
    expect(result.children[0]).toMatchObject({
      compositeJobsSha256: releaseCompositeJobsSha256({
        effectiveRunAttempt: 2,
        jobs: [
          {
            acceptedRunAttempt: 2,
            completedAt: "2026-08-22T00:01:00Z",
            conclusion: "success",
            name: "test",
            startedAt: "2026-08-22T00:00:00Z",
            status: "completed",
            url: "https://example.invalid/jobs/test",
          },
        ],
        plannedRunAttempt: 1,
      }),
      effectiveRunAttempt: 2,
      status: "passed",
    });
  });

  it("adopts an already-active newer child attempt without dispatching another rerun", async () => {
    const selected = child("normalCi", "101");
    let childReads = 0;
    let reruns = 0;
    const parent = { attempt: 1, conclusion: "success" as string | null };
    const client = {
      ...preflightMethods([selected], (entry) => runFor(entry, 1, "failure")),
      getAttemptJobs: async (_runId: string, attempt: number) =>
        attempt === 1 ? [job("test", "failure")] : childReads < 2 ? [] : [job("test")],
      getRun: async (runId: string) => {
        if (runId === "77") {
          return rootRun(parent.attempt, parent.conclusion);
        }
        childReads += 1;
        return runFor(selected, 2, childReads < 2 ? null : "success");
      },
      repository: REPOSITORY,
      rerunFailed: async () => {
        reruns += 1;
      },
      rerunParent: async () => {
        parent.attempt = 2;
        parent.conclusion = "success";
      },
      verify: async () => "{}",
    };
    const previousPoll = process.env.OPENCLAW_FRV_POLL_MS;
    process.env.OPENCLAW_FRV_POLL_MS = "1";
    try {
      await expect(continueFailed(plan([selected]), "77", client)).resolves.toMatchObject({
        action: "reran-parent",
        finalRunId: "77",
      });
    } finally {
      if (previousPoll === undefined) {
        delete process.env.OPENCLAW_FRV_POLL_MS;
      } else {
        process.env.OPENCLAW_FRV_POLL_MS = previousPoll;
      }
    }
    expect(reruns).toBe(0);
  });

  it("reruns failed children concurrently, preserves green children, then reruns the parent", async () => {
    const first = child("normalCi", "101");
    const second = child("pluginPrerelease", "202");
    const green = child("releaseChecks", "303");
    const childRuns = new Map([
      ["101", { attempt: 1, conclusion: "failure" }],
      ["202", { attempt: 1, conclusion: "failure" }],
      ["303", { attempt: 1, conclusion: "success" }],
    ]);
    const parent = { attempt: 1, conclusion: "failure" as string | null };
    const events: string[] = [];
    const client = {
      ...controllerClient([first, second, green], childRuns, parent),
      rerunFailed: async (runId: string) => {
        events.push(`child:${runId}`);
        childRuns.set(runId, { attempt: 2, conclusion: "success" });
        await Promise.resolve();
      },
      rerunParent: async () => {
        events.push("parent");
        parent.attempt = 2;
        parent.conclusion = "success";
      },
      verify: async () => {
        events.push("verify");
        return "{}";
      },
    };
    const result = await continueFailed(plan([first, second, green]), "77", client);
    expect(result).toMatchObject({ action: "reran-parent", finalRunId: "77" });
    expect(events.slice(0, 2).toSorted()).toEqual(["child:101", "child:202"]);
    expect(events).not.toContain("child:303");
    expect(events.indexOf("parent")).toBeGreaterThan(events.indexOf("child:202"));
    expect(events.at(-1)).toBe("verify");
  });

  it("reconciles an ambiguous rerun response without dispatching twice", async () => {
    const first = child("normalCi", "101");
    const second = child("pluginPrerelease", "202");
    const childRuns = new Map([
      ["101", { attempt: 1, conclusion: "failure" }],
      ["202", { attempt: 1, conclusion: "failure" }],
    ]);
    const parent = { attempt: 1, conclusion: "success" as string | null };
    const calls: string[] = [];
    const client = {
      ...controllerClient([first, second], childRuns, parent),
      rerunFailed: async (runId: string) => {
        calls.push(runId);
        childRuns.set(runId, { attempt: 2, conclusion: "success" });
        if (runId === "101") {
          throw new Error("HTTP 502 after dispatch");
        }
      },
      rerunParent: async () => {
        parent.attempt = 2;
        parent.conclusion = "success";
      },
      verify: async () => "{}",
    };
    await expect(continueFailed(plan([first, second]), "77", client)).resolves.toMatchObject({
      action: "reran-parent",
    });
    expect(calls.toSorted()).toEqual(["101", "202"]);
  });

  it("does not retry an ambiguous mutation after the source run provenance changes", async () => {
    const selected = child("normalCi", "101");
    let drifted = false;
    let reruns = 0;
    const previousPoll = process.env.OPENCLAW_FRV_POLL_MS;
    const previousReconcile = process.env.OPENCLAW_FRV_RECONCILE_TIMEOUT_MS;
    const client = {
      ...preflightMethods([selected], (entry) => runFor(entry, 1, "failure")),
      getAttemptJobs: async () => [job("test", "failure")],
      getRun: async (runId: string) =>
        runId === "77"
          ? rootRun(1, "success")
          : {
              ...runFor(selected, 1, "failure"),
              head_sha: drifted ? "f".repeat(40) : SHA,
            },
      repository: REPOSITORY,
      rerunFailed: async () => {
        reruns += 1;
        drifted = true;
        throw new Error("HTTP 502 before dispatch");
      },
      rerunParent: async () => {},
      verify: async () => "{}",
    };
    process.env.OPENCLAW_FRV_POLL_MS = "1";
    process.env.OPENCLAW_FRV_RECONCILE_TIMEOUT_MS = "5";
    try {
      await expect(continueFailed(plan([selected]), "77", client)).rejects.toThrow(
        "rerun source 101 changed after a rejected mutation",
      );
    } finally {
      if (previousPoll === undefined) {
        delete process.env.OPENCLAW_FRV_POLL_MS;
      } else {
        process.env.OPENCLAW_FRV_POLL_MS = previousPoll;
      }
      if (previousReconcile === undefined) {
        delete process.env.OPENCLAW_FRV_RECONCILE_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_FRV_RECONCILE_TIMEOUT_MS = previousReconcile;
      }
    }
    expect(reruns).toBe(1);
  });

  it("keeps dry-run recovery mutation-free", async () => {
    const selected = child("normalCi", "101");
    let mutations = 0;
    const client = {
      ...controllerClient([selected], new Map([["101", { attempt: 1, conclusion: "failure" }]]), {
        attempt: 1,
        conclusion: "failure",
      }),
      rerunFailed: async () => {
        mutations += 1;
      },
      rerunParent: async () => {
        mutations += 1;
      },
      verify: async () => {
        mutations += 1;
      },
    };
    await expect(
      continueFailed(plan([selected]), "77", client, { dryRun: true }),
    ).resolves.toMatchObject({ action: "would-rerun" });
    expect(mutations).toBe(0);
  });
});

describe("FRV strict verifier", () => {
  it("uses the immutable trusted workflow identity and remaining operation budget", async () => {
    let args: string[] = [];
    let timeoutMs = 0;
    const client = createClient(REPOSITORY, {
      execCommand: async (
        _command: string,
        commandArgs: string[],
        options: { timeoutMs: number },
      ) => {
        args = commandArgs;
        timeoutMs = options.timeoutMs;
        return "{}";
      },
    });
    await expect(client.verify("77", executionPlanArtifact(), Date.now() + 30_000)).resolves.toBe(
      "{}",
    );
    expect(args).toEqual(
      expect.arrayContaining([
        "--validate-run",
        "77",
        "--trusted-workflow-sha",
        SHA,
        "--verifier-source-sha",
        SHA,
      ]),
    );
    expect(timeoutMs).toBeGreaterThan(0);
    expect(timeoutMs).toBeLessThanOrEqual(30_000);
  });

  it("rejects an expired verification budget before spawning the verifier", async () => {
    let spawns = 0;
    const client = createClient(REPOSITORY, {
      execCommand: async () => {
        spawns += 1;
        return "{}";
      },
    });
    await expect(client.verify("77", executionPlanArtifact(), Date.now() - 1)).rejects.toThrow(
      "FRV verification timed out",
    );
    expect(spawns).toBe(0);
  });
});
