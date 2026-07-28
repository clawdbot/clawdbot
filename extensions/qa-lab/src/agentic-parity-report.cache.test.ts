import { describe, expect, it } from "vitest";
import { makeRuntimeParitySummary } from "./agentic-parity-report-test-helpers.js";
import {
  buildQaRuntimeParityReport,
  renderQaRuntimeParityMarkdownReport,
} from "./agentic-parity-report.js";

function makeMeasuredRuntimeParitySummary() {
  const summary = makeRuntimeParitySummary();
  for (const scenario of summary.scenarios) {
    if (scenario.runtimeParity) {
      for (const cell of Object.values(scenario.runtimeParity.cells)) {
        cell.usage = { ...cell.usage, cacheRead: 0, cacheWrite: 0 };
      }
    }
  }
  return summary;
}

describe("qa runtime parity prompt-cache reporting", () => {
  it("reports cached, uncached, and cache-write input without counting output as cacheable", () => {
    const summary = makeMeasuredRuntimeParitySummary();
    const scenario = summary.scenarios[0];
    if (!scenario?.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    scenario.runtimeParity.cells.openclaw.usage = {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 85,
      cacheRead: 60,
      cacheWrite: 10,
    };
    scenario.runtimeParity.cells.codex.usage = {
      inputTokens: 8,
      outputTokens: 4,
      totalTokens: 20,
      cacheRead: 8,
      cacheWrite: 0,
    };

    const report = buildQaRuntimeParityReport({ summary });

    expect(report.scenarios[0]?.openclawUsage).toEqual({
      totalTokens: 85,
      inputTokens: 10,
      outputTokens: 5,
      grossInputTokens: 80,
      uncachedInputTokens: 20,
      cachedInputTokens: 60,
      cacheWriteTokens: 10,
      cacheHitPercent: 75,
    });
    expect(report.scenarios[0]?.codexUsage).toEqual({
      totalTokens: 20,
      inputTokens: 8,
      outputTokens: 4,
      grossInputTokens: 16,
      uncachedInputTokens: 8,
      cachedInputTokens: 8,
      cacheWriteTokens: 0,
      cacheHitPercent: 50,
    });
    expect(report.usage.openclaw).toMatchObject({
      totalTokens: 100,
      grossInputTokens: 90,
      uncachedInputTokens: 30,
      cachedInputTokens: 60,
      cacheWriteTokens: 10,
    });
    expect(report.usage.openclaw?.cacheHitPercent).toBeCloseTo((60 / 90) * 100);
    expect(report.usage.codex).toMatchObject({
      totalTokens: 33,
      grossInputTokens: 25,
      uncachedInputTokens: 17,
      cachedInputTokens: 8,
      cacheWriteTokens: 0,
      cacheHitPercent: 32,
    });
    const markdown = renderQaRuntimeParityMarkdownReport(report);
    expect(markdown).toContain("## Prompt Cache");
    expect(markdown).toContain("| openclaw | 90 | 30 | 60 | 10 | 10 | 100 | 66.7% |");
    expect(markdown).toContain("| codex | 25 | 17 | 8 | 0 | 8 | 33 | 32.0% |");
    expect(markdown).toContain(
      "prompt cache: openclaw 75.0% (60 cached, 20 uncached input); codex 50.0% (8 cached, 8 uncached input)",
    );
  });

  it("computes aggregate cache hits from measured input rather than averaging percentages", () => {
    const summary = makeMeasuredRuntimeParitySummary();
    const [first, second] = summary.scenarios;
    if (!first?.runtimeParity || !second?.runtimeParity) {
      throw new Error("runtime parity fixtures missing");
    }
    first.runtimeParity.cells.openclaw.usage = {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 85,
      cacheRead: 60,
      cacheWrite: 10,
    };
    second.runtimeParity.cells.openclaw.usage = {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 115,
      cacheRead: 100,
      cacheWrite: 0,
    };

    const report = buildQaRuntimeParityReport({ summary });
    expect(report.usage.openclaw).toMatchObject({
      totalTokens: 200,
      grossInputTokens: 190,
      uncachedInputTokens: 30,
      cachedInputTokens: 160,
      cacheWriteTokens: 10,
    });
    expect(report.usage.openclaw?.cacheHitPercent).toBeCloseTo((160 / 190) * 100);
  });

  it("reports unavailable runtime captures as N/A instead of fabricated zero-token usage", () => {
    const report = buildQaRuntimeParityReport({
      summary: {
        scenarios: [{ name: "Missing runtime capture", status: "fail" }],
        counts: { total: 1, passed: 0, failed: 1 },
        run: { providerMode: "live-frontier", runtimePair: ["openclaw", "codex"] },
      },
    });
    expect(report.usage).toEqual({ openclaw: null, codex: null });
    expect(report.scenarios[0]).toMatchObject({ openclawUsage: null, codexUsage: null });
    const markdown = renderQaRuntimeParityMarkdownReport(report);
    expect(markdown).toContain("| openclaw | N/A | N/A | N/A | N/A | N/A | N/A | N/A |");
    expect(markdown).toContain("| codex | N/A | N/A | N/A | N/A | N/A | N/A | N/A |");
  });

  it("keeps missing cache telemetry unknown while preserving measured token totals", () => {
    const report = buildQaRuntimeParityReport({ summary: makeRuntimeParitySummary() });
    expect(report.scenarios[0]?.openclawUsage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      grossInputTokens: null,
      uncachedInputTokens: null,
      cachedInputTokens: null,
      cacheWriteTokens: null,
      cacheHitPercent: null,
    });
    expect(report.usage.openclaw).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      grossInputTokens: null,
      uncachedInputTokens: null,
      cachedInputTokens: null,
      cacheWriteTokens: null,
      cacheHitPercent: null,
    });
    expect(renderQaRuntimeParityMarkdownReport(report)).toContain(
      "| openclaw | N/A | N/A | N/A | N/A | 10 | 30 | N/A |",
    );
  });

  it("excludes unknown cache captures from the weighted cache-hit denominator", () => {
    const summary = makeRuntimeParitySummary();
    const first = summary.scenarios[0];
    if (!first?.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    first.runtimeParity.cells.openclaw.usage = {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 85,
      cacheRead: 60,
      cacheWrite: 10,
    };
    const report = buildQaRuntimeParityReport({ summary });
    expect(report.usage.openclaw).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 100,
      grossInputTokens: 80,
      uncachedInputTokens: 20,
      cachedInputTokens: 60,
      cacheWriteTokens: 10,
      cacheHitPercent: 75,
    });
  });

  it("distinguishes a measured zero cache hit from missing cache telemetry", () => {
    const report = buildQaRuntimeParityReport({ summary: makeMeasuredRuntimeParitySummary() });
    expect(report.usage.openclaw).toMatchObject({
      inputTokens: 20,
      grossInputTokens: 20,
      uncachedInputTokens: 20,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      cacheHitPercent: 0,
    });
    expect(renderQaRuntimeParityMarkdownReport(report)).toContain(
      "| openclaw | 20 | 20 | 0 | 0 | 10 | 30 | 0.0% |",
    );
  });

  it("reports measured zero-input cache hits as unavailable rather than infinity", () => {
    const summary = makeMeasuredRuntimeParitySummary();
    for (const scenario of summary.scenarios) {
      if (scenario.runtimeParity) {
        scenario.runtimeParity.cells.openclaw.usage = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }
    }
    const report = buildQaRuntimeParityReport({ summary });
    expect(report.usage.openclaw).toMatchObject({
      grossInputTokens: 0,
      cachedInputTokens: 0,
      cacheHitPercent: null,
    });
    expect(renderQaRuntimeParityMarkdownReport(report)).toContain(
      "| openclaw | 0 | 0 | 0 | 0 | 0 | 0 | N/A |",
    );
  });
});
