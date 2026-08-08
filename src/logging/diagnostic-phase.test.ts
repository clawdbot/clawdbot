// Diagnostic phase tests cover phase timing and diagnostic event emission.
import { describe, expect, it, vi } from "vitest";
import {
  getCurrentDiagnosticPhase,
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

  it("filters completed phases by attribution time without discarding retained history", async () => {
    resetDiagnosticPhasesForTest();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      await withDiagnosticPhase("phase-a", () => undefined);

      expect(getRecentDiagnosticPhases(1, { completedAfter: 1_001 })).toEqual([]);
      expect(getRecentDiagnosticPhases(1)).toEqual([
        expect.objectContaining({ name: "phase-a", endedAt: 1_000 }),
      ]);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not apply completed-phase recency filtering to active phases", async () => {
    resetDiagnosticPhasesForTest();
    let releasePhase: (() => void) | undefined;
    const phase = withDiagnosticPhase(
      "legitimate.long-running-work",
      () =>
        new Promise<void>((resolve) => {
          releasePhase = resolve;
        }),
    );
    if (!releasePhase) {
      throw new Error("Expected diagnostic phase release callback to be initialized");
    }

    try {
      expect(getRecentDiagnosticPhases(1, { completedAfter: Date.now() })).toEqual([]);
      expect(getCurrentDiagnosticPhase()).toBe("legitimate.long-running-work");
    } finally {
      releasePhase();
      await phase;
    }
  });
});
