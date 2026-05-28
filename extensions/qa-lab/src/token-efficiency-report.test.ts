import { describe, expect, it } from "vitest";
import type {
  RuntimeId,
  RuntimeParityCell,
  RuntimeParityResult,
  RuntimeParityToolCall,
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
): RuntimeParityResult {
  return {
    scenarioId,
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
