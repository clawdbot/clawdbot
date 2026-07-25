// Qa Lab tests cover token efficiency report plugin behavior.
import { describe, expect, it } from "vitest";
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
    cells: { openclaw, codex },
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
