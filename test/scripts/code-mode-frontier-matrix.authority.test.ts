import { afterEach, describe, expect, it } from "vitest";
import { sealFrontierResult } from "../../scripts/lib/code-mode-frontier-matrix-artifacts.js";
import {
  buildFrontierAuditBundle,
  buildFrontierExecution,
} from "../../scripts/lib/code-mode-frontier-matrix-evidence.js";
import {
  frozenFrontierMatrixTesting,
  runFrozenFrontierMatrix,
  verifyFrontierAuditBundle,
  verifyFrozenFrontierMatrixPlan,
} from "../../scripts/lib/code-mode-frontier-matrix.js";
import {
  normalizeAgentExecTrace,
  verifyAgentExecTrace,
} from "../../src/commands/agent-exec-trace.js";
import {
  cleanupFrontierTempRoots,
  frontierClocks as clocks,
  frontierEnvelope as envelope,
  frontierIdentity as identity,
  frontierPlan as plan,
  frontierRunner as runner,
  frontierTempRoot as tempRoot,
  frontierTrace as trace,
} from "./code-mode-frontier-matrix.fixtures.js";

afterEach(async () => {
  await cleanupFrontierTempRoots();
});

function sparseArray(): unknown[] {
  const value: unknown[] = [];
  value.length = 1;
  return value;
}

describe("v2 envelope authority", () => {
  it("uses public v2 normalize/verify and source/projection paths after persistence", () => {
    const parsed = JSON.parse(envelope("code"));
    const persisted = JSON.stringify(parsed.trace);
    const normalized = normalizeAgentExecTrace(persisted);

    expect(verifyAgentExecTrace(persisted)).toBe(true);
    expect(normalized).toMatchObject({
      schemaVersion: 2,
      source: {
        kind: "agent_exec_source_facts",
        mode: { configured: true, engaged: true },
        route: { provider: "openai", model: "gpt-test", api: "responses" },
        invocationReceipt: { complete: true, truncated: false, incompleteReasons: [] },
      },
      projection: {
        metrics: {
          effectiveTurns: { state: "exact", value: 2 },
          underlyingTotalCalls: { state: "exact" },
        },
      },
      audit: { state: "valid" },
    });
    expect(frozenFrontierMatrixTesting.normalizeEnvelope(envelope("code"))).toBeDefined();
  });

  it.each([
    ["trace-only typed object", () => trace("direct")],
    [
      "v1",
      () => {
        const value = JSON.parse(envelope("direct"));
        value.trace.schemaVersion = 1;
        return JSON.stringify(value);
      },
    ],
    [
      "synthetic caller metrics",
      () => {
        const value = JSON.parse(envelope("direct"));
        value.metrics = { effectiveTurns: 1 };
        return JSON.stringify(value);
      },
    ],
    [
      "incomplete trace",
      () => {
        const value = JSON.parse(envelope("direct"));
        value.trace.audit = {
          state: "inconclusive",
          reasons: ["transport_terminal_unverified"],
        };
        return JSON.stringify(value);
      },
    ],
  ])("rejects %s", (_label, build) => {
    expect(frozenFrontierMatrixTesting.normalizeEnvelope(build())).toBeUndefined();
  });

  it.each([
    ["undefined", (value: Record<string, unknown>) => (value.usage = { bad: undefined })],
    ["function", (value: Record<string, unknown>) => (value.usage = { bad: () => 1 })],
    ["symbol", (value: Record<string, unknown>) => (value.usage = { [Symbol("bad")]: 1 })],
    ["bigint", (value: Record<string, unknown>) => (value.usage = { bad: 1n })],
    ["NaN", (value: Record<string, unknown>) => (value.usage = { bad: Number.NaN })],
    ["Infinity", (value: Record<string, unknown>) => (value.usage = { bad: Infinity })],
    ["sparse array", (value: Record<string, unknown>) => (value.payloads = sparseArray())],
    ["proxy", (value: Record<string, unknown>) => (value.usage = new Proxy({}, {}))],
    [
      "accessor",
      (value: Record<string, unknown>) => {
        Object.defineProperty(value, "usage", { enumerable: true, get: () => ({}) });
      },
    ],
    ["exotic object", (value: Record<string, unknown>) => (value.usage = new Date(0))],
    [
      "cycle",
      (value: Record<string, unknown>) => {
        value.usage = value;
      },
    ],
  ])("rejects hostile non-JSON input: %s", (_label, mutate) => {
    const value = JSON.parse(envelope("direct")) as Record<string, unknown>;
    mutate(value);
    expect(frozenFrontierMatrixTesting.normalizeEnvelope(value)).toBeUndefined();
  });

  it("revalidates parsed JSON string depth", () => {
    const value = JSON.parse(envelope("direct")) as Record<string, unknown>;
    let nested: Record<string, unknown> = {};
    value.usage = nested;
    for (let index = 0; index < 40; index += 1) {
      nested.next = {};
      nested = nested.next as Record<string, unknown>;
    }
    expect(frozenFrontierMatrixTesting.normalizeEnvelope(JSON.stringify(value))).toBeUndefined();
  });
});

