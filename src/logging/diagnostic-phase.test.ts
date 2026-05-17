import { describe, expect, it } from "vitest";
import {
  getRecentDiagnosticPhases,
  recordDiagnosticPhase,
  resetDiagnosticPhasesForTest,
} from "./diagnostic-phase.js";

describe("getRecentDiagnosticPhases", () => {
  it("returns an empty list for zero, negative, and non-finite limits", () => {
    resetDiagnosticPhasesForTest();
    recordDiagnosticPhase({
      name: "phase-a",
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      cpuUserMs: 0,
      cpuSystemMs: 0,
      cpuTotalMs: 0,
      cpuCoreRatio: 0,
    });
    recordDiagnosticPhase({
      name: "phase-b",
      startedAt: 3,
      endedAt: 4,
      durationMs: 1,
      cpuUserMs: 0,
      cpuSystemMs: 0,
      cpuTotalMs: 0,
      cpuCoreRatio: 0,
    });

    expect(getRecentDiagnosticPhases(0)).toEqual([]);
    expect(getRecentDiagnosticPhases(-1)).toEqual([]);
    expect(getRecentDiagnosticPhases(Number.NaN)).toEqual([]);
    expect(getRecentDiagnosticPhases(Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("returns the most recent phases for positive limits", () => {
    resetDiagnosticPhasesForTest();
    recordDiagnosticPhase({
      name: "phase-a",
      startedAt: 1,
      endedAt: 2,
      durationMs: 1,
      cpuUserMs: 0,
      cpuSystemMs: 0,
      cpuTotalMs: 0,
      cpuCoreRatio: 0,
    });
    recordDiagnosticPhase({
      name: "phase-b",
      startedAt: 3,
      endedAt: 4,
      durationMs: 1,
      cpuUserMs: 0,
      cpuSystemMs: 0,
      cpuTotalMs: 0,
      cpuCoreRatio: 0,
    });

    const recent = getRecentDiagnosticPhases(1);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.name).toBe("phase-b");
  });
});
