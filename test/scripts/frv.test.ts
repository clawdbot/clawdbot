import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  continueFailed,
  continuationBranchName,
  createClient,
  inspectContinuation,
  loadPlan,
  preflightContinuation,
  validateLegacySource,
} from "../../scripts/frv.mjs";
import {
  buildReleaseExecutionPlanArtifact,
  releaseChildSpec,
  releaseCompositeJobsSha256,
} from "../../scripts/full-release-validation-policy.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SHA = "a".repeat(40);
const TARGET_SHA = "b".repeat(40);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const VALIDATION_INPUTS = {
  allowUnreleasedChangelog: "false",
  codexPluginSpec: "",
  crossOsSuiteFilter: "",
  liveSuiteFilter: "",
  mode: "both",
  npmTelegramPackageSpec: "",
  npmTelegramProviderMode: "",
  npmTelegramScenario: "",
  packageAcceptancePackageSpec: "",
  pluginPrereleaseNodeExcludePatternsJson: "[]",
  provider: "openai",
  releasePackageSpec: "",
  skipPackageTelegramE2e: "false",
  targetContextRef: "",
};

function candidate(parentRunId = "77", parentRunAttempt = "1") {
  return {
    imageArchiveSha256: "1".repeat(64),
    imageArtifactDigest: "2".repeat(64),
    imageArtifactId: "12",
    imageArtifactName: `image-${parentRunId}-${parentRunAttempt}`,
    imageArtifactRunAttempt: parentRunAttempt,
    imageArtifactRunId: parentRunId,
    packageArtifactDigest: "3".repeat(64),
    packageArtifactId: "13",
    packageArtifactName: `package-${parentRunId}-${parentRunAttempt}`,
    packageArtifactRunAttempt: parentRunAttempt,
    packageArtifactRunId: parentRunId,
    packageFileName: "openclaw-current.tgz",
    packageSha256: "4".repeat(64),
    packageSourceSha: TARGET_SHA,
    packageVersion: "2026.8.1-beta.3",
    prepublishPluginRegistryArtifactDigest: "5".repeat(64),
    prepublishPluginRegistryArtifactId: "14",
    prepublishPluginRegistryArtifactName: `plugins-${parentRunId}-${parentRunAttempt}`,
    prepublishPluginRegistryArtifactRunAttempt: parentRunAttempt,
    prepublishPluginRegistryArtifactRunId: parentRunId,
    prepublishPluginRegistryManifestSha256: "6".repeat(64),
  };
}

function continuation() {
  return {
    candidate: candidate(),
    publicationEnabled: false,
    releaseProfile: "beta",
    rerunGroup: "all",
    runReleaseSoak: "false",
    sourceDisplayTitle: "Full Release Validation",
    sourceEvent: "workflow_dispatch",
    sourceRepository: "openclaw/openclaw",
    sourceRunAttempt: 1,
    sourceRunId: "77",
    sourceWorkflowPath: ".github/workflows/full-release-validation.yml",
    sourceWorkflowRef: "release-ci/tooling",
    sourceWorkflowSha: SHA,
    toolingSha: SHA,
    validationInputs: VALIDATION_INPUTS,
  };
}

function sealedContinuationPlan(selected = child("normalCi", "101"), parentRunId = "88") {
  const source = continuation();
  const branch = continuationBranchName(source.sourceRunId, source.toolingSha);
  return buildReleaseExecutionPlanArtifact({
    attemptEvidenceVersion: 1,
    children: [
      {
        ...selected,
        dispatchName: "Dispatch CI",
        result: "success",
        source: "continuation",
      },
    ],
    continuation: source,
    evidenceReuse: { requested: false },
    expected: {
      parentRunAttempt: 1,
      parentRunId,
      targetSha: TARGET_SHA,
      workflowRef: branch,
      workflowSha: SHA,
    },
    gates: [{ name: "Resolve target ref", required: true, result: "success" }],
    releaseProfile: "beta",
    rerunGroup: "all",
    trustedWorkflow: { fullRef: "refs/heads/main", ref: "main", sha: SHA },
  });
}

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
  return {
    displayTitle: key,
    key,
    required: true,
    runAttempt: 1,
    runId,
    selected: true,
    sourceParentAttempt: 1,
    url: `https://example.invalid/runs/${runId}`,
    workflow: `${key}.yml`,
    workflowRef: "release-ci/tooling",
    workflowSha: SHA,
  };
}

