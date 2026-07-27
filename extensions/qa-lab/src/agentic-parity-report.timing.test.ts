import { describe, expect, it } from "vitest";
import { makeRuntimeParitySummary } from "./agentic-parity-report-test-helpers.js";
import { buildQaRuntimeParityReport } from "./agentic-parity-report.js";

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
});
