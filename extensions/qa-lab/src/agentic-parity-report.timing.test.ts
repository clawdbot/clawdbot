import { describe, expect, it } from "vitest";
import { makeRuntimeParitySummary } from "./agentic-parity-report-test-helpers.js";
import {
  buildQaRuntimeParityReport,
  renderQaRuntimeParityMarkdownReport,
} from "./agentic-parity-report.js";
import {
  measureRuntimeParityCellTiming,
  summarizeRuntimeParityTiming,
} from "./runtime-parity-timing.js";

describe("qa runtime parity timing reporting", () => {
  it("excludes gateway bootstrap from measured runtime execution", () => {
    expect(
      measureRuntimeParityCellTiming({
        suiteStartedAt: new Date("2026-07-27T12:00:00.000Z"),
        scenarioStartedAt: new Date("2026-07-27T12:00:12.000Z"),
        scenarioFinishedAt: new Date("2026-07-27T12:00:15.500Z"),
      }),
    ).toEqual({ wallClockMs: 3_500, bootstrapWallClockMs: 12_000 });
  });

  it("keeps minimum turn timing without inventing negative bootstrap", () => {
    const startedAt = new Date("2026-07-27T12:00:00.000Z");
    expect(
      measureRuntimeParityCellTiming({
        suiteStartedAt: startedAt,
        scenarioStartedAt: startedAt,
        scenarioFinishedAt: startedAt,
      }),
    ).toEqual({ wallClockMs: 1, bootstrapWallClockMs: 0 });
  });

  it("excludes failed attempts and retry backoff from both turn and bootstrap timing", () => {
    expect(
      measureRuntimeParityCellTiming({
        suiteStartedAt: new Date("2026-07-27T12:00:00.000Z"),
        bootstrapFinishedAt: new Date("2026-07-27T12:00:12.000Z"),
        scenarioStartedAt: new Date("2026-07-27T12:00:20.000Z"),
        scenarioFinishedAt: new Date("2026-07-27T12:00:22.500Z"),
      }),
    ).toEqual({ wallClockMs: 2_500, bootstrapWallClockMs: 12_000 });
  });

  it("reports gateway bootstrap separately without changing runtime comparisons", () => {
    const summary = makeRuntimeParitySummary();
    for (const scenario of summary.scenarios) {
      if (scenario.runtimeParity) {
        scenario.runtimeParity.cells.openclaw.bootstrapWallClockMs = 4_000;
        scenario.runtimeParity.cells.codex.bootstrapWallClockMs = 12_000;
      }
    }

    const report = buildQaRuntimeParityReport({ summary });

    expect(report.pass).toBe(true);
    expect(report.timing.openclaw.totalWallClockMs).toBe(40);
    expect(report.timing.codex.totalWallClockMs).toBe(37);
    expect(report.timing.bootstrap).toEqual({
      openclaw: { totalWallClockMs: 8_000, p50WallClockMs: 4_000, p90WallClockMs: 4_000 },
      codex: { totalWallClockMs: 24_000, p50WallClockMs: 12_000, p90WallClockMs: 12_000 },
    });
    expect(report.scenarios[0]).toMatchObject({
      openclawWallClockMs: 20,
      codexWallClockMs: 18,
      openclawBootstrapWallClockMs: 4_000,
      codexBootstrapWallClockMs: 12_000,
      fasterRuntime: "codex",
    });
    const markdown = renderQaRuntimeParityMarkdownReport(report);
    expect(markdown).toContain("## Gateway Bootstrap (Excluded From Runtime Timing)");
    expect(markdown).toContain("| openclaw | 8000 ms | 4000 ms | 4000 ms |");
    expect(markdown).toContain("| codex | 24000 ms | 12000 ms | 12000 ms |");
    expect(markdown).toContain("- gateway bootstrap (excluded): openclaw 4000 ms; codex 12000 ms");
  });

  it("reports when OpenClaw is faster without changing the parity verdict", () => {
    const summary = makeRuntimeParitySummary();
    for (const scenario of summary.scenarios) {
      if (scenario.runtimeParity) {
        scenario.runtimeParity.cells.codex.wallClockMs = 30;
      }
    }
    const report = buildQaRuntimeParityReport({ summary });
    expect(report.pass).toBe(true);
    expect(report.timing.fasterRuntime).toBe("openclaw");
    expect(report.timing.speedupPercent).toBeCloseTo(50);
    expect(report.scenarios[0]).toMatchObject({
      openclawWallClockMs: 20,
      codexWallClockMs: 30,
      fasterRuntime: "openclaw",
    });
    expect(report.scenarios[0]?.speedupPercent).toBeCloseTo(50);
  });

  it("does not report an infinite speedup for a zero-duration runtime", () => {
    const summary = makeRuntimeParitySummary();
    for (const scenario of summary.scenarios) {
      if (scenario.runtimeParity) {
        scenario.runtimeParity.cells.openclaw.wallClockMs = 0;
      }
    }
    const report = buildQaRuntimeParityReport({ summary });
    expect(report.timing.fasterRuntime).toBe("openclaw");
    expect(report.timing.speedupPercent).toBeNull();
    expect(report.scenarios[0]).toMatchObject({
      fasterRuntime: "openclaw",
      speedupPercent: null,
    });
  });

  it("compares only paired captures while retaining independently measured totals", () => {
    const timing = summarizeRuntimeParityTiming([
      { openclawWallClockMs: 20, codexWallClockMs: 30 },
      { openclawWallClockMs: 1_000, codexWallClockMs: null },
    ]);

    expect(timing.openclaw.totalWallClockMs).toBe(1_020);
    expect(timing.codex.totalWallClockMs).toBe(30);
    expect(timing.fasterRuntime).toBe("openclaw");
    expect(timing.speedupPercent).toBeCloseTo(50);
  });

  it("does not compare independently measured totals without a complete pair", () => {
    const timing = summarizeRuntimeParityTiming([
      { openclawWallClockMs: 20, codexWallClockMs: null },
      { openclawWallClockMs: null, codexWallClockMs: 30 },
    ]);

    expect(timing.openclaw.totalWallClockMs).toBe(20);
    expect(timing.codex.totalWallClockMs).toBe(30);
    expect(timing.fasterRuntime).toBeNull();
    expect(timing.speedupPercent).toBeNull();
  });
});
