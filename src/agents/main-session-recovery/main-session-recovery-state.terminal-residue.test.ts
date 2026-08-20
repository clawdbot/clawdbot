import { describe, expect, it } from "vitest";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../../config/sessions.js";
import { transitionMainSessionRecovery } from "./main-session-recovery-state.js";

// Regression coverage for #118873: a terminal-only mainRestartRecovery
// aggregate (every recorded run has a terminal fact; no reservation,
// foreground claim, or tombstone) must retire at foreground admission
// instead of blocking the session forever with "changed while starting work".

const sessionKey = "agent:main:main";

function recoveryState(
  overrides: Partial<MainRestartRecoveryState> = {},
): MainRestartRecoveryState {
  return {
    cycleId: "cycle-1",
    revision: 1,
    chargedAttempts: 0,
    ...overrides,
  };
}

function settledEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 100,
    status: "running",
    abortedLastRun: false,
    mainRestartRecovery: recoveryState(),
    restartRecoveryRuns: [{ runId: "settled-run", lifecycleGeneration: "dead-generation" }],
    restartRecoveryTerminalRunIds: ["settled-run"],
    ...overrides,
  };
}

function claimForeground(entry: SessionEntry) {
  return transitionMainSessionRecovery(entry, {
    kind: "claim_foreground",
    cycleId: "unused",
    lifecycleGeneration: "generation-1",
    sessionId: "session-1",
    sessionKey,
    claimId: "foreground-1",
  });
}

describe("main session recovery terminal-only residue", () => {
  it("retires a terminal-only aggregate before healthy foreground admission", () => {
    const entry = settledEntry({
      restartRecoveryRuns: [
        { runId: "settled-run-1", lifecycleGeneration: "dead-generation-1" },
        { runId: "settled-run-2", lifecycleGeneration: "dead-generation-2" },
      ],
      restartRecoveryTerminalRunIds: ["settled-run-1", "settled-run-2"],
    });

    expect(claimForeground(entry)).toEqual({ kind: "applied" });
    expect(entry).toMatchObject({ status: "running", abortedLastRun: false });
    expect(entry.restartRecoveryRuns).toBeUndefined();
    expect(entry.mainRestartRecovery).toBeUndefined();
  });

  it("keeps the aggregate when any run still lacks a terminal fact", () => {
    const entry = settledEntry({
      restartRecoveryRuns: [
        { runId: "settled-run", lifecycleGeneration: "dead-generation" },
        { runId: "live-run", lifecycleGeneration: "generation-1" },
      ],
    });

    expect(claimForeground(entry)).toEqual({ kind: "no_change" });
    expect(entry.mainRestartRecovery).toBeDefined();
    expect(entry.restartRecoveryRuns).toHaveLength(2);
  });

  it("keeps the aggregate while a reservation still owns work", () => {
    const entry = settledEntry({
      mainRestartRecovery: recoveryState({
        reservation: { lifecycleGeneration: "generation-1", runId: "reserved-run", attempt: 1 },
      }),
    });

    expect(claimForeground(entry)).toEqual({ kind: "no_change" });
    expect(entry.mainRestartRecovery?.reservation).toBeDefined();
  });

  it("keeps the aggregate while a foreground claim still owns work", () => {
    const entry = settledEntry({
      mainRestartRecovery: recoveryState({
        foregroundClaims: { lifecycleGeneration: "generation-1", tokens: ["existing-claim"] },
      }),
    });

    expect(claimForeground(entry)).toEqual({ kind: "no_change" });
    expect(entry.mainRestartRecovery?.foregroundClaims).toBeDefined();
  });

  it("keeps the aggregate while a delivery claim is still recorded", () => {
    const entry = settledEntry({ restartRecoveryDeliveryRunId: "pending-delivery" });

    expect(claimForeground(entry)).toEqual({ kind: "no_change" });
    expect(entry.mainRestartRecovery).toBeDefined();
    expect(entry.restartRecoveryDeliveryRunId).toBe("pending-delivery");
  });

  it("retires terminal-only residue durably at the observe scan", () => {
    const entry = settledEntry();

    const result = transitionMainSessionRecovery(entry, {
      kind: "observe",
      cycleId: "unused-cycle",
      lifecycleGeneration: "generation-1",
      sessionKey,
    });

    expect(result).toMatchObject({ kind: "observed", view: { status: "inactive" } });
    expect(entry.mainRestartRecovery).toBeUndefined();
    expect(entry.restartRecoveryRuns).toBeUndefined();
  });

  it("does not block standalone inspect admission on terminal-only residue", () => {
    const entry = settledEntry();

    const result = transitionMainSessionRecovery(entry, {
      kind: "inspect",
      lifecycleGeneration: "standalone-generation",
      sessionKey,
    });

    expect(result).toMatchObject({ kind: "observed", view: { status: "inactive" } });
  });

  it("keeps blocking standalone inspect admission on a live recovery fence", () => {
    const entry = settledEntry({
      restartRecoveryRuns: [
        { runId: "settled-run", lifecycleGeneration: "dead-generation" },
        { runId: "live-run", lifecycleGeneration: "generation-1" },
      ],
    });

    const result = transitionMainSessionRecovery(entry, {
      kind: "inspect",
      lifecycleGeneration: "standalone-generation",
      sessionKey,
    });

    expect(result).toMatchObject({ kind: "observed", view: { status: "blocked" } });
  });
});
