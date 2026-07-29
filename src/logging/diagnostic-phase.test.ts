// Diagnostic phase tests cover phase timing and diagnostic event emission.
import { describe, expect, it } from "vitest";
import {
  getRecentDiagnosticPhases,
  resetDiagnosticPhasesForTest,
  withDiagnosticPhase,
} from "./diagnostic-phase.js";

describe("getRecentDiagnosticPhases", () => {
  it("returns an empty list for zero, negative, and non-finite limits", async () => {
    resetDiagnosticPhasesForTest();
    await withDiagnosticPhase("phase-a", () => undefined);
    await withDiagnosticPhase("phase-b", () => undefined);

    expect(getRecentDiagnosticPhases(0)).toEqual([]);
    expect(getRecentDiagnosticPhases(-1)).toEqual([]);
    expect(getRecentDiagnosticPhases(Number.NaN)).toEqual([]);
    expect(getRecentDiagnosticPhases(Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it("returns the most recent phases for positive limits", async () => {
    resetDiagnosticPhasesForTest();
    await withDiagnosticPhase("phase-a", () => undefined);
    await withDiagnosticPhase("phase-b", () => undefined);

    const recent = getRecentDiagnosticPhases(1);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.name).toBe("phase-b");
  });
});
