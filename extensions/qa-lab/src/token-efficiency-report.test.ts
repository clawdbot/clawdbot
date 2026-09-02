// Qa Lab tests cover token efficiency report plugin behavior.
import { describe, expect, it } from "vitest";
import { buildRuntimeParityCacheDiagnostics } from "./runtime-parity-cache-diagnostics.js";
import type {
  RuntimeId,
  RuntimeParityCell,
  RuntimeParityResult,
  RuntimeParityToolCall,
  RuntimeParityUsagePolicy,
} from "./runtime-parity.js";
import {
  buildTokenEfficiencyReport,
  renderTokenEfficiencyMarkdownReport,
  type TokenEfficiencySuiteSummary,
} from "./token-efficiency-report.js";

function makeToolCall(tool: string): RuntimeParityToolCall {
  return {
    tool,
    argsHash: `${tool}-args`,
    resultHash: `${tool}-result`,
  };
}

function makeCell(
  runtime: RuntimeId,
  usage: RuntimeParityCell["usage"],
  toolCalls: RuntimeParityToolCall[] = [],
): RuntimeParityCell {
  return {
    runtime,
    transcriptBytes: '{"role":"assistant"}\n',
    toolCalls,
    finalText: "done",
    usage,
    wallClockMs: 10,
    bootStateLines: [],
  };
}

function makeRuntimeParity(
  scenarioId: string,
  openclaw: RuntimeParityCell,
  codex: RuntimeParityCell,
  runtimeParityUsage?: RuntimeParityUsagePolicy,
): RuntimeParityResult {
  return {
    scenarioId,
    ...(runtimeParityUsage ? { runtimeParityUsage } : {}),
    drift: "none",
    cells: {
      openclaw: { ...openclaw, status: "pass" },
      codex: { ...codex, status: "pass" },
    },
  };
}

function makeLiveSummary(runtimeParity: RuntimeParityResult[]): TokenEfficiencySuiteSummary {
  return {
    scenarios: runtimeParity.map((result) => ({
      name: result.scenarioId,
      status: "pass" as const,
      runtimeParity: result,
    })),
    run: {
      providerMode: "live-frontier",
      runtimePair: ["openclaw", "codex"],
    },
  };
}

