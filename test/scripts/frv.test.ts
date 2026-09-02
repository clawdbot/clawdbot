import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
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
    attemptEvidenceVersion: 2,
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

function executionPlanArtifact({
  children = requiredChildren(),
  evidenceReuse = { requested: false },
}: {
  children?: ReturnType<typeof requiredChildren>;
  evidenceReuse?: Record<string, unknown>;
} = {}) {
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
    evidenceReuse: evidenceReuse.requested === true,
    parentRunAttempt: 1,
    parentRunId: "77",
    candidateBindingResult: "success",
    rerunGroup: "all",
    resolveTargetResult: "success",
    workflowRef: SOURCE_REF,
    workflowSha: SHA,
  });
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
  const selectedKeys = new Set(children.map((entry) => entry.key));
  return buildReleaseExecutionPlanArtifact({
    attemptEvidenceVersion: 2,
    candidate: null,
    children: built.children.map((entry) =>
      selectedKeys.has(entry.key)
        ? entry
        : {
            ...entry,
            required: false,
            result: "skipped",
            runAttempt: null,
            runId: "",
            selected: false,
            url: "",
          },
    ),
    evidenceReuse,
    expected: {
      candidateRequest,
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

function historicalExecutionPlanArtifact() {
  const artifact = structuredClone(executionPlanArtifact());
  delete artifact.attemptEvidenceVersion;
  delete artifact.candidate;
  delete artifact.candidateRequest;
  delete artifact.repository;
  for (const entry of artifact.children) {
    delete entry.sourceParentAttempt;
  }
  artifact.sha256 = releaseExecutionPlanSha256(artifact);
  return artifact;
}

function runFor(
  entry: ReturnType<typeof child>,
  attempt: number,
  conclusion: string | null,
  status = conclusion === null ? "in_progress" : "completed",
) {
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
    status,
    triggering_actor: {
      login: attempt === entry.runAttempt ? "github-actions[bot]" : "release-operator",
    },
  };
}

function rootRun(
  attempt = 1,
  conclusion: string | null = "failure",
  status = conclusion === null ? "in_progress" : "completed",
) {
  return {
    actor: { login: "github-actions[bot]" },
    conclusion,
    display_title: "Full Release Validation",
    event: "workflow_dispatch",
    head_branch: SOURCE_REF,
    head_sha: SHA,
    id: 77,
    path: ".github/workflows/full-release-validation.yml",
    repository: { full_name: REPOSITORY },
    run_attempt: attempt,
    status,
    triggering_actor: { login: attempt === 1 ? "github-actions[bot]" : "release-operator" },
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

async function withFastPolling<T>(run: () => Promise<T>, reconcileTimeoutMs?: string) {
  vi.stubEnv("OPENCLAW_FRV_POLL_MS", "1");
  if (reconcileTimeoutMs) {
    vi.stubEnv("OPENCLAW_FRV_RECONCILE_TIMEOUT_MS", reconcileTimeoutMs);
  }
  try {
    return await run();
  } finally {
    vi.unstubAllEnvs();
  }
}

type ScenarioState = [
  attempt: unknown,
  conclusion: string | null,
  status?: string,
  actor?: string,
  triggeringActor?: string,
  headSha?: string,
];

function rerunScenario(options: {
  childAfter?: ScenarioState[];
  childBefore?: ScenarioState[];
  childError?: Error;
  childSource?: ScenarioState;
  parentAfter?: ScenarioState[];
  parentBefore?: ScenarioState[];
  parentError?: Error;
  parentSource?: ScenarioState;
}) {
  const selected = child("normalCi", "101");
  const source = {
    child: options.childSource ?? [1, "failure"],
    parent: options.parentSource ?? [1, "success"],
  };
  const after = {
    child: options.childAfter ?? [[2, "success"]],
    parent: options.parentAfter ?? [[2, "success"]],
  };
  const mutated = { child: false, parent: false };
  const beforeReads = { child: 0, parent: 0 };
  const counters = {
    posts: { child: 0, parent: 0 },
    reads: { child: 0, parent: 0 },
    verifies: 0,
  };
  const stateAt = (states: ScenarioState[], index: number) =>
    states[Math.min(index, states.length - 1)]!;
  const makeRun = (target: "child" | "parent", state: ScenarioState) => {
    const [attempt, conclusion, status, actor, triggeringActor, headSha] = state;
    const validAttempt = typeof attempt === "number" && attempt > 0 ? attempt : 1;
    const base =
      target === "child"
        ? runFor(selected, validAttempt, conclusion, status)
        : rootRun(validAttempt, conclusion, status);
    return {
      ...base,
      actor: { login: actor ?? base.actor.login },
      run_attempt: attempt,
      ...(target === "child" && triggeringActor
        ? { triggering_actor: { login: triggeringActor } }
        : {}),
      ...(headSha ? { head_sha: headSha } : {}),
    };
  };
  const mutate = async (target: "child" | "parent", error?: Error) => {
    counters.posts[target] += 1;
    mutated[target] = true;
    if (error) {
      throw error;
    }
  };
  return {
    counters,
    selected,
    client: {
      ...preflightMethods([selected], () => makeRun("child", source.child)),
      getAttemptJobs: async (_runId: string, attempt: number) => [
        job("test", attempt === source.child[0] ? (source.child[1] ?? "failure") : "success"),
      ],
      getRun: async (runId: string) => {
        const target = runId === "77" ? "parent" : "child";
        const states = mutated[target]
          ? after[target]
          : target === "parent"
            ? (options.parentBefore ?? [source.parent])
            : (options.childBefore ?? [source.child]);
        const index = mutated[target] ? counters.reads[target]++ : beforeReads[target]++;
        return makeRun(target, stateAt(states, index));
      },
      repository: REPOSITORY,
      rerunFailed: () => mutate("child", options.childError),
      rerunParent: () => mutate("parent", options.parentError),
      verify: async () => {
        counters.verifies += 1;
        return "{}";
      },
    },
  };
}

describe("FRV immutable plan eligibility", () => {
  it("accepts current v2 all-group plans", async () => {
    await expect(
      loadPlan({ repository: REPOSITORY, runId: "77" }, async () => executionPlanArtifact()),
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
  it.each([
    "Prepare release npm artifacts / Prepare publishable npm package",
    "Prepare release Docker artifacts / Seal prepared Docker images",
  ])("rejects rerunning a parent that owns publication artifacts from %s", async (name) => {
    const selected = child("normalCi", "101");
    const client = preflightMethods([selected], (entry) => runFor(entry, 1, "failure"));
    await expect(
      preflightContinuation(plan([selected]), "77", {
        ...client,
        getParentJobs: async () => [
          { name, run_attempt: 1, status: "completed", conclusion: "success" },
        ],
      }),
    ).rejects.toThrow("parent-owned publication artifacts");
  });
  it("rejects parent-owned candidate artifacts before any GitHub access", async () => {
    const selected = child("normalCi", "101");
    const parentOwnedPlan = {
      ...plan([selected]),
      candidate: { producer: { runId: "77" } },
    };
    let reads = 0;
    let mutations = 0;
    const read = async () => {
      reads += 1;
      throw new Error("unexpected GitHub read");
    };
    const mutate = async () => {
      mutations += 1;
    };

    await expect(
      continueFailed(parentOwnedPlan, "77", {
        getAttemptJobs: read,
        getJobLog: read,
        getParentJobs: read,
        getRun: read,
        getRunAttempt: read,
        repository: REPOSITORY,
        rerunFailed: mutate,
        rerunParent: mutate,
        verify: mutate,
      }),
    ).rejects.toThrow(
      "parent-owned sealed candidate artifacts do not survive parent reruns; start a fresh all-group FRV",
    );
    expect(reads).toBe(0);
    expect(mutations).toBe(0);
  });

  it.each([
    ["candidate-free", undefined],
    ["externally produced", { producer: { runId: "88" } }],
  ])("allows %s plans through candidate ownership preflight", async (_label, candidate) => {
    const selected = child("normalCi", "101");
    await expect(
      preflightContinuation(
        { ...plan([selected]), candidate },
        "77",
        preflightMethods([selected], (entry) => runFor(entry, 1, "failure")),
      ),
    ).resolves.toMatchObject({ id: 77 });
  });

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
    const scenario = rerunScenario({
      childBefore: [
        [2, null],
        [2, "success"],
      ],
    });
    await withFastPolling(() =>
      expect(
        continueFailed(plan([scenario.selected]), "77", scenario.client),
      ).resolves.toMatchObject({ action: "reran-parent", finalRunId: "77" }),
    );
    expect(scenario.counters.posts.child).toBe(0);
  });

  it("reruns blocking children concurrently, preserves green and advisory children, then reruns the parent once", async () => {
    const first = child("normalCi", "101");
    const second = child("pluginPrerelease", "202");
    const green = child("releaseChecks", "303");
    const telegram = child("npmTelegram", "505");
    const selectedPlan = { ...plan([first, second, green, telegram]), releaseProfile: "full" };
    const childRuns = new Map([
      ["101", { attempt: 1, conclusion: "failure" }],
      ["202", { attempt: 1, conclusion: "failure" }],
      ["303", { attempt: 1, conclusion: "success" }],
      ["505", { attempt: 1, conclusion: "failure" }],
    ]);
    const parent = { attempt: 1, conclusion: "failure" as string | null };
    const events: string[] = [];
    let parentReruns = 0;
    const client = {
      ...controllerClient(selectedPlan.children, childRuns, parent),
      rerunFailed: async (runId: string) => {
        events.push(`child:${runId}`);
        childRuns.set(runId, { attempt: 2, conclusion: "success" });
        await Promise.resolve();
      },
      rerunParent: async () => {
        parentReruns += 1;
        events.push("parent");
        parent.attempt = 2;
        parent.conclusion = "success";
      },
      verify: async (
        _runId: string,
        _plan: Record<string, unknown>,
        _deadline?: number,
        attempts?: Record<string, number>,
      ) => {
        expect(attempts?.["505"]).toBe(1);
        events.push("verify");
        return "{}";
      },
    };
    const result = await continueFailed(selectedPlan, "77", client);
    expect(result).toMatchObject({ action: "reran-parent", finalRunId: "77" });
    expect(events.slice(0, 2).toSorted()).toEqual(["child:101", "child:202"]);
    expect(events).not.toContain("child:303");
    expect(events).not.toContain("child:505");
    expect(result.status.children).toContainEqual(
      expect.objectContaining({
        key: "npmTelegram",
        conclusion: "failure",
        passed: true,
        effectiveRunAttempt: 1,
      }),
    );
    expect(events.indexOf("parent")).toBeGreaterThan(events.indexOf("child:202"));
    expect(events.at(-1)).toBe("verify");
    expect(parentReruns).toBe(1);
  });

  it("does not rerun a parent that already seals the recovered child attempt", async () => {
    const selected = child("normalCi", "101");
    const childRuns = new Map([["101", { attempt: 1, conclusion: "failure" as string | null }]]);
    const parent = { attempt: 1, conclusion: "success" as string | null };
    const posts = { child: 0, parent: 0 };
    let sealedChildAttempt = 1;
    const client = {
      ...controllerClient([selected], childRuns, parent),
      rerunFailed: async () => {
        posts.child += 1;
        childRuns.set("101", { attempt: 2, conclusion: "success" });
      },
      rerunParent: async () => {
        posts.parent += 1;
        parent.attempt += 1;
        parent.conclusion = "success";
        sealedChildAttempt = childRuns.get("101")!.attempt;
      },
      verifySeal: async (
        _runId: string,
        _plan: Record<string, unknown>,
        _deadline: number,
        attempts: Record<string, number>,
      ) => attempts["101"] === sealedChildAttempt,
      verify: async (
        _runId: string,
        _plan: Record<string, unknown>,
        _deadline?: number,
        attempts?: Record<string, number>,
      ) => {
        expect(attempts?.["101"]).toBe(sealedChildAttempt);
        return "{}";
      },
    };

    await expect(continueFailed(plan([selected]), "77", client)).resolves.toMatchObject({
      action: "reran-parent",
    });
    await expect(continueFailed(plan([selected]), "77", client)).resolves.toMatchObject({
      action: "verified-parent",
    });
    expect(posts).toEqual({ child: 1, parent: 1 });
  });

  it.each(["child", "parent"])("reconciles a write-once %s rerun", async (target) => {
    const transportError = Object.assign(new Error("read ECONNRESET after dispatch"), {
      code: "ECONNRESET",
    });
    const scenario = rerunScenario(
      target === "child"
        ? {
            childAfter: [
              [1, null, "queued"],
              [1, null, undefined, undefined, "release-operator"],
              [2, "success"],
            ],
            childError: transportError,
          }
        : {
            childSource: [1, "success"],
            parentAfter: [
              [1, null, "queued"],
              [1, null],
              [2, "success"],
            ],
            parentError: transportError,
            parentSource: [1, "failure"],
          },
    );
    await withFastPolling(() =>
      expect(
        continueFailed(plan([scenario.selected]), "77", scenario.client),
      ).resolves.toMatchObject({ action: "reran-parent" }),
    );
    expect(
      target === "child" ? scenario.counters.posts.child : scenario.counters.posts.parent,
    ).toBe(1);
    expect(scenario.counters.verifies).toBe(1);
  });

  it("keeps the reconciliation timeout when no newer attempt appears", async () => {
    const scenario = rerunScenario({
      childAfter: [[1, "failure"]],
      childError: new Error("HTTP 502 after dispatch"),
    });
    await withFastPolling(
      () =>
        expect(continueFailed(plan([scenario.selected]), "77", scenario.client)).rejects.toThrow(
          "rerun mutation did not produce an observable newer attempt for 101 (101: HTTP 502 after dispatch)",
        ),
      "5",
    );
    expect(scenario.counters.posts.child).toBe(1);
  });

  it("keeps exact-terminal parent admission before dispatch", async () => {
    const scenario = rerunScenario({
      childSource: [1, "success"],
      parentBefore: [
        [1, "failure"],
        [2, null],
      ],
      parentSource: [1, "failure"],
    });
    await expect(continueFailed(plan([scenario.selected]), "77", scenario.client)).rejects.toThrow(
      "rerun source 77 is no longer the exact terminal run",
    );
    expect(scenario.counters.posts.parent).toBe(0);
  });

  it("binds mutation reconciliation to the original actor", async () => {
    const scenario = rerunScenario({
      childAfter: [[2, "success", undefined, "other-actor"]],
    });
    await expect(continueFailed(plan([scenario.selected]), "77", scenario.client)).rejects.toThrow(
      "rerun source 101 changed during mutation reconciliation",
    );
  });

  it.each([
    ["missing", 1, undefined, "101 run attempt must be a positive integer"],
    ["zero", 1, 0, "101 run attempt must be a positive integer"],
    ["regressed", 2, 1, "rerun source 101 attempt regressed"],
    ["skipped", 1, 3, "controller-owned run 101 advanced past attempt 2"],
  ])("rejects a %s child attempt", async (_label, sourceAttempt, observedAttempt, error) => {
    const scenario = rerunScenario({
      childAfter: [[observedAttempt, "success"]],
      childSource: [sourceAttempt, "failure"],
    });
    await expect(continueFailed(plan([scenario.selected]), "77", scenario.client)).rejects.toThrow(
      error,
    );
  });

  it.each([
    ["child", "HTTP 403: workflow rerun forbidden"],
    ["parent", "HTTP 422: workflow rerun rejected"],
  ])("does not poll after a hard %s mutation failure", async (target, error) => {
    const scenario = rerunScenario(
      target === "child"
        ? { childError: new Error(error) }
        : {
            childSource: [1, "success"],
            parentError: new Error(error),
            parentSource: [1, "failure"],
          },
    );
    await expect(continueFailed(plan([scenario.selected]), "77", scenario.client)).rejects.toThrow(
      error,
    );
    expect(
      target === "child" ? scenario.counters.reads.child : scenario.counters.reads.parent,
    ).toBe(0);
  });

  it("reconciles an ambiguous peer before surfacing a hard child mutation failure", async () => {
    const first = child("normalCi", "101");
    const second = child("pluginPrerelease", "202");
    const childRuns = new Map([
      ["101", { attempt: 1, conclusion: "failure" }],
      ["202", { attempt: 1, conclusion: "failure" }],
    ]);
    const parent = { attempt: 1, conclusion: "success" as string | null };
    const base = controllerClient([first, second], childRuns, parent);
    const calls: string[] = [];
    let dispatched = false;
    let hardRunReads = 0;
    const client = {
      ...base,
      getRun: async (runId: string) => {
        if (dispatched && runId === "202") {
          hardRunReads += 1;
        }
        return base.getRun(runId);
      },
      rerunFailed: async (runId: string) => {
        dispatched = true;
        calls.push(runId);
        if (runId === "101") {
          childRuns.set(runId, { attempt: 2, conclusion: "success" });
          throw new Error("HTTP 502 after dispatch");
        }
        throw new Error("HTTP 403: workflow rerun forbidden");
      },
      rerunParent: async () => {},
      verify: async () => "{}",
    };
    await expect(continueFailed(plan([first, second]), "77", client)).rejects.toThrow("HTTP 403");
    expect(calls.toSorted()).toEqual(["101", "202"]);
    expect(hardRunReads).toBe(0);
  });

  it.each([
    ["child", "101"],
    ["parent", "77"],
  ])("rejects %s attempt advancement before verification", async (target, targetRunId) => {
    const advancingStates = [
      [2, null],
      [2, "success"],
      [3, "success"],
    ] satisfies ScenarioState[];
    const scenario = rerunScenario(
      target === "child"
        ? { childAfter: advancingStates }
        : {
            childSource: [1, "success"],
            parentAfter: advancingStates,
            parentSource: [1, "failure"],
          },
    );
    await expect(continueFailed(plan([scenario.selected]), "77", scenario.client)).rejects.toThrow(
      `controller-owned run ${targetRunId} advanced past attempt 2`,
    );
    expect(scenario.counters.verifies).toBe(0);
  });

  it("freezes every selected and reused parent attempt for final verification", async () => {
    const scenario = rerunScenario({ childSource: [1, "success"] });
    const reusedPlan = validateReleaseExecutionPlanArtifact(
      executionPlanArtifact({
        children: [scenario.selected],
        evidenceReuse: {
          changedPaths: [],
          evidenceSha: TARGET_SHA,
          policy: "exact-target-full-validation-v1",
          requested: true,
          rootRunId: "88",
          runUrl: `https://github.com/${REPOSITORY}/actions/runs/88`,
          selectedRunId: "88",
          sourceManifest: { runAttempt: 3, runId: "88", targetSha: TARGET_SHA },
        },
      }),
    );
    const getRun = scenario.client.getRun;
    let expectedRunAttempts: Record<string, number> | undefined;
    const client = {
      ...scenario.client,
      getRun: async (runId: string) => {
        if (runId === "88") {
          return { ...rootRun(3, "success"), id: Number(runId) };
        }
        return getRun(runId);
      },
      verify: async (
        _runId: string,
        _plan: Record<string, unknown>,
        _deadline?: number,
        attempts?: Record<string, number>,
      ) => {
        expectedRunAttempts = attempts;
        return "{}";
      },
    };

    await expect(continueFailed(reusedPlan, "77", client)).resolves.toMatchObject({
      action: "verified-parent",
    });
    expect(expectedRunAttempts).toEqual({ "77": 1, "88": 3, "101": 1 });
  });

  it("fails closed without another POST when provenance changes during reconciliation", async () => {
    const scenario = rerunScenario({
      childAfter: [[1, "failure", undefined, undefined, undefined, "f".repeat(40)]],
      childError: new Error("HTTP 502 before dispatch"),
    });
    await withFastPolling(() =>
      expect(continueFailed(plan([scenario.selected]), "77", scenario.client)).rejects.toThrow(
        "rerun source 101 changed during mutation reconciliation",
      ),
    );
    expect(scenario.counters.posts.child).toBe(1);
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

describe("FRV rerun API", () => {
  it("uses the direct failed-jobs and parent rerun endpoints", async () => {
    const calls: string[][] = [];
    const client = createClient(REPOSITORY, {
      mutate: async (args: string[]) => {
        calls.push(args);
      },
    });
    await client.rerunFailed("101");
    await client.rerunParent("77");
    expect(calls).toEqual([
      ["api", "-X", "POST", `repos/${REPOSITORY}/actions/runs/101/rerun-failed-jobs`],
      ["api", "-X", "POST", `repos/${REPOSITORY}/actions/runs/77/rerun`],
    ]);
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
    await expect(
      client.verify("77", executionPlanArtifact(), Date.now() + 30_000, {
        "77": 2,
        "101": 2,
      }),
    ).resolves.toBe("{}");
    expect(args).toEqual(
      expect.arrayContaining([
        "--validate-run",
        "77",
        "--expected-run-attempts-json",
        '{"77":2,"101":2}',
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

  it("treats only typed verifier refresh failures as rerunnable", async () => {
    let refreshable = true;
    const client = createClient(REPOSITORY, {
      execCommand: async () => {
        throw Object.assign(new Error("verification failed"), {
          stdout: JSON.stringify({
            error: refreshable ? "parent evidence is stale" : "producer identity is invalid",
            ...(refreshable ? { refreshable: true } : {}),
            valid: false,
          }),
        });
      },
    });
    const attempts = { "77": 2, "101": 2 };

    await expect(
      client.verifySeal("77", executionPlanArtifact(), Date.now() + 30_000, attempts),
    ).resolves.toBe(false);

    refreshable = false;
    await expect(
      client.verifySeal("77", executionPlanArtifact(), Date.now() + 30_000, attempts),
    ).rejects.toThrow("verification failed");
  });
});

describe("FRV protected gh evidence reads", () => {
  it.each([
    ["getRun", ["101"], "actions/runs/101", { run_attempt: 2 }],
    ["getRunAttempt", ["101", 2], "actions/runs/101/attempts/2", { run_attempt: 2 }],
    [
      "getAttemptJobs",
      ["101", 2],
      "actions/runs/101/attempts/2/jobs?per_page=100",
      [{ id: 1 }, { id: 2 }],
    ],
    [
      "getParentJobs",
      ["77"],
      "actions/runs/77/jobs?filter=all&per_page=100",
      [{ id: 1 }, { id: 2 }],
    ],
    ["getJobLog", [1], "actions/jobs/1/logs", "job evidence"],
  ])("revalidates %s through the default protected route", (method, args, endpoint, expected) => {
    const result = runProtectedFrv(method, args as Array<string | number>, endpoint);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expected);
    expect(result.calls).toHaveLength(1);
  });

  it("preserves protected refusal status without retry or alternate execution", () => {
    const result = runProtectedFrv("getRun", ["101"], "actions/runs/101", true);
    expect(result.status).toBe(19);
    expect(result.stderr).toContain("protected refusal");
    expect(result.calls).toHaveLength(1);
  });
});

function runProtectedFrv(
  method: string,
  args: Array<string | number>,
  endpoint: string,
  denied = false,
) {
  const root = mkdtempSync(join(tmpdir(), "frv-protected-"));
  const gh = join(root, "gh");
  writeFileSync(
    gh,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync("calls.jsonl", JSON.stringify(args) + "\\n");
const fail = (message, code) => { console.error(message); process.exit(code); };
if (${denied}) fail("protected refusal", 19);
if (args[0] !== "api" || !args.includes(${JSON.stringify(`repos/${REPOSITORY}/${endpoint}`)})) fail("unexpected request", 17);
if (!args.some((arg, i) => ["-H", "--header"].includes(arg) && args[i+1] === "Cache-Control: max-age=0")) fail("missing live header", 18);
if (${endpoint.includes("/jobs?")}) {
  if (!args.includes("--paginate") || !args.includes(".jobs[] | @json")) fail("missing pagination", 17);
  console.log('{"id":1}\\n{"id":2}');
} else console.log(${endpoint.endsWith("/logs") ? JSON.stringify("job evidence") : JSON.stringify('{"run_attempt":2}')});
`,
  );
  chmodSync(gh, 0o755);
  try {
    const moduleUrl = pathToFileURL(join(process.cwd(), "scripts/frv.mjs")).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import {createClient} from ${JSON.stringify(moduleUrl)};
      try {
        console.log(JSON.stringify(await createClient(${JSON.stringify(REPOSITORY)})[${JSON.stringify(method)}](...${JSON.stringify(args)})));
      } catch (error) { console.error(error.message); process.exitCode = error.code; }
    `,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { HOME: root, PATH: `${root}${delimiter}${process.env.PATH ?? ""}` },
      },
    );
    return { ...result, calls: readFileSync(join(root, "calls.jsonl"), "utf8").trim().split("\n") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
