import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFrontierModeConfigProof,
  buildFrozenFrontierMatrixPlan,
  createFrozenFrontierMatrixChildIsolation,
  runFrozenFrontierMatrix,
  verifyFrontierAuditBundle,
  verifyFrozenFrontierMatrixPlan,
  type FrontierExecutionProof,
  type FrozenFrontierMatrixPlan,
} from "../../scripts/lib/code-mode-frontier-matrix.js";
import {
  cleanupFrontierTempRoots,
  collectFrontierKeys as collectKeys,
  comparableFrontierProof as comparableProof,
  frontierClocks as clocks,
  frontierEnvelope as envelope,
  frontierIdentity as identity,
  frontierPlan as plan,
  frontierRunner as runner,
  frontierTempRoot as tempRoot,
} from "./code-mode-frontier-matrix.fixtures.js";

afterEach(async () => {
  await cleanupFrontierTempRoots();
});

describe("frozen frontier matrix plan", () => {
  it("binds task-major task x ABBA order and every identity dimension", () => {
    const matrixPlan = plan();

    expect(matrixPlan.task).toMatchObject({
      subset: ["task-a", "task-b"],
      order: ["task-b", "task-a"],
      subsetSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      orderSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      manifestSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(matrixPlan.cells.map((cell) => cell.id)).toEqual([
      "task-b:direct-1",
      "task-b:code-1",
      "task-b:code-2",
      "task-b:direct-2",
      "task-a:direct-1",
      "task-a:code-1",
      "task-a:code-2",
      "task-a:direct-2",
    ]);
    expect(new Set(matrixPlan.cells.map((cell) => cell.stateKey)).size).toBe(8);
    expect(verifyFrozenFrontierMatrixPlan(matrixPlan)).toBe(true);

    for (const mutate of [
      (value: FrozenFrontierMatrixPlan) => {
        value.task.manifest[0]!.promptSha256 = "9".repeat(64);
      },
      (value: FrozenFrontierMatrixPlan) => {
        value.execution.sampling.seed = "changed";
      },
      (value: FrozenFrontierMatrixPlan) => {
        value.execution.proof.providerRetry.maxRetries = 1;
      },
      (value: FrozenFrontierMatrixPlan) => {
        value.cells[0]!.taskSha256 = "8".repeat(64);
      },
    ]) {
      const tampered = structuredClone(matrixPlan);
      mutate(tampered);
      expect(verifyFrozenFrontierMatrixPlan(tampered)).toBe(false);
    }
  });

  it("keeps Direct and Code child configs mode-only and credentials out of artifacts", async () => {
    const credential = "frontier-matrix-test-token";
    const stateDir = await tempRoot();
    const base = {
      agentId: "proof",
      authProfileId: "openai:proof",
      credential,
      model: "openai/gpt-test",
      sourceEnv: { PATH: "/usr/bin", OPENAI_API_KEY: credential },
    };
    const direct = createFrozenFrontierMatrixChildIsolation({ ...base, mode: "direct" });
    const code = createFrozenFrontierMatrixChildIsolation({ ...base, mode: "code" });
    const directConfig = await direct.prepareConfigBeforeSpawn({
      config: {},
      recordPortableCodexAuth: () => {},
      stateDir: path.join(stateDir, "direct"),
      tempRoot: stateDir,
    });
    const codeConfig = await code.prepareConfigBeforeSpawn({
      config: {},
      recordPortableCodexAuth: () => {},
      stateDir: path.join(stateDir, "code"),
      tempRoot: stateDir,
    });

    expect(direct.childBaseEnv).toEqual({ PATH: "/usr/bin" });
    expect(() =>
      buildFrontierModeConfigProof({ agentId: "proof", direct: directConfig, code: codeConfig }),
    ).not.toThrow();
    expect(JSON.stringify({ direct, code })).not.toContain(credential);
  });

  it("requires explicit clean source state and reapplies semantic invariants", () => {
    const matrixPlan = plan();
    const missingCleanliness = structuredClone(matrixPlan);
    delete (missingCleanliness.source as Partial<typeof missingCleanliness.source>).sourceDirty;
    expect(verifyFrozenFrontierMatrixPlan(missingCleanliness)).toBe(false);

    const equalModes = structuredClone(matrixPlan);
    equalModes.execution.modeConfigProof.codeSha256 =
      equalModes.execution.modeConfigProof.directSha256;
    expect(verifyFrozenFrontierMatrixPlan(equalModes)).toBe(false);

    const invalidRetry = structuredClone(matrixPlan);
    invalidRetry.execution.proof.providerRetry.maxRetries = -1;
    expect(verifyFrozenFrontierMatrixPlan(invalidRetry)).toBe(false);

    const malformedIdentity = structuredClone(identity) as Partial<typeof identity>;
    delete malformedIdentity.sourceDirty;
    expect(() =>
      buildFrozenFrontierMatrixPlan({
        api: matrixPlan.model.api,
        blockId: matrixPlan.campaign.blockId,
        campaignId: matrixPlan.campaign.id,
        campaignNonce: "one-use-campaign-nonce",
        executionProof: comparableProof,
        identity: malformedIdentity as typeof identity,
        modeConfigProof: matrixPlan.execution.modeConfigProof,
        model: matrixPlan.model.ref,
        runDate: matrixPlan.runDate,
        runner: matrixPlan.execution.runner,
        sampling: {
          seedSupport: matrixPlan.execution.sampling.seedSupport,
          seed: matrixPlan.execution.sampling.seed,
        },
        tasks: matrixPlan.task.manifest.map(
          ({ id, fixtureSha256, promptSha256, oracleSha256 }) => ({
            id,
            fixtureSha256,
            promptSha256,
            oracleSha256,
          }),
        ),
      }),
    ).toThrow("clean frozen runtime identity");
  });
});

describe("frozen frontier matrix runner", () => {
  it("owns monotonic timing, conserves multi-task bundles, and never promotes fixtures", async () => {
    const repoRoot = await tempRoot();
    const matrixPlan = plan();
    const observed: string[] = [];
    const result = await runFrozenFrontierMatrix({
      repoRoot,
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        evidenceSource: "test_fixture",
        readIdentity: async () => identity,
        runCell: async (cell, currentPlan) => {
          expect(currentPlan.identitySha256).toBe(matrixPlan.identitySha256);
          observed.push(cell.id);
          return runner()(cell, currentPlan);
        },
        ...clocks(),
      },
    });

    expect(observed).toEqual(matrixPlan.cells.map((cell) => cell.id));
    expect(result.results).toHaveLength(8);
    expect(
      result.results.every((entry) => entry.auditBundle?.execution.wallLatencyMs === 125),
    ).toBe(true);
    expect(
      result.results.every((entry) => verifyFrontierAuditBundle(entry.auditBundle!, matrixPlan)),
    ).toBe(true);
    expect(result.summary).toMatchObject({
      evidenceValid: false,
      betaEligible: false,
      comparability: { state: "blocked", reasons: ["simulated_or_test_fixture"] },
      direct: {
        cells: 4,
        passed: 4,
        validTraces: 4,
        totals: {
          effectiveTurns: 12,
          totalTokens: 520,
          underlyingTotalCalls: 24,
          wallLatencyMs: 500,
        },
      },
      code: {
        cells: 4,
        passed: 4,
        validTraces: 4,
        totals: {
          effectiveTurns: 8,
          totalTokens: 400,
          underlyingTotalCalls: 16,
          wallLatencyMs: 500,
        },
      },
      bars: {
        allTasksPassed: true,
        accuracyNonRegression: true,
        fewerEffectiveTurns: true,
        fewerTokens: true,
        totalCallsNonRegression: true,
        wallLatencyNonRegression: true,
        auditableMatchedTraces: false,
      },
    });
    const persisted = (await fs.readFile(path.join(repoRoot, "evidence", "results.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(persisted).toHaveLength(8);
    const keys = collectKeys(persisted);
    expect([...keys].filter((key) => ["payloads", "sessionId", "final"].includes(key))).toEqual([]);
    const bundle = persisted[0].auditBundle;
    expect(verifyFrontierAuditBundle(bundle, matrixPlan)).toBe(true);
    bundle.execution.wallLatencyMs += 1;
    expect(verifyFrontierAuditBundle(bundle, matrixPlan)).toBe(false);
  });

  it("defaults injected runners to fixture evidence", async () => {
    const matrixPlan = plan();
    const result = await runFrozenFrontierMatrix({
      repoRoot: await tempRoot(),
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        readIdentity: async () => identity,
        runCell: runner(),
        ...clocks(),
      },
    });

    expect(result.summary).toMatchObject({
      evidenceSource: "test_fixture",
      betaEligible: false,
      comparability: {
        state: "blocked",
        reasons: expect.arrayContaining(["simulated_or_test_fixture"]),
      },
    });
  });

  it.each([
    ["task", "taskId", "task-wrong"],
    ["config", "modeConfigSha256", "0".repeat(64)],
  ] as const)("rejects observed %s receipt swaps", async (_label, field, mismatch) => {
    const matrixPlan = plan();
    const result = await runFrozenFrontierMatrix({
      repoRoot: await tempRoot(),
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        evidenceSource: "test_fixture",
        readIdentity: async () => identity,
        runCell: async (cell, currentPlan) => {
          const observation = await runner()(cell, currentPlan);
          observation.receipt[field] = mismatch as never;
          return observation;
        },
        ...clocks(),
      },
    });

    expect(result.results[0]).toMatchObject({
      failure: "execution_receipt_mismatch",
      passed: false,
    });
    expect(result.summary.comparability.reasons).toContain(
      "non_task_failure:execution_receipt_mismatch",
    );
  });

  it("rechecks frozen identity after the final cell", async () => {
    const matrixPlan = plan();
    let identityReads = 0;
    let cellCalls = 0;
    const result = await runFrozenFrontierMatrix({
      repoRoot: await tempRoot(),
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        evidenceSource: "test_fixture",
        readIdentity: async () => {
          identityReads += 1;
          return identityReads === matrixPlan.cells.length * 2
            ? { ...identity, buildSha256: "0".repeat(64) }
            : identity;
        },
        runCell: async (cell, currentPlan) => {
          cellCalls += 1;
          return runner()(cell, currentPlan);
        },
        ...clocks(),
      },
    });

    expect(cellCalls).toBe(matrixPlan.cells.length);
    expect(identityReads).toBe(matrixPlan.cells.length * 2);
    expect(result.results.at(-1)).toMatchObject({
      failure: "frozen_identity_mismatch",
      passed: false,
    });
    expect(result.summary.comparability.reasons).toContain(
      "non_task_failure:frozen_identity_mismatch",
    );
  });

  it("records a bounded failure when post-cell identity observation fails", async () => {
    const matrixPlan = plan();
    let identityReads = 0;
    const result = await runFrozenFrontierMatrix({
      repoRoot: await tempRoot(),
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        evidenceSource: "test_fixture",
        readIdentity: async () => {
          identityReads += 1;
          if (identityReads === 2) {
            throw new Error("identity unavailable");
          }
          return identity;
        },
        runCell: runner(),
        ...clocks(),
      },
    });

    expect(result.results[0]).toMatchObject({
      failure: "identity_observation_failed",
      passed: false,
    });
    expect(result.summary.comparability.reasons).toContain(
      "non_task_failure:identity_observation_failed",
    );
  });

  it("records a bounded failure when pre-cell identity observation fails", async () => {
    let cellCalls = 0;
    const result = await runFrozenFrontierMatrix({
      repoRoot: await tempRoot(),
      outputDir: "evidence",
      plan: plan(),
      deps: {
        evidenceSource: "test_fixture",
        readIdentity: async () => {
          throw new Error("identity unavailable");
        },
        runCell: async (cell, matrixPlan) => {
          cellCalls += 1;
          return runner()(cell, matrixPlan);
        },
        ...clocks(),
      },
    });

    expect(cellCalls).toBe(0);
    expect(result.results[0]).toMatchObject({
      failure: "identity_observation_failed",
      passed: false,
    });
    expect(result.summary.comparability.reasons).toContain(
      "non_task_failure:identity_observation_failed",
    );

    const timedOut = await runFrozenFrontierMatrix({
      repoRoot: await tempRoot(),
      outputDir: "timeout",
      plan: plan(comparableProof, 1),
      deps: {
        evidenceSource: "test_fixture",
        readIdentity: async () => await new Promise<never>(() => {}),
        runCell: runner(),
        ...clocks(),
      },
    });
    expect(timedOut.results[0]).toMatchObject({ failure: "identity_observation_failed" });

    const matrixPlan = plan();
    let identityReads = 0;
    let completedCells = 0;
    const finalCell = await runFrozenFrontierMatrix({
      repoRoot: await tempRoot(),
      outputDir: "final-cell",
      plan: matrixPlan,
      deps: {
        evidenceSource: "test_fixture",
        readIdentity: async () => {
          identityReads += 1;
          if (identityReads === matrixPlan.cells.length * 2 - 1) {
            throw new Error("final pre-cell identity unavailable");
          }
          return identity;
        },
        runCell: async (cell, currentPlan) => {
          completedCells += 1;
          return runner()(cell, currentPlan);
        },
        ...clocks(),
      },
    });
    expect(completedCells).toBe(matrixPlan.cells.length - 1);
    expect(finalCell.results.at(-1)).toMatchObject({ failure: "identity_observation_failed" });
  });

  it("rejects reused sessions and stale campaign dates", async () => {
    const reused = await runFrozenFrontierMatrix({
      repoRoot: await tempRoot(),
      outputDir: "reused",
      plan: plan(),
      deps: {
        evidenceSource: "test_fixture",
        readIdentity: async () => identity,
        runCell: runner((cell) => {
          const value = JSON.parse(envelope(cell.mode));
          value.sessionId = "shared-session";
          return { envelope: value };
        }),
        ...clocks(),
      },
    });
    expect(reused.results[1]).toMatchObject({ failure: "session_reused", passed: false });
    expect(reused.summary.comparability.reasons).toContain("non_task_failure:session_reused");

    let wall = Date.parse("2026-08-08T23:00:00.000Z");
    let mono = 0;
    const stale = await runFrozenFrontierMatrix({
      repoRoot: await tempRoot(),
      outputDir: "stale-date",
      plan: plan(),
      deps: {
        evidenceSource: "test_fixture",
        readIdentity: async () => identity,
        runCell: runner(),
        wallNow: () => {
          wall += 1_000;
          return new Date(wall);
        },
        monotonicNow: () => {
          mono += 125;
          return mono;
        },
      },
    });
    expect(stale.results[0]).toMatchObject({ failure: "runner_clock_invalid" });

    const backwardTimes = [
      new Date("2026-08-09T00:00:02.000Z"),
      new Date("2026-08-09T00:00:01.000Z"),
    ];
    const backward = await runFrozenFrontierMatrix({
      repoRoot: await tempRoot(),
      outputDir: "backward-clock",
      plan: plan(),
      deps: {
        evidenceSource: "test_fixture",
        readIdentity: async () => identity,
        runCell: runner(),
        ...clocks(),
        wallNow: () => backwardTimes.shift()!,
      },
    });
    expect(backward.results[0]).toMatchObject({ failure: "runner_clock_invalid" });

    wall = Date.parse("2026-08-09T23:59:58.000Z");
    mono = 0;
    const crossing = await runFrozenFrontierMatrix({
      repoRoot: await tempRoot(),
      outputDir: "midnight",
      plan: plan(),
      deps: {
        evidenceSource: "test_fixture",
        readIdentity: async () => identity,
        runCell: runner(),
        wallNow: () => {
          wall += 1_000;
          return new Date(wall);
        },
        monotonicNow: () => {
          mono += 125;
          return mono;
        },
      },
    });
    expect(crossing.results.every((entry) => entry.passed)).toBe(true);
    expect(crossing.results[1]!.auditBundle!.execution.startedAtUtc.slice(0, 10)).toBe(
      "2026-08-10",
    );
  });

  it("blocks a valid-trace infrastructure failure in the final cell", async () => {
    const matrixPlan = plan();
    const result = await runFrozenFrontierMatrix({
      repoRoot: await tempRoot(),
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        evidenceSource: "production",
        readIdentity: async () => identity,
        runCell: runner((cell) =>
          cell.sequence === matrixPlan.cells.length ? { outcome: "infrastructure" } : {},
        ),
        ...clocks(),
      },
    });

    expect(result.results.at(-1)).toMatchObject({
      failure: "infrastructure_failed",
      passed: false,
    });
    expect(result.summary).toMatchObject({
      evidenceValid: false,
      betaEligible: false,
      comparability: {
        reasons: expect.arrayContaining(["non_task_failure:infrastructure_failed"]),
      },
    });
  });

  it("blocks prompt-token regression even when total tokens fall", async () => {
    const matrixPlan = plan();
    const result = await runFrozenFrontierMatrix({
      repoRoot: await tempRoot(),
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        evidenceSource: "production",
        readIdentity: async () => identity,
        runCell: runner((cell) => ({
          envelope:
            cell.mode === "code"
              ? envelope("code", "ok", { input: 100, output: 0, total: 110 })
              : envelope("direct"),
        })),
        ...clocks(),
      },
    });

    expect(result.summary).toMatchObject({
      betaEligible: false,
      direct: { totals: { inputTokens: 360, totalTokens: 520 } },
      code: { totals: { inputTokens: 400, totalTokens: 440 } },
      bars: {
        fewerTokens: true,
        inputTokensNonRegression: false,
      },
    });
  });

  it.each([
    ["provider", "provider", "anthropic"],
    ["model", "model", "gpt-wrong"],
  ] as const)("binds %s identity to the trace route", async (_label, field, mismatch) => {
    const matrixPlan = plan();
    const value = JSON.parse(envelope("direct")) as Record<string, unknown>;
    value[field] = mismatch;
    const result = await runFrozenFrontierMatrix({
      repoRoot: await tempRoot(),
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        evidenceSource: "test_fixture",
        readIdentity: async () => identity,
        runCell: runner(() => ({ envelope: JSON.stringify(value) })),
        ...clocks(),
      },
    });

    expect(result.results[0]).toMatchObject({
      failure: "trace_route_mismatch",
      passed: false,
    });
    expect(result.results.slice(1).every((entry) => entry.failure === "not_run")).toBe(true);
  });

  it.each([
    ["oracle task failure", "ok", false, "task_failed", 8],
    ["agent task error", "task", true, "task_error", 8],
    ["infrastructure", "infrastructure", true, "infrastructure_failed", 1],
    ["timeout", "timeout", true, "timeout", 1],
    ["cleanup", "cleanup", true, "cleanup_failed", 1],
  ] as const)("keeps %s independent", async (_label, outcome, oracle, failure, expectedCalls) => {
    const repoRoot = await tempRoot();
    const matrixPlan = plan();
    let calls = 0;
    const result = await runFrozenFrontierMatrix({
      repoRoot,
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        evidenceSource: "test_fixture",
        readIdentity: async () => identity,
        runCell: runner(() => {
          calls += 1;
          return calls === 1 ? { outcome, oracle } : {};
        }),
        ...clocks(),
      },
    });

    expect(calls).toBe(expectedCalls);
    expect(result.results[0]).toMatchObject({ failure, passed: false });
  });

  it("rejects equal task-failure rates from Beta eligibility", async () => {
    const matrixPlan = plan();
    const result = await runFrozenFrontierMatrix({
      repoRoot: await tempRoot(),
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        evidenceSource: "production",
        readIdentity: async () => identity,
        runCell: runner((cell) => ({
          oracle: cell.repetition !== 1,
        })),
        ...clocks(),
      },
    });

    expect(result.summary).toMatchObject({
      evidenceValid: true,
      betaEligible: false,
      direct: { passed: 2 },
      code: { passed: 2 },
      bars: {
        allTasksPassed: false,
        accuracyNonRegression: true,
      },
    });
  });

  it.each([
    [
      "provider retry",
      (proof: FrontierExecutionProof) => {
        proof.providerRetry.status = "declared_unverified";
      },
      "provider_retry_policy_unverified",
    ],
    [
      "encrypted recovery",
      (proof: FrontierExecutionProof) => {
        proof.encryptedPayloadRecovery = { status: "mandatory", maxRecoveries: 1 };
      },
      "mandatory_encrypted_payload_recovery",
    ],
    [
      "transport retry",
      (proof: FrontierExecutionProof) => {
        proof.transportRetry = { status: "unknown", maxRetries: null };
      },
      "transport_retry_policy_unknown",
    ],
    [
      "warm/cold",
      (proof: FrontierExecutionProof) => {
        proof.warmCold.transportReuse = "unobserved";
      },
      "transport_warm_cold_state_unobserved",
    ],
  ] as const)("blocks %s before runCell", async (_label, mutate, blocker) => {
    const proof = structuredClone(comparableProof);
    mutate(proof);
    const matrixPlan = plan(proof);
    const repoRoot = await tempRoot();
    let calls = 0;
    const result = await runFrozenFrontierMatrix({
      repoRoot,
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        readIdentity: async () => identity,
        runCell: async () => {
          calls += 1;
          throw new Error("must not run");
        },
      },
    });

    expect(calls).toBe(0);
    expect(result.results).toHaveLength(matrixPlan.cells.length);
    expect(result.results.every((entry) => entry.failure === "not_run")).toBe(true);
    expect(result.summary.comparability.reasons).toContain(blocker);
  });
});