describe("token efficiency report", () => {
  it("does not fail live reports solely because Codex uses fewer tokens", () => {
    const report = buildTokenEfficiencyReport({
      generatedAt: "2026-05-10T00:00:00.000Z",
      summary: makeLiveSummary([
        makeRuntimeParity(
          "codex-savings",
          makeCell("openclaw", { inputTokens: 120, outputTokens: 80, totalTokens: 200 }),
          makeCell("codex", { inputTokens: 60, outputTokens: 40, totalTokens: 100 }),
        ),
      ]),
    });

    expect(report.pass).toBe(true);
    expect(report.aggregate.flaggedScenarios).toEqual([]);
    expect(report.aggregate.savingsScenarios).toEqual(["codex-savings"]);
    expect(report.rows[0]).toMatchObject({
      deltaPercent: -50,
      classification: "savings",
      flagged: false,
    });
  });

  it("fails live reports on positive Codex token increases over the threshold", () => {
    const report = buildTokenEfficiencyReport({
      generatedAt: "2026-05-10T00:00:00.000Z",
      summary: makeLiveSummary([
        makeRuntimeParity(
          "runtime-tool-fs-read",
          makeCell("openclaw", { inputTokens: 72_000, outputTokens: 381, totalTokens: 72_381 }, [
            makeToolCall("fs.read"),
            makeToolCall("fs.read"),
          ]),
          makeCell(
            "codex",
            { inputTokens: 118_000, outputTokens: 1_489, totalTokens: 119_489 },
            Array.from({ length: 40 }, () => makeToolCall("fs.read")),
          ),
        ),
      ]),
    });

    expect(report.pass).toBe(false);
    expect(report.aggregate.flaggedScenarios).toEqual(["runtime-tool-fs-read"]);
    expect(report.rows[0]).toMatchObject({
      classification: "regression",
      flagged: true,
      toolsUsed: ["fs.read"],
    });
    expect(report.failures).toEqual([
      "runtime-tool-fs-read token delta=+65.1% exceeds 15.0% Codex increase threshold",
    ]);
  });

  it("detects a real cache regression even when cached-inclusive totals hide it", () => {
    const openclaw = makeCell("openclaw", {
      inputTokens: 7_403,
      outputTokens: 220,
      totalTokens: 435_810,
      cacheRead: 415_492,
      cacheWrite: 12_695,
    });
    const codex = makeCell("codex", {
      inputTokens: 25_894,
      outputTokens: 220,
      totalTokens: 495_710,
      cacheRead: 445_189,
      cacheWrite: 24_407,
    });
    codex.cacheDiagnostics = buildRuntimeParityCacheDiagnostics([
      {
        inputTokens: 3,
        outputTokens: 11,
        totalTokens: 24_421,
        cacheRead: 0,
        cacheWrite: 24_407,
      },
      {
        inputTokens: 24_448,
        outputTokens: 11,
        totalTokens: 24_459,
        cacheRead: 0,
        cacheWrite: 0,
      },
    ]);

    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([makeRuntimeParity("first-hour-cache-miss", openclaw, codex)]),
    });

    expect(report.pass).toBe(false);
    expect(report.rows[0]).toMatchObject({
      classification: "regression",
      flagged: true,
      openclaw: { processedTokens: 20_318, cacheReadTokens: 415_492 },
      codex: {
        processedTokens: 50_521,
        cacheReadTokens: 445_189,
        cacheWriteTokens: 24_407,
        cacheMisses: [{ turn: 2, inputTokens: 24_448, cacheRead: 0, cacheWrite: 0 }],
      },
    });
    expect(report.rows[0]?.deltaPercent).toBeGreaterThan(145);
    expect(report.aggregate.codex).toMatchObject({
      processedTokens: 50_521,
      cacheMissCount: 1,
      cacheMissInputTokens: 24_448,
    });
    expect(renderTokenEfficiencyMarkdownReport(report)).toContain("turn 2 (24448 input)");
  });

  it("does not treat additional reused cached input as newly processed work", () => {
    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([
        makeRuntimeParity(
          "different-cache-hit-totals",
          makeCell("openclaw", {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 1_000,
            cacheRead: 880,
            cacheWrite: 0,
          }),
          makeCell("codex", {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 5_000,
            cacheRead: 4_880,
            cacheWrite: 0,
          }),
        ),
      ]),
    });

    expect(report.pass).toBe(true);
    expect(report.rows[0]).toMatchObject({
      deltaPercent: 0,
      classification: "neutral",
      flagged: false,
      openclaw: { processedTokens: 120 },
      codex: { processedTokens: 120 },
    });
  });

  it("counts newly written cache input as genuinely processed work", () => {
    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([
        makeRuntimeParity(
          "cache-write-regression",
          makeCell("openclaw", {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 105,
            cacheRead: 90,
            cacheWrite: 0,
          }),
          makeCell("codex", {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 105,
            cacheRead: 0,
            cacheWrite: 90,
          }),
        ),
      ]),
    });

    expect(report.pass).toBe(false);
    expect(report.rows[0]).toMatchObject({
      classification: "regression",
      flagged: true,
      deltaPercent: 600,
      openclaw: { processedTokens: 15 },
      codex: { processedTokens: 105 },
    });
  });

  it("reports unavailable cache-miss telemetry as unknown rather than zero", () => {
    const openclaw = makeCell("openclaw", {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    const codex = makeCell("codex", {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    for (const cell of [openclaw, codex]) {
      cell.cacheDiagnostics = buildRuntimeParityCacheDiagnostics([cell.usage]);
    }

    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([makeRuntimeParity("unknown-cache-telemetry", openclaw, codex)]),
    });

    expect(report.pass).toBe(true);
    expect(report.rows[0]).toMatchObject({
      openclaw: { cacheReadTokens: null, cacheWriteTokens: null, cacheMisses: null },
      codex: { cacheReadTokens: null, cacheWriteTokens: null, cacheMisses: null },
    });
    expect(report.aggregate.openclaw).toMatchObject({
      cacheMissCount: null,
      cacheMissInputTokens: null,
    });
    expect(report.aggregate.codex).toMatchObject({
      cacheMissCount: null,
      cacheMissInputTokens: null,
    });
    expect(renderTokenEfficiencyMarkdownReport(report)).toContain("| N/A | N/A |");
  });

  it("derives missing cache writes only from coherent measured cache reads", () => {
    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([
        makeRuntimeParity(
          "derived-cache-writes",
          makeCell("openclaw", {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 115,
            cacheRead: 100,
          }),
          makeCell("codex", {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 135,
            cacheRead: 100,
          }),
        ),
      ]),
    });

    expect(report.pass).toBe(false);
    expect(report.rows[0]).toMatchObject({
      classification: "regression",
      flagged: true,
      openclaw: {
        processedTokens: 15,
        processedTokenEvidence: "derived",
        cacheWriteTokens: null,
      },
      codex: {
        processedTokens: 35,
        processedTokenEvidence: "derived",
        cacheWriteTokens: null,
      },
    });
  });

  it("fails live proof when processed tokens cannot be derived from partial cache telemetry", () => {
    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([
        makeRuntimeParity(
          "unverifiable-cache-writes",
          makeCell("openclaw", {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
          }),
          makeCell("codex", {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 1_000,
          }),
        ),
      ]),
    });

    expect(report.pass).toBe(false);
    expect(report.rows[0]).toMatchObject({
      classification: "neutral",
      flagged: false,
      openclaw: { processedTokenEvidence: "derived" },
      codex: { processedTokenEvidence: "unavailable" },
    });
    expect(report.failures).toEqual([
      "unverifiable-cache-writes codex live processed-token usage cannot be verified from cache-write telemetry or coherent cache-read totals",
    ]);
    expect(report.aggregate.codex).toMatchObject({
      processedTokenEvidence: "unavailable",
      p50PerScenario: null,
      p90PerScenario: null,
    });
    expect(renderTokenEfficiencyMarkdownReport(report)).toContain("| delta | N/A |");
    expect(renderTokenEfficiencyMarkdownReport(report)).toContain(
      "| codex | N/A | 1000 | N/A | N/A | N/A | N/A | N/A |",
    );
  });

  it("fails incoherent cache-read totals instead of fabricating derived cache writes", () => {
    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([
        makeRuntimeParity(
          "incoherent-cache-totals",
          makeCell("openclaw", {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
          }),
          makeCell("codex", {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 125,
            cacheRead: 100,
          }),
        ),
      ]),
    });

    expect(report.pass).toBe(false);
    expect(report.rows[0]?.codex).toMatchObject({
      cacheReadTokens: 100,
      cacheWriteTokens: null,
      processedTokenEvidence: "unavailable",
    });
    expect(report.failures).toEqual([
      "incoherent-cache-totals codex live processed-token usage cannot be verified from cache-write telemetry or coherent cache-read totals",
    ]);
  });

  it("fails unexplained totals when both cache counters have already been measured", () => {
    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([
        makeRuntimeParity(
          "unexplained-cache-totals",
          makeCell("openclaw", {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 120,
          }),
          makeCell("codex", {
            inputTokens: 100,
            outputTokens: 20,
            totalTokens: 1_000,
            cacheRead: 100,
            cacheWrite: 0,
          }),
        ),
      ]),
    });

    expect(report.pass).toBe(false);
    expect(report.rows[0]?.codex).toMatchObject({
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
      processedTokenEvidence: "unavailable",
    });
    expect(report.failures).toEqual([
      "unexplained-cache-totals codex live processed-token usage cannot be verified from cache-write telemetry or coherent cache-read totals",
    ]);
  });

  it("does not derive cache writes from partially observed post-warm cache reads", () => {
    const openclaw = makeCell("openclaw", {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    const codex = makeCell("codex", {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 1_120,
      cacheRead: 100,
    });
    codex.cacheDiagnostics = buildRuntimeParityCacheDiagnostics([
      { inputTokens: 3, outputTokens: 11, totalTokens: 114, cacheRead: 100, cacheWrite: 0 },
      { inputTokens: 97, outputTokens: 9, totalTokens: 1_006 },
    ]);

    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([
        makeRuntimeParity("incomplete-cache-read-telemetry", openclaw, codex),
      ]),
    });

    expect(report.pass).toBe(false);
    expect(report.rows[0]?.codex).toMatchObject({
      cacheReadTokens: 100,
      cacheWriteTokens: null,
      processedTokenEvidence: "unavailable",
      unmeasuredPostWarmTurns: [2],
    });
    expect(report.rows[0]).toMatchObject({ classification: "neutral", flagged: false });
    expect(report.failures).toEqual([
      "incomplete-cache-read-telemetry codex live processed-token usage cannot be verified from cache-write telemetry or coherent cache-read totals",
    ]);
  });

  it("does not certify incomplete cache-write telemetry with unaccounted cache input", () => {
    const openclaw = makeCell("openclaw", {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    const codex = makeCell("codex", {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 1_120,
      cacheRead: 100,
      cacheWrite: 200,
    });
    codex.cacheDiagnostics = buildRuntimeParityCacheDiagnostics([
      { inputTokens: 3, outputTokens: 11, totalTokens: 314, cacheRead: 100, cacheWrite: 200 },
      { inputTokens: 97, outputTokens: 9, totalTokens: 806 },
    ]);

    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([
        makeRuntimeParity("incomplete-cache-write-telemetry", openclaw, codex),
      ]),
    });

    expect(report.pass).toBe(false);
    expect(report.rows[0]?.codex).toMatchObject({
      cacheReadTokens: 100,
      cacheWriteTokens: 200,
      processedTokenEvidence: "unavailable",
      unmeasuredPostWarmTurns: [2],
    });
    expect(report.failures).toEqual([
      "incomplete-cache-write-telemetry codex live processed-token usage cannot be verified from cache-write telemetry or coherent cache-read totals",
    ]);
  });

  it("keeps mixed post-warm telemetry unknown without discarding measured misses", () => {
    const openclaw = makeCell("openclaw", {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    const codex = makeCell("codex", {
      inputTokens: 1_053,
      outputTokens: 33,
      totalTokens: 2_086,
      cacheRead: 0,
      cacheWrite: 1_000,
    });
    codex.cacheDiagnostics = buildRuntimeParityCacheDiagnostics([
      { inputTokens: 3, outputTokens: 11, totalTokens: 1_014, cacheRead: 0, cacheWrite: 1_000 },
      { inputTokens: 1_050, outputTokens: 11, totalTokens: 1_061, cacheRead: 0, cacheWrite: 0 },
      { inputTokens: 0, outputTokens: 11, totalTokens: 11 },
    ]);

    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([makeRuntimeParity("mixed-cache-telemetry", openclaw, codex)]),
    });

    expect(report.rows[0]?.codex).toMatchObject({
      cacheMisses: [{ turn: 2, inputTokens: 1_050, cacheRead: 0, cacheWrite: 0 }],
      unmeasuredPostWarmTurns: [3],
    });
    expect(report.aggregate.codex).toMatchObject({
      cacheMissCount: null,
      cacheMissInputTokens: null,
    });
    expect(renderTokenEfficiencyMarkdownReport(report)).toContain(
      "turn 2 (1050 input); unmeasured turns 3",
    );
  });

  it("preserves unmeasured warm turns when only partial cache telemetry is available", () => {
    const openclaw = makeCell("openclaw", {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    const codex = makeCell("codex", {
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
    });
    codex.cacheDiagnostics = buildRuntimeParityCacheDiagnostics([
      { inputTokens: 3, outputTokens: 11, totalTokens: 1_014, cacheWrite: 1_000 },
      { inputTokens: 100, outputTokens: 11, totalTokens: 111 },
    ]);

    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([makeRuntimeParity("partial-warm-telemetry", openclaw, codex)]),
    });

    expect(report.pass).toBe(true);
    expect(report.rows[0]?.codex).toMatchObject({
      cacheMisses: null,
      unmeasuredPostWarmTurns: [2],
    });
    expect(report.aggregate.codex).toMatchObject({
      cacheMissCount: null,
      cacheMissInputTokens: null,
    });
    expect(renderTokenEfficiencyMarkdownReport(report)).toContain("N/A (unmeasured turns 2)");
  });

  it("keeps live zero-usage rows failing instead of passing as neutral", () => {
    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([
        makeRuntimeParity(
          "missing-live-usage",
          makeCell("openclaw", { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
          makeCell("codex", { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
        ),
      ]),
    });

    expect(report.pass).toBe(false);
    expect(report.failures).toEqual([
      "missing-live-usage openclaw live usage totalTokens=0",
      "missing-live-usage codex live usage totalTokens=0",
    ]);
  });

  it("excludes explicit non-assistant scenarios from live usage aggregates", () => {
    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([
        makeRuntimeParity(
          "usage-applicable",
          makeCell("openclaw", { inputTokens: 80, outputTokens: 20, totalTokens: 100 }),
          makeCell("codex", { inputTokens: 85, outputTokens: 20, totalTokens: 105 }),
        ),
        makeRuntimeParity(
          "local-fixture",
          makeCell("openclaw", { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
          makeCell("codex", { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
          {
            expectation: "not-applicable",
            reason: "Local fixture only; no assistant turn runs.",
          },
        ),
      ]),
    });

    expect(report.pass).toBe(true);
    expect(report.rows.map((row) => row.scenarioId)).toEqual(["usage-applicable"]);
    expect(report.aggregate.openclaw.totalTokens).toBe(100);
    expect(report.aggregate.codex.totalTokens).toBe(105);
    expect(report.notApplicableScenarios).toEqual([
      {
        scenarioId: "local-fixture",
        reason: "Local fixture only; no assistant turn runs.",
      },
    ]);
    expect(renderTokenEfficiencyMarkdownReport(report)).toContain(
      "- local-fixture: Local fixture only; no assistant turn runs.",
    );
  });

  it("fails live reports with only usage-not-applicable captures", () => {
    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([
        makeRuntimeParity(
          "local-fixture",
          makeCell("openclaw", { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
          makeCell("codex", { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
          {
            expectation: "not-applicable",
            reason: "Local fixture only; no assistant turn runs.",
          },
        ),
      ]),
    });

    expect(report.status).toBe("evaluated");
    expect(report.pass).toBe(false);
    expect(report.rows).toEqual([]);
    expect(report.failures).toEqual([
      "No usage-applicable runtime parity captures were present in the suite summary.",
    ]);
    expect(renderTokenEfficiencyMarkdownReport(report)).toContain("- Verdict: fail");
  });

  it("fails live reports with non-integer token usage evidence", () => {
    const report = buildTokenEfficiencyReport({
      summary: makeLiveSummary([
        makeRuntimeParity(
          "fractional-live-usage",
          makeCell("openclaw", { inputTokens: 100.5, outputTokens: 0, totalTokens: 100.5 }),
          makeCell("codex", { inputTokens: 101, outputTokens: 0, totalTokens: 101 }),
        ),
      ]),
    });

    expect(report.pass).toBe(false);
    expect(report.failures).toEqual([
      "fractional-live-usage openclaw live usage inputTokens must be a non-negative integer",
      "fractional-live-usage openclaw live usage totalTokens must be a non-negative integer",
    ]);
  });

  it("fails empty live runtime summaries instead of treating them as skipped proof", () => {
    const report = buildTokenEfficiencyReport({
      generatedAt: "2026-05-10T00:00:00.000Z",
      summary: makeLiveSummary([]),
    });

    expect(report.status).toBe("evaluated");
    expect(report.pass).toBe(false);
    expect(report.failures).toEqual([
      "No runtime parity captures were present in the suite summary.",
    ]);
    expect(report.rows).toEqual([]);
    expect(report.skipReason).toBeUndefined();
    expect(renderTokenEfficiencyMarkdownReport(report)).toContain("- Verdict: fail");
  });

  it("keeps empty mock runtime summaries skipped as non-live estimates", () => {
    const report = buildTokenEfficiencyReport({
      summary: {
        scenarios: [],
        run: {
          providerMode: "mock-openai",
          runtimePair: ["openclaw", "codex"],
        },
      },
    });

    expect(report.status).toBe("skipped");
    expect(report.pass).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it("labels mock-estimated Codex increases as regressions without failing the live gate", () => {
    const report = buildTokenEfficiencyReport({
      summary: {
        scenarios: [
          {
            name: "mock-regression",
            status: "pass",
            runtimeParity: makeRuntimeParity(
              "mock-regression",
              makeCell("openclaw", { inputTokens: 100, outputTokens: 0, totalTokens: 100 }),
              makeCell("codex", { inputTokens: 130, outputTokens: 0, totalTokens: 130 }),
            ),
          },
        ],
        run: {
          providerMode: "mock-openai",
          runtimePair: ["openclaw", "codex"],
        },
      },
    });

    expect(report.status).toBe("estimated");
    expect(report.pass).toBe(true);
    expect(report.aggregate.flaggedScenarios).toEqual([]);
    expect(report.rows[0]).toMatchObject({
      usageSource: "mock-estimate",
      classification: "regression",
      flagged: false,
    });
  });

  it("renders savings and regression classifications in the markdown report", () => {
    const report = buildTokenEfficiencyReport({
      generatedAt: "2026-05-10T00:00:00.000Z",
      summary: makeLiveSummary([
        makeRuntimeParity(
          "codex-savings",
          makeCell("openclaw", { inputTokens: 100, outputTokens: 100, totalTokens: 200 }),
          makeCell("codex", { inputTokens: 50, outputTokens: 50, totalTokens: 100 }),
        ),
        makeRuntimeParity(
          "codex-regression",
          makeCell("openclaw", { inputTokens: 100, outputTokens: 0, totalTokens: 100 }),
          makeCell("codex", { inputTokens: 130, outputTokens: 0, totalTokens: 130 }),
        ),
      ]),
    });

    const markdown = renderTokenEfficiencyMarkdownReport(report);
    expect(markdown).toContain("p50 per scenario");
    expect(markdown).toContain("| codex-savings | live-usage |");
    expect(markdown).toContain("| -50.0% | savings | no |");
    expect(markdown).toContain("| codex-regression | live-usage |");
    expect(markdown).toContain("| +30.0% | regression | yes |");
  });
});