describe("artifact safety", () => {
  it.each([
    [{ nested: { rawPayload: "x" } }, "rawPayload"],
    [{ nested: { authorization: "Bearer test" } }, "authorization"],
    [{ nested: { value: ["sk", "test-secret-value"].join("-") } }, "sensitive text"],
    [Object.defineProperty({}, "value", { enumerable: true, get: () => "x" }), "accessor"],
    [{ nested: Object.assign(Object.create(null), { secret: "x" }) }, "secret"],
    [{ nested: new Proxy({}, {}) }, "proxy"],
    [{ nested: sparseArray() }, "key bounds"],
    [{ nested: Number.NaN }, "non-JSON"],
    [{ nested: undefined }, "non-JSON"],
    [{ nested: () => "x" }, "non-JSON"],
    [{ nested: 1n }, "non-JSON"],
  ])("rejects unsafe recursive artifact %#", (value, message) => {
    expect(() => frozenFrontierMatrixTesting.assertSafeArtifact(value)).toThrow(message);
  });

  it("uses bytewise canonical hashing", () => {
    expect(
      frozenFrontierMatrixTesting.digestJson({
        z: 1,
        nested: { b: true, a: ["x", { d: 4, c: 3 }] },
      }),
    ).toBe(
      frozenFrontierMatrixTesting.digestJson({
        nested: { a: ["x", { c: 3, d: 4 }], b: true },
        z: 1,
      }),
    );
  });
});