function runFor(entry: ReturnType<typeof child>, attempt: number, conclusion: string | null) {
  return {
    conclusion,
    actor: { login: "github-actions[bot]" },
    display_title: entry.displayTitle,
    event: "workflow_dispatch",
    head_branch: entry.workflowRef,
    head_sha: entry.workflowSha,
    html_url: entry.url,
    id: Number(entry.runId),
    path: `.github/workflows/${entry.workflow}`,
    repository: { full_name: "openclaw/openclaw" },
    run_attempt: attempt,
    status: conclusion === null ? "in_progress" : "completed",
    triggering_actor: { login: attempt > 1 ? "release-operator" : "github-actions[bot]" },
  };
}

function plan(children: ReturnType<typeof child>[]) {
  return {
    children,
    parentRunAttempt: 1,
    parentRunId: "77",
    releaseProfile: "beta",
    rerunGroup: "all",
    targetSha: TARGET_SHA,
    workflowRef: "release-ci/tooling",
    workflowSha: SHA,
  };
}

function preflightMethods(
  children: ReturnType<typeof child>[],
  childRun: (entry: ReturnType<typeof child>) => Record<string, unknown>,
  candidateIdentity?: ReturnType<typeof candidate>,
) {
  const byRunId = new Map(children.map((entry) => [entry.runId, entry]));
  const jobs = [
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
      run_attempt: entry.sourceParentAttempt,
      status: "completed",
    })),
  ];
  return {
    getJobLog: async (jobId: number) => {
      if (jobId === 1) {
        return `RERUN_GROUP: all\nTARGET_SHA: ${TARGET_SHA}`;
      }
      const entry = children[jobId - 2]!;
      return [
        `TARGET_SHA: ${TARGET_SHA}`,
        ...(entry.key === "productPerformance" ? ["-f publish_reports=false"] : []),
        ...(candidateIdentity && ["pluginPrerelease", "releaseChecks"].includes(entry.key)
          ? [`CANDIDATE_ARTIFACT_JSON: ${JSON.stringify(candidateIdentity)}`]
          : []),
        `Dispatched ${entry.workflow}: https://github.com/openclaw/openclaw/actions/runs/${entry.runId} (attempt ${entry.runAttempt})`,
      ].join("\n");
    },
    getParentJobs: async () => jobs,
    getRunAttempt: async (runId: string) => {
      if (runId === "77") {
        return {
          display_title: "Full Release Validation",
          event: "workflow_dispatch",
          head_branch: "release-ci/tooling",
          head_sha: SHA,
          id: 77,
          path: ".github/workflows/full-release-validation.yml",
          repository: { full_name: "openclaw/openclaw" },
          run_attempt: 1,
        };
      }
      return childRun(byRunId.get(runId)!);
    },
  };
}

