import { describe, expect, it } from "vitest";
import { makeRuntimeParitySummary } from "./agentic-parity-report-test-helpers.js";
import { buildQaRuntimeParityReport } from "./agentic-parity-report.js";
import { summarizeRuntimeParityTiming } from "./runtime-parity-timing.js";

describe("qa runtime parity timing reporting", () => {
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