describe("artifact authenticity", () => {
  it("rejects invalid calendar dates and identity observation timeouts", () => {
    const invalidRunDate = structuredClone(plan());
    invalidRunDate.runDate = "2026-02-30";
    expect(verifyFrozenFrontierMatrixPlan(invalidRunDate)).toBe(false);

    const invalidIdentityTimeout = structuredClone(plan());
    invalidIdentityTimeout.execution.identityObservationTimeoutMs = 0;
    expect(verifyFrozenFrontierMatrixPlan(invalidIdentityTimeout)).toBe(false);
  });

  it("rejects task identity tamper before calling the model", async () => {
    const matrixPlan = plan();
    matrixPlan.cells[0]!.taskSha256 = "0".repeat(64);
    let calls = 0;

    await expect(
      runFrozenFrontierMatrix({
        repoRoot: await tempRoot(),
        outputDir: "evidence",
        plan: matrixPlan,
        deps: {
          readIdentity: async () => identity,
          runCell: async () => {
            calls += 1;
            throw new Error("must not run");
          },
        },
      }),
    ).rejects.toThrow("plan identity is invalid");
    expect(calls).toBe(0);
  });

  it("rejects resealed cross-cell swaps, reused sessions, and incomplete schedules", async () => {
    const matrixPlan = plan();
    const result = await runFrozenFrontierMatrix({
      repoRoot: await tempRoot(),
      outputDir: "evidence",
      plan: matrixPlan,
      deps: {
        evidenceSource: "test_fixture",
        readIdentity: async () => identity,
        runCell: runner(),
        ...clocks(),
      },
    });
    expect(
      frozenFrontierMatrixTesting.verifyResultSequence(matrixPlan, result.results, "test_fixture"),
    ).toBe(true);

    const tamperedBundle = structuredClone(result.results[0]!.auditBundle!);
    tamperedBundle.oracle.passed = false;
    tamperedBundle.verdict = { failure: "task_failed", passed: false };
    const { bundleSha256: _oldBundleSha256, ...fieldDigests } = tamperedBundle.digests;
    const { digests: _oldDigests, ...contents } = tamperedBundle;
    tamperedBundle.digests.bundleSha256 = frozenFrontierMatrixTesting.digestEvidence(
      "frontier.audit-bundle.v2",
      { contents, fieldDigests },
    );
    expect(verifyFrontierAuditBundle(tamperedBundle, matrixPlan)).toBe(false);

    const swappedDigests = structuredClone(result.results[0]!.auditBundle!);
    [swappedDigests.digests.envelopeOutcomeSha256, swappedDigests.digests.oracleResultSha256] = [
      swappedDigests.digests.oracleResultSha256,
      swappedDigests.digests.envelopeOutcomeSha256,
    ];
    expect(verifyFrontierAuditBundle(swappedDigests, matrixPlan)).toBe(false);

    const crossCellSwap = structuredClone(result.results);
    crossCellSwap[0]!.auditBundle = structuredClone(crossCellSwap[1]!.auditBundle!);
    const { resultSha256: _crossCellSha256, ...crossCellContents } = crossCellSwap[0]!;
    crossCellSwap[0]!.resultSha256 = frozenFrontierMatrixTesting.digestEvidence(
      "frontier.cell-result.v2",
      crossCellContents,
    );
    expect(
      frozenFrontierMatrixTesting.verifyResultSequence(matrixPlan, crossCellSwap, "test_fixture"),
    ).toBe(false);

    const sessionFieldSwap = structuredClone(result.results[1]!.auditBundle!);
    sessionFieldSwap.envelope.sessionSha256 =
      result.results[0]!.auditBundle!.envelope.sessionSha256;
    expect(verifyFrontierAuditBundle(sessionFieldSwap, matrixPlan)).toBe(false);

    const reusedSession = structuredClone(result.results);
    const reusedSource = reusedSession[1]!.auditBundle!;
    const sessionSha256 = reusedSession[0]!.auditBundle!.execution.sessionSha256;
    const execution = buildFrontierExecution({
      cell: matrixPlan.cells[1]!,
      evidenceSource: reusedSource.execution.evidenceSource,
      endedAtUtc: reusedSource.execution.endedAtUtc,
      observed: reusedSource.execution.observed,
      plan: matrixPlan,
      sessionSha256,
      source: reusedSource.execution.source,
      startedAtUtc: reusedSource.execution.startedAtUtc,
      wallLatencyMs: reusedSource.execution.wallLatencyMs,
    });
    const auditBundle = buildFrontierAuditBundle({
      cell: matrixPlan.cells[1]!,
      envelope: { ...reusedSource.envelope, sessionSha256 },
      execution,
      failure: reusedSource.verdict.failure,
      oracle: { passed: reusedSource.oracle.passed },
      plan: matrixPlan,
      trace: reusedSource.trace,
    });
    reusedSession[1] = sealFrontierResult({
      cellId: matrixPlan.cells[1]!.id,
      taskId: matrixPlan.cells[1]!.taskId,
      taskIndex: matrixPlan.cells[1]!.taskIndex,
      taskSha256: matrixPlan.cells[1]!.taskSha256,
      slot: matrixPlan.cells[1]!.slot,
      mode: matrixPlan.cells[1]!.mode,
      repetition: matrixPlan.cells[1]!.repetition,
      sequence: matrixPlan.cells[1]!.sequence,
      stateKey: matrixPlan.cells[1]!.stateKey,
      failure: auditBundle.verdict.failure,
      passed: auditBundle.verdict.passed,
      auditBundle,
    });
    expect(verifyFrontierAuditBundle(auditBundle, matrixPlan)).toBe(true);
    expect(
      frozenFrontierMatrixTesting.verifyResultSequence(matrixPlan, reusedSession, "test_fixture"),
    ).toBe(false);

    expect(
      frozenFrontierMatrixTesting.verifyResultSequence(
        matrixPlan,
        result.results.slice(0, -1),
        "test_fixture",
      ),
    ).toBe(false);
    const duplicated = structuredClone(result.results);
    duplicated[duplicated.length - 1] = structuredClone(duplicated.at(-2)!);
    expect(
      frozenFrontierMatrixTesting.verifyResultSequence(matrixPlan, duplicated, "test_fixture"),
    ).toBe(false);
    const lastMismatch = structuredClone(result.results);
    lastMismatch.at(-1)!.cellId = matrixPlan.cells[0]!.id;
    expect(
      frozenFrontierMatrixTesting.verifyResultSequence(matrixPlan, lastMismatch, "test_fixture"),
    ).toBe(false);

    const sourceMismatch = structuredClone(result.results);
    const sourceBundle = sourceMismatch[0]!.auditBundle!;
    sourceBundle.execution.evidenceSource = "production";
    sourceBundle.digests.executionReceiptSha256 = frozenFrontierMatrixTesting.digestEvidence(
      "frontier.execution-receipt.v2",
      sourceBundle.execution,
    );
    const { bundleSha256: _sourceBundleSha256, ...sourceFieldDigests } = sourceBundle.digests;
    const { digests: _sourceDigests, ...sourceContents } = sourceBundle;
    sourceBundle.digests.bundleSha256 = frozenFrontierMatrixTesting.digestEvidence(
      "frontier.audit-bundle.v2",
      { contents: sourceContents, fieldDigests: sourceFieldDigests },
    );
    const { resultSha256: _sourceResultSha256, ...sourceResultContents } = sourceMismatch[0]!;
    sourceMismatch[0]!.resultSha256 = frozenFrontierMatrixTesting.digestEvidence(
      "frontier.cell-result.v2",
      sourceResultContents,
    );
    expect(
      frozenFrontierMatrixTesting.verifyResultSequence(matrixPlan, sourceMismatch, "test_fixture"),
    ).toBe(false);
  });
});