describe("frv continuation controller", () => {
  it("adopts an active newer attempt without rerunning it", async () => {
    const selected = child("normalCi", "101");
    let reads = 0;
    let reruns = 0;
    const client = {
      ...preflightMethods([selected], (entry) => runFor(entry, 1, "failure")),
      getAttemptJobs: async (_runId: string, attempt: number) =>
        attempt === 1 ? [job("test", "failure")] : reads < 2 ? [] : [job("test")],
      getRun: async (runId: string) => {
        if (runId === "77") {
          return { conclusion: "success", id: 77, run_attempt: 1, status: "completed" };
        }
        reads += 1;
        return reads < 2 ? runFor(selected, 2, null) : runFor(selected, 2, "success");
      },
      rerunFailed: async () => {
        reruns += 1;
      },
      rerunParent: async () => {},
      verify: async () => "{}",
      repository: "openclaw/openclaw",
    };
    process.env.OPENCLAW_FRV_POLL_MS = "1";
    process.env.OPENCLAW_FRV_TIMEOUT_MS = "100";
    const result = await continueFailed(plan([selected]), "77", client);
    expect(result.action).toBe("verified-parent");
    expect(reruns).toBe(0);
  });

  it("reruns failed children concurrently, leaves green children untouched, then reruns parent", async () => {
    const first = child("normalCi", "101");
    const second = child("pluginPrerelease", "202");
    const green = child("releaseChecks", "303");
    const attempts = new Map([
      ["101", 1],
      ["202", 1],
      ["303", 1],
      ["77", 1],
    ]);
    const conclusions = new Map([
      ["101", "failure"],
      ["202", "failure"],
      ["303", "success"],
      ["77", "failure"],
    ]);
    const events: string[] = [];
    const byId = new Map([
      ["101", first],
      ["202", second],
      ["303", green],
    ]);
    const client = {
      ...preflightMethods([first, second, green], (entry) =>
        runFor(entry, 1, conclusions.get(entry.runId)!),
      ),
      getAttemptJobs: async (runId: string, attempt: number) => [
        job("test", attempt === 1 ? conclusions.get(runId) : "success"),
      ],
      getRun: async (runId: string) => {
        if (runId === "77") {
          return {
            conclusion: conclusions.get(runId),
            id: 77,
            run_attempt: attempts.get(runId),
            status: "completed",
          };
        }
        const entry = byId.get(runId)!;
        return runFor(entry, attempts.get(runId)!, conclusions.get(runId)!);
      },
      rerunFailed: async (runId: string) => {
        events.push(`child:${runId}`);
        attempts.set(runId, 2);
        conclusions.set(runId, "success");
        await Promise.resolve();
      },
      rerunParent: async () => {
        events.push("parent");
        attempts.set("77", 2);
        conclusions.set("77", "success");
      },
      verify: async () => {
        events.push("verify");
        return "{}";
      },
      repository: "openclaw/openclaw",
    };
    const result = await continueFailed(plan([first, second, green]), "77", client);
    expect(result.finalRunId).toBe("77");
    expect(events.slice(0, 2).toSorted()).toEqual(["child:101", "child:202"]);
    expect(events).not.toContain("child:303");
    expect(events.indexOf("parent")).toBeGreaterThan(events.indexOf("child:202"));
    expect(events.at(-1)).toBe("verify");
  });

  it("dispatches a zero-child continuation parent for an explicit legacy source", async () => {
    const selected = child("normalCi", "101");
    const legacyContinuation = {
      candidate: candidate(),
      publicationEnabled: false,
      releaseProfile: "beta",
      rerunGroup: "all",
      runReleaseSoak: "false",
      sourceDisplayTitle: "Full Release Validation",
      sourceEvent: "workflow_dispatch",
      sourceRepository: "openclaw/openclaw",
      sourceRunAttempt: 1,
      sourceRunId: "77",
      sourceWorkflowPath: ".github/workflows/full-release-validation.yml",
      sourceWorkflowRef: "release-ci/tooling",
      sourceWorkflowSha: SHA,
      toolingSha: SHA,
      validationInputs: VALIDATION_INPUTS,
    };
    const finalPlan = buildReleaseExecutionPlanArtifact({
      attemptEvidenceVersion: 1,
      children: [
        {
          ...selected,
          dispatchName: "Dispatch CI",
          result: "success",
          source: "continuation",
        },
      ],
      continuation: legacyContinuation,
      evidenceReuse: { requested: false },
      expected: {
        parentRunAttempt: 1,
        parentRunId: "88",
        targetSha: TARGET_SHA,
        workflowRef: "release-ci/current",
        workflowSha: SHA,
      },
      gates: [{ name: "Resolve target ref", required: true, result: "success" }],
      releaseProfile: "beta",
      rerunGroup: "all",
      trustedWorkflow: { fullRef: "refs/heads/main", ref: "main", sha: SHA },
    });
    let dispatched = 0;
    let deletedBranch = "";
    let parentReruns = 0;
    const client = {
      ...preflightMethods([selected], (entry) => runFor(entry, 1, "success"), candidate()),
      deleteWorkflowRef: async (branch: string) => {
        deletedBranch = branch;
      },
      dispatchContinuation: async () => {
        dispatched += 1;
        return { branch: "release-ci/current", runId: "88", workflowSha: SHA };
      },
      getAttemptJobs: async () => [job("test")],
      getRun: async (runId: string) =>
        runId === "88"
          ? { conclusion: "success", id: 88, run_attempt: 1, status: "completed" }
          : runFor(selected, 1, "success"),
      rerunFailed: async () => {},
      rerunParent: async () => {
        parentReruns += 1;
      },
      verify: async () => "{}",
      repository: "openclaw/openclaw",
    };
    await continueFailed(
      {
        children: { normalCi: selected },
        continuation: legacyContinuation,
        legacy: true,
        releaseProfile: "beta",
        rerunGroup: "all",
        targetSha: TARGET_SHA,
      },
      "77",
      client,
      { loadExecutionPlan: async () => finalPlan },
    );
    expect(dispatched).toBe(1);
    expect(deletedBranch).toBe("release-ci/current");
    expect(parentReruns).toBe(0);
  });

  it("rejects incomplete or drifted legacy child inventories", () => {
    const legacyChild = (key: string, runId: string) => {
      const spec = releaseChildSpec(key);
      return {
        ...child(key, runId),
        displayTitle: `${spec.displayName} full-release-validation-77-1${spec.suffix}`,
        url: `https://github.com/openclaw/openclaw/actions/runs/${runId}`,
        workflow: spec.workflow,
        workflowRef: "release-ci/legacy",
      };
    };
    const normalCi = legacyChild("normalCi", "101");
    const legacy = {
      candidate: candidate(),
      children: {
        normalCi,
        pluginPrerelease: {
          ...legacyChild("pluginPrerelease", "202"),
        },
        productPerformance: {
          ...legacyChild("productPerformance", "303"),
        },
        releaseChecks: {
          ...legacyChild("releaseChecks", "404"),
        },
      },
      releaseProfile: "beta",
      runReleaseSoak: "false",
      source: {
        displayTitle: "Full Release Validation",
        event: "workflow_dispatch",
        repository: "openclaw/openclaw",
        runAttempt: 1,
        runId: "77",
        workflowPath: ".github/workflows/full-release-validation.yml",
        workflowRef: "release-ci/legacy",
        workflowSha: SHA,
      },
      targetSha: TARGET_SHA,
      toolingSha: SHA,
      validationInputs: VALIDATION_INPUTS,
    };
    expect(validateLegacySource(legacy, "77")).toMatchObject({
      children: {
        normalCi: {
          runAttempt: normalCi.runAttempt,
          runId: normalCi.runId,
          workflow: normalCi.workflow,
          workflowRef: normalCi.workflowRef,
          workflowSha: normalCi.workflowSha,
        },
      },
      targetSha: TARGET_SHA,
    });
    expect(() =>
      validateLegacySource(
        {
          ...legacy,
          children: {
            ...legacy.children,
            unknown: { ...normalCi, workflow: "ci.yml" },
          },
        },
        "77",
      ),
    ).toThrow("legacy continuation child key is invalid: unknown");
    expect(() =>
      validateLegacySource(
        {
          ...legacy,
          children: {
            ...legacy.children,
            normalCi: { ...normalCi, workflow: "openclaw-release-checks.yml" },
          },
        },
        "77",
      ),
    ).toThrow("legacy continuation child identity is invalid: normalCi");
    expect(() =>
      validateLegacySource(
        {
          ...legacy,
          children: {
            normalCi,
          },
        },
        "77",
      ),
    ).toThrow("legacy continuation child inventory is invalid");
    expect(() =>
      validateLegacySource(
        {
          ...legacy,
          validationInputs: { mode: "both", provider: "openai" },
        },
        "77",
      ),
    ).toThrow("legacy continuation validation inputs are incomplete");
  });

  it("reports the effective attempt and composite digest", async () => {
    const selected = child("normalCi", "101");
    const result = await inspectContinuation(plan([selected]), {
      getAttemptJobs: async (_runId: string, attempt: number) => [
        job("test", attempt === 1 ? "failure" : "success"),
      ],
      getRun: async () => runFor(selected, 2, "success"),
    });
    const expectedJobs = [
      {
        acceptedRunAttempt: 2,
        completedAt: "2026-08-22T00:01:00Z",
        conclusion: "success",
        name: "test",
        startedAt: "2026-08-22T00:00:00Z",
        status: "completed",
        url: "https://example.invalid/jobs/test",
      },
    ];
    expect(result.children[0]).toMatchObject({
      compositeJobsSha256: releaseCompositeJobsSha256({
        effectiveRunAttempt: 2,
        jobs: expectedJobs,
        plannedRunAttempt: 1,
      }),
      effectiveRunAttempt: 2,
      status: "passed",
    });
  });

  it("rejects legacy mode when the root already has a canonical plan", async () => {
    const root = tempDirs.make("frv-legacy-bypass-");
    const legacyPlanPath = join(root, "legacy.json");
    writeFileSync(legacyPlanPath, "{}");
    await expect(
      loadPlan(
        {
          legacyPlanPath,
          repository: "openclaw/openclaw",
          runId: "88",
        },
        async () => sealedContinuationPlan(child("normalCi", "101"), "88"),
      ),
    ).rejects.toThrow("run has a canonical execution plan; reject --legacy-plan");
  });

  it("rejects focused and non-FRV roots before any mutation", async () => {
    const selected = child("normalCi", "101");
    let mutations = 0;
    const baseClient = {
      ...preflightMethods([selected], (entry) => runFor(entry, 1, "failure")),
      getAttemptJobs: async () => [job("test", "failure")],
      getRun: async () => runFor(selected, 1, "failure"),
      repository: "openclaw/openclaw",
      rerunFailed: async () => {
        mutations += 1;
      },
      rerunParent: async () => {
        mutations += 1;
      },
      verify: async () => "{}",
    };
    await expect(
      continueFailed({ ...plan([selected]), rerunGroup: "ci" }, "77", baseClient),
    ).rejects.toThrow("requires an all-group root");
    const wrongWorkflow = {
      ...baseClient,
      getRunAttempt: async (runId: string) =>
        runId === "77"
          ? {
              display_title: "Full Release Validation",
              event: "workflow_dispatch",
              head_branch: "release-ci/tooling",
              head_sha: SHA,
              id: 77,
              path: ".github/workflows/ci.yml",
              repository: { full_name: "openclaw/openclaw" },
              run_attempt: 1,
            }
          : runFor(selected, 1, "failure"),
    };
    await expect(continueFailed(plan([selected]), "77", wrongWorkflow)).rejects.toThrow(
      "source full release parent identity changed",
    );
    expect(mutations).toBe(0);
  });

  it("rejects a source from the wrong repository before mutation", async () => {
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
          return {
            ...run,
            repository: { full_name: "someone/else" },
          };
        },
        repository: "openclaw/openclaw",
        rerunFailed: async () => {
          mutations += 1;
        },
      }),
    ).rejects.toThrow("source full release parent identity changed");
    expect(mutations).toBe(0);
  });

  it("reconciles a partial transient rerun failure without duplicating work", async () => {
    const first = child("normalCi", "101");
    const second = child("pluginPrerelease", "202");
    const attempts = new Map([
      ["101", 1],
      ["202", 1],
      ["77", 1],
    ]);
    const conclusions = new Map([
      ["101", "failure"],
      ["202", "failure"],
      ["77", "success"],
    ]);
    const calls: string[] = [];
    const byId = new Map([
      ["101", first],
      ["202", second],
    ]);
    const client = {
      ...preflightMethods([first, second], (entry) => runFor(entry, 1, "failure")),
      getAttemptJobs: async (_runId: string, attempt: number) => [
        job("test", attempt === 1 ? "failure" : "success"),
      ],
      getRun: async (runId: string) =>
        runId === "77"
          ? {
              conclusion: conclusions.get(runId),
              id: 77,
              run_attempt: attempts.get(runId),
              status: "completed",
            }
          : runFor(byId.get(runId)!, attempts.get(runId)!, conclusions.get(runId)!),
      repository: "openclaw/openclaw",
      rerunFailed: async (runId: string) => {
        calls.push(runId);
        attempts.set(runId, 2);
        conclusions.set(runId, "success");
        if (runId === "101") {
          throw new Error("HTTP 502 after dispatch");
        }
      },
      rerunParent: async () => {},
      verify: async () => "{}",
    };
    process.env.OPENCLAW_FRV_POLL_MS = "1";
    process.env.OPENCLAW_FRV_RECONCILE_TIMEOUT_MS = "100";
    const result = await continueFailed(plan([first, second]), "77", client);
    expect(result.action).toBe("verified-parent");
    expect(calls.toSorted()).toEqual(["101", "202"]);
  });

  it("uses frozen tooling, adopts the same parent on restart, and never reselects main", async () => {
    const reviewed = {
      children: { normalCi: child("normalCi", "101") },
      continuation: continuation(),
      legacy: true,
      releaseProfile: "beta",
      rerunGroup: "all",
      targetSha: TARGET_SHA,
    };
    const branch = continuationBranchName("77", SHA);
    const sealed = sealedContinuationPlan(child("normalCi", "101"));
    const reads: string[] = [];
    const mutations: string[][] = [];
    const client = createClient("openclaw/openclaw", {
      apiJson: async (path: string) => {
        reads.push(path);
        if (path.startsWith("contents/")) {
          return { content: Buffer.from("continuation_plan_json:").toString("base64") };
        }
        if (path.startsWith("git/ref/")) {
          return { object: { sha: SHA } };
        }
        if (path.startsWith("actions/workflows/")) {
          return {
            workflow_runs: [
              {
                event: "workflow_dispatch",
                head_branch: branch,
                head_sha: SHA,
                id: 88,
                path: ".github/workflows/full-release-validation.yml",
              },
            ],
          };
        }
        if (path === "actions/runs/88") {
          return {
            event: "workflow_dispatch",
            head_branch: branch,
            head_sha: SHA,
            id: 88,
            path: ".github/workflows/full-release-validation.yml",
            repository: { full_name: "openclaw/openclaw" },
          };
        }
        throw new Error(`unexpected read: ${path}`);
      },
      loadExecutionPlan: async () => sealed,
      mutate: async (args: string[]) => {
        mutations.push(args);
        return "";
      },
    });
    expect(await client.dispatchContinuation(reviewed)).toMatchObject({ branch, runId: "88" });
    expect(await client.dispatchContinuation(reviewed)).toMatchObject({ branch, runId: "88" });
    expect(mutations).toEqual([]);
    expect(reads.some((path) => path.includes(`?ref=${SHA}`))).toBe(true);
    expect(
      reads.every((path) => !path.includes("origin/main") && !path.endsWith("?ref=main")),
    ).toBe(true);
  });

  it("refuses to delete a deterministic ref whose OID changed", async () => {
    const mutations: string[][] = [];
    const client = createClient("openclaw/openclaw", {
      apiJson: async () => ({ object: { sha: "f".repeat(40) } }),
      mutate: async (args: string[]) => {
        mutations.push(args);
        return "";
      },
    });
    await expect(client.deleteWorkflowRef(continuationBranchName("77", SHA), SHA)).rejects.toThrow(
      "moved before cleanup",
    );
    expect(mutations).toEqual([]);
  });

  it("rejects a supplied child not emitted by the source parent", async () => {
    const selected = child("normalCi", "101");
    const methods = preflightMethods([selected], (entry) => runFor(entry, 1, "failure"));
    await expect(
      preflightContinuation(plan([selected]), "77", {
        ...methods,
        getJobLog: async (jobId: number) =>
          jobId === 1
            ? `RERUN_GROUP: all\nTARGET_SHA: ${TARGET_SHA}`
            : `TARGET_SHA: ${TARGET_SHA}\nDispatched ci.yml: https://github.com/openclaw/openclaw/actions/runs/999 (attempt 1)`,
      }),
    ).rejects.toThrow("not uniquely emitted");
  });
});
