import { describe, expect, it } from "vitest";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../config/sessions.js";
import { buildMainSessionRecoveryClearPatch } from "./main-session-recovery-clear.js";
import {
  inspectMainSessionRecoveryHealth,
  projectMainSessionRecoveryLifecycle,
} from "./main-session-recovery-lifecycle.js";
import { transitionMainSessionRecovery } from "./main-session-recovery-state.js";

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

function interruptedEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 100,
    status: "running",
    abortedLastRun: true,
    mainRestartRecovery: recoveryState(),
    ...overrides,
  };
}

function observe(entry: SessionEntry, lifecycleGeneration: string) {
  const result = transitionMainSessionRecovery(entry, {
    kind: "observe",
    cycleId: "unused-cycle",
    lifecycleGeneration,
    sessionKey,
  });
  if (result.kind !== "observed") {
    throw new Error("expected recovery observation");
  }
  return result.view;
}

describe("main session recovery state", () => {
  it("gives a legacy interrupted row a stable cycle before exposing it to a scan", () => {
    const entry = interruptedEntry({ mainRestartRecovery: undefined });

    const observed = transitionMainSessionRecovery(entry, {
      kind: "observe",
      cycleId: "legacy-cycle",
      lifecycleGeneration: "generation-1",
      sessionKey,
    });

    expect(observed).toEqual({
      kind: "observed",
      view: {
        status: "recoverable",
        observation: { sessionId: "session-1", cycleId: "legacy-cycle", revision: 1 },
        nextAttempt: 1,
      },
    });
    expect(entry.mainRestartRecovery).toEqual(recoveryState({ cycleId: "legacy-cycle" }));
  });

  it("inspects a live reservation without adopting or releasing it", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({
        chargedAttempts: 1,
        reservation: {
          attempt: 1,
          lifecycleGeneration: "gateway-generation",
          runId: "recovery-1",
        },
      }),
    });
    const before = structuredClone(entry);

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "inspect",
        lifecycleGeneration: "standalone-generation",
        sessionKey,
      }),
    ).toEqual({ kind: "observed", view: { status: "blocked" } });
    expect(entry).toEqual(before);
  });

  it("marks without charging and preserves generation-scoped lifecycle fences", () => {
    const entry = interruptedEntry({
      restartRecoveryRuns: [
        { runId: "older-run", lifecycleGeneration: "generation-old" },
        { runId: "shared-run", lifecycleGeneration: "generation-1" },
      ],
      mainRestartRecovery: recoveryState({
        revision: 4,
        chargedAttempts: 2,
      }),
    });

    transitionMainSessionRecovery(entry, {
      kind: "mark_interrupted",
      cycleId: "unused-cycle",
      now: 200,
      runs: [
        { runId: "shared-run", lifecycleGeneration: "generation-2" },
        { runId: "new-run", lifecycleGeneration: "generation-2" },
      ],
    });

    expect(entry.mainRestartRecovery).toEqual(
      recoveryState({
        revision: 4,
        chargedAttempts: 2,
      }),
    );
    expect(entry.restartRecoveryRuns).toEqual([
      { runId: "new-run", lifecycleGeneration: "generation-2" },
      { runId: "older-run", lifecycleGeneration: "generation-old" },
      { runId: "shared-run", lifecycleGeneration: "generation-1" },
      { runId: "shared-run", lifecycleGeneration: "generation-2" },
    ]);
  });

  it("charges at reservation and refunds only the matching reservation", () => {
    const entry = interruptedEntry();
    const prepared = transitionMainSessionRecovery(entry, {
      kind: "prepare_attempt",
      attempt: 1,
      lifecycleGeneration: "generation-1",
      now: 200,
      observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
      runId: "recovery-1",
    });
    expect(prepared.kind).toBe("reserved");
    if (prepared.kind !== "reserved") {
      throw new Error("expected reservation");
    }

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "prepare_attempt",
        attempt: 1,
        lifecycleGeneration: "generation-1",
        now: 201,
        observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
        runId: "recovery-2",
      }),
    ).toEqual({ kind: "rejected", reason: "stale_revision" });
    expect(entry.mainRestartRecovery?.reservation).toMatchObject({
      runId: "recovery-1",
      attempt: 1,
    });

    const claim = transitionMainSessionRecovery(entry, {
      kind: "claim_foreground",
      cycleId: "unused",
      lifecycleGeneration: "generation-1",
      sessionId: "session-1",
      sessionKey,
      claimId: "foreground-1",
    });
    expect(claim.kind).toBe("foreground_claimed");

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "cancel_reservation",
        reservation: prepared.reservation,
      }),
    ).toEqual({ kind: "applied" });
    expect(entry.mainRestartRecovery).toMatchObject({
      chargedAttempts: 0,
      foregroundClaims: {
        lifecycleGeneration: "generation-1",
        tokens: ["foreground-1"],
      },
    });
    expect(entry.mainRestartRecovery?.reservation).toBeUndefined();
    expect(observe(entry, "generation-1")).toEqual({ status: "blocked" });
  });

  it("rejects foreground work after the automatic recovery budget is exhausted", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({ chargedAttempts: 3 }),
    });
    const before = structuredClone(entry);

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "claim_foreground",
        cycleId: "unused",
        lifecycleGeneration: "generation-1",
        sessionId: "session-1",
        sessionKey,
        claimId: "foreground-1",
      }),
    ).toEqual({ kind: "rejected", reason: "recovery_exhausted" });
    expect(entry).toEqual(before);
  });

  it("clears orphaned lifecycle fences before healthy foreground admission", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      mainRestartRecovery: undefined,
      restartRecoveryRuns: [{ runId: "stale-run", lifecycleGeneration: "stale-generation" }],
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "claim_foreground",
        cycleId: "unused",
        lifecycleGeneration: "generation-1",
        sessionId: "session-1",
        sessionKey,
        claimId: "foreground-1",
      }),
    ).toEqual({ kind: "applied" });
    expect(entry).toMatchObject({
      status: "running",
      abortedLastRun: false,
    });
    expect(entry.restartRecoveryRuns).toBeUndefined();
    expect(entry.mainRestartRecovery).toBeUndefined();
  });

  it("keeps lifecycle fences while a recovery delivery owner remains", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      mainRestartRecovery: undefined,
      restartRecoveryDeliveryRunId: "active-recovery",
      restartRecoveryRuns: [{ runId: "active-recovery", lifecycleGeneration: "generation-1" }],
    });
    const before = structuredClone(entry);

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "claim_foreground",
        cycleId: "unused",
        lifecycleGeneration: "generation-1",
        sessionId: "session-1",
        sessionKey,
        claimId: "foreground-1",
      }),
    ).toEqual({ kind: "no_change" });
    expect(entry).toEqual(before);
  });

  it("retires a stale reservation before granting foreground ownership", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({
        revision: 3,
        chargedAttempts: 1,
        reservation: {
          attempt: 1,
          lifecycleGeneration: "previous-generation",
          runId: "stale-recovery",
        },
      }),
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "claim_foreground",
        cycleId: "unused",
        lifecycleGeneration: "generation-1",
        sessionId: "session-1",
        sessionKey,
        claimId: "foreground-1",
      }),
    ).toMatchObject({ kind: "foreground_claimed" });
    expect(entry.mainRestartRecovery).toMatchObject({
      chargedAttempts: 1,
      foregroundClaims: {
        lifecycleGeneration: "generation-1",
        tokens: ["foreground-1"],
      },
    });
    expect(entry.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("releases an ambiguous dispatch reservation without refunding its charge", () => {
    const entry = interruptedEntry();
    const prepared = transitionMainSessionRecovery(entry, {
      kind: "prepare_attempt",
      attempt: 1,
      lifecycleGeneration: "generation-1",
      now: 200,
      observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
      runId: "recovery-1",
    });
    if (prepared.kind !== "reserved") {
      throw new Error("expected reservation");
    }

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "abandon_reservation",
        reservation: prepared.reservation,
      }),
    ).toEqual({ kind: "applied" });
    expect(entry.mainRestartRecovery).toMatchObject({ chargedAttempts: 1 });
    expect(entry.mainRestartRecovery?.reservation).toBeUndefined();
    expect(observe(entry, "generation-1")).toMatchObject({
      status: "recoverable",
      nextAttempt: 2,
    });
  });

  it("moves a reservation into the lifecycle fence during Gateway admission", () => {
    const entry = interruptedEntry({
      pendingFinalDelivery: true,
      pendingFinalDeliveryText: " captured reply ",
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "source-1",
      mainRestartRecovery: recoveryState({
        revision: 2,
        chargedAttempts: 1,
        reservation: {
          runId: "recovery-1",
          attempt: 1,
          lifecycleGeneration: "generation-1",
        },
      }),
    });
    expect(
      transitionMainSessionRecovery(entry, {
        kind: "validate_recovery",
        lifecycleGeneration: "generation-1",
        runId: "recovery-1",
        sessionId: "session-1",
      }),
    ).toEqual({ kind: "recovery_validated" });
    expect(entry.mainRestartRecovery?.reservation).toBeDefined();
    expect(entry.abortedLastRun).toBe(true);

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "admit_recovery",
        lifecycleGeneration: "generation-1",
        now: 300,
        runId: "recovery-1",
        sessionId: "session-1",
      }),
    ).toEqual({ kind: "admitted_recovery" });
    expect(entry).toMatchObject({
      abortedLastRun: false,
      pendingFinalDeliveryAttemptCount: 1,
      pendingFinalDeliveryLastAttemptAt: 300,
      restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration: "generation-1" }],
      mainRestartRecovery: {
        revision: 3,
        chargedAttempts: 1,
      },
    });
    expect(entry.mainRestartRecovery?.reservation).toBeUndefined();

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "mark_admitted_recovery_interrupted",
        lifecycleGeneration: "generation-1",
        now: 400,
        runId: "recovery-1",
        sessionId: "session-1",
      }),
    ).toMatchObject({ kind: "applied" });
    expect(entry.mainRestartRecovery?.chargedAttempts).toBe(1);
    expect(entry.mainRestartRecovery?.reservation).toBeUndefined();
    expect(entry.abortedLastRun).toBe(true);
    expect(entry.restartRecoveryDeliveryRunId).toBeUndefined();
    expect(entry.restartRecoveryDeliverySourceRunId).toBe("source-1");
  });

  it("rejects a reservation created by an older lifecycle generation", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({
        revision: 2,
        chargedAttempts: 1,
        reservation: {
          runId: "recovery-1",
          attempt: 1,
          lifecycleGeneration: "generation-old",
        },
      }),
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "admit_recovery",
        lifecycleGeneration: "generation-new",
        now: 300,
        runId: "recovery-1",
        sessionId: "session-1",
      }),
    ).toEqual({ kind: "rejected", reason: "stale_reservation" });
    expect(entry.mainRestartRecovery?.reservation).toBeDefined();
    expect(entry.abortedLastRun).toBe(true);
  });

  it("rejects recovery admission while any current-generation foreground claim remains", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({
        revision: 4,
        chargedAttempts: 1,
        reservation: {
          runId: "recovery-1",
          attempt: 1,
          lifecycleGeneration: "generation-1",
        },
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["foreground-1", "foreground-2"],
        },
      }),
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "admit_recovery",
        lifecycleGeneration: "generation-1",
        now: 300,
        runId: "recovery-1",
        sessionId: "session-1",
      }),
    ).toEqual({ kind: "rejected", reason: "foreground_active" });
    expect(observe(entry, "generation-1")).toEqual({ status: "blocked" });
  });

  it("clears a healthy recovery aggregate when its final foreground owner releases", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration: "generation-1" }],
      mainRestartRecovery: recoveryState({
        revision: 3,
        chargedAttempts: 1,
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["foreground-1"],
        },
      }),
    });
    expect(observe(entry, "generation-1")).toEqual({ status: "blocked" });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "release_foreground",
        claim: {
          cycleId: "cycle-1",
          lifecycleGeneration: "generation-1",
          claimId: "foreground-1",
          sessionId: "session-1",
          sessionKey,
        },
      }),
    ).toEqual({ kind: "applied" });
    expect(entry).toMatchObject({ abortedLastRun: false });
    expect(entry.restartRecoveryRuns).toBeUndefined();
    expect(entry.mainRestartRecovery).toBeUndefined();
  });

  it("expires foreground claims from an older lifecycle generation", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({
        foregroundClaims: {
          lifecycleGeneration: "generation-old",
          tokens: ["old-owner"],
        },
      }),
    });

    const view = observe(entry, "generation-new");

    expect(view).toMatchObject({ status: "recoverable", nextAttempt: 1 });
    expect(entry.mainRestartRecovery).toMatchObject({ revision: 2 });
    expect(entry.mainRestartRecovery?.foregroundClaims).toBeUndefined();
  });

  it("clears a healthy aggregate owned by an older lifecycle generation", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      restartRecoveryRuns: [{ runId: "completed-run", lifecycleGeneration: "generation-old" }],
      mainRestartRecovery: recoveryState({
        foregroundClaims: {
          lifecycleGeneration: "generation-old",
          tokens: ["old-owner"],
        },
      }),
    });

    expect(observe(entry, "generation-new")).toEqual({ status: "inactive" });
    expect(entry.restartRecoveryRuns).toBeUndefined();
    expect(entry.mainRestartRecovery).toBeUndefined();
  });

  it("retains the charge but releases a reservation orphaned by process restart", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({
        revision: 2,
        chargedAttempts: 1,
        reservation: {
          runId: "recovery-1",
          attempt: 1,
          lifecycleGeneration: "generation-old",
        },
      }),
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "observe",
        cycleId: "unused",
        lifecycleGeneration: "generation-new",
        sessionKey,
      }),
    ).toEqual({
      kind: "observed",
      view: {
        status: "recoverable",
        observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 3 },
        nextAttempt: 2,
      },
    });
    expect(entry.mainRestartRecovery).toMatchObject({
      revision: 3,
      chargedAttempts: 1,
    });
    expect(entry.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("rejects an old observation after a healthy clear and a new interrupted cycle", () => {
    const entry = interruptedEntry();
    const oldObservation = { sessionId: "session-1", cycleId: "cycle-1", revision: 1 };
    transitionMainSessionRecovery(entry, { kind: "clear" });
    transitionMainSessionRecovery(entry, {
      kind: "mark_interrupted",
      cycleId: "cycle-2",
      now: 400,
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "prepare_attempt",
        attempt: 1,
        lifecycleGeneration: "generation-1",
        now: 500,
        observation: oldObservation,
        runId: "stale-run",
      }),
    ).toEqual({ kind: "rejected", reason: "stale_cycle" });
  });

  it("preserves the charged cycle when an accepted recovery is interrupted again", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      mainRestartRecovery: recoveryState({
        revision: 3,
        chargedAttempts: 1,
      }),
    });

    transitionMainSessionRecovery(entry, {
      kind: "mark_interrupted",
      cycleId: "replacement-cycle",
      now: 300,
    });

    expect(entry.abortedLastRun).toBe(true);
    expect(entry.mainRestartRecovery).toEqual(
      recoveryState({
        revision: 3,
        chargedAttempts: 1,
      }),
    );
  });

  it("tombstones an exhausted cycle and exposes only the Doctor repair action", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({
        chargedAttempts: 3,
      }),
    });
    const view = observe(entry, "generation-1");
    expect(view.status).toBe("exhausted");
    if (view.status !== "exhausted") {
      throw new Error("expected exhausted cycle");
    }

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "tombstone",
        now: 400,
        observation: view.observation,
        reason: view.reason,
      }),
    ).toEqual({ kind: "tombstoned" });
    expect(inspectMainSessionRecoveryHealth(entry)).toEqual({
      status: "tombstoned",
      reason: view.reason,
      repair: null,
    });
    expect(observe(entry, "generation-1")).toEqual({ status: "tombstoned" });

    entry.abortedLastRun = true;
    expect(inspectMainSessionRecoveryHealth(entry)).toMatchObject({
      status: "tombstoned",
      repair: "clear_stale_abort",
    });
    expect(transitionMainSessionRecovery(entry, { kind: "doctor_repair", now: 500 })).toEqual({
      kind: "doctor_repaired",
    });
    expect(entry.abortedLastRun).toBe(false);
  });

  it("owns lifecycle fence suppression, consumption, and healthy clearing", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "recovery",
      restartRecoveryRuns: [
        { runId: "interrupted", lifecycleGeneration: "generation-1" },
        { runId: "recovery", lifecycleGeneration: "generation-1" },
      ],
    });
    expect(
      projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: "generation-1",
        entry,
        event: {
          runId: "interrupted",
          lifecycleGeneration: "generation-1",
          data: { phase: "error", stopReason: "restart" },
        },
        snapshotPatch: { status: "failed" },
      }),
    ).toEqual({ action: "suppress" });

    expect(
      projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: "generation-1",
        entry,
        event: {
          runId: "recovery",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        snapshotPatch: { status: "done", abortedLastRun: false },
      }),
    ).toEqual({
      action: "apply",
      patch: {
        status: "done",
        abortedLastRun: false,
        restartRecoveryRuns: undefined,
        mainRestartRecovery: undefined,
      },
    });

    expect(
      projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: "generation-1",
        entry,
        event: {
          runId: "recovery",
          lifecycleGeneration: "generation-1",
          data: { phase: "error", error: "provider failed" },
        },
        snapshotPatch: { status: "failed", abortedLastRun: false },
      }),
    ).toEqual({
      action: "apply",
      patch: {
        status: "failed",
        abortedLastRun: false,
        restartRecoveryRuns: undefined,
        mainRestartRecovery: undefined,
      },
    });
  });

  it("does not let a delayed lifecycle event clear current-generation owners", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      restartRecoveryRuns: [{ runId: "old-run", lifecycleGeneration: "generation-1" }],
      restartRecoveryTerminalRunIds: ["prior-run"],
      mainRestartRecovery: recoveryState({
        foregroundClaims: {
          lifecycleGeneration: "generation-2",
          tokens: ["current-owner"],
        },
      }),
    });

    expect(
      projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: "generation-2",
        entry,
        event: {
          runId: "old-run",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        snapshotPatch: { status: "done", abortedLastRun: false },
      }),
    ).toEqual({
      action: "apply",
      patch: {
        restartRecoveryRuns: undefined,
        restartRecoveryTerminalRunIds: ["prior-run", "old-run"],
      },
    });
    expect(entry.mainRestartRecovery?.foregroundClaims?.tokens).toEqual(["current-owner"]);
  });

  it("does not let a delayed lifecycle event clear a current reservation", () => {
    const entry = interruptedEntry({
      restartRecoveryRuns: [{ runId: "old-run", lifecycleGeneration: "generation-1" }],
      mainRestartRecovery: recoveryState({
        chargedAttempts: 1,
        reservation: {
          runId: "current-run",
          attempt: 1,
          lifecycleGeneration: "generation-2",
        },
      }),
    });

    expect(
      projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: "generation-2",
        entry,
        event: {
          runId: "old-run",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        snapshotPatch: { status: "done", abortedLastRun: false },
      }),
    ).toEqual({
      action: "apply",
      patch: {
        restartRecoveryRuns: undefined,
        restartRecoveryTerminalRunIds: ["old-run"],
      },
    });
    expect(entry.mainRestartRecovery?.reservation?.runId).toBe("current-run");
  });

  it("preserves concurrent owners and fences when one lifecycle run completes", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      restartRecoveryRuns: [
        { runId: "recovery-1", lifecycleGeneration: "generation-1" },
        { runId: "recovery-2", lifecycleGeneration: "generation-1" },
      ],
      mainRestartRecovery: recoveryState({
        revision: 4,
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["owner-1", "owner-2"],
        },
      }),
    });

    expect(
      projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: "generation-1",
        entry,
        event: {
          runId: "recovery-1",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        snapshotPatch: {
          status: "done",
          abortedLastRun: false,
          restartRecoveryRuns: undefined,
          mainRestartRecovery: undefined,
        },
      }),
    ).toEqual({
      action: "apply",
      patch: {
        restartRecoveryRuns: [{ runId: "recovery-2", lifecycleGeneration: "generation-1" }],
        restartRecoveryTerminalRunIds: ["recovery-1"],
      },
    });
  });

  it("does not let another terminal run clear the active recovery delivery", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      restartRecoveryDeliveryRunId: "recovery-2",
      restartRecoveryRuns: [
        { runId: "recovery-1", lifecycleGeneration: "generation-1" },
        { runId: "recovery-2", lifecycleGeneration: "generation-1" },
      ],
    });

    expect(
      projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: "generation-1",
        entry,
        event: {
          runId: "recovery-1",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        snapshotPatch: { status: "done", abortedLastRun: false },
      }),
    ).toEqual({
      action: "apply",
      patch: {
        status: "done",
        abortedLastRun: false,
        restartRecoveryRuns: [{ runId: "recovery-2", lifecycleGeneration: "generation-1" }],
        mainRestartRecovery: entry.mainRestartRecovery,
      },
    });
  });

  it("does not let an unrelated lifecycle completion clear pending recovery", () => {
    const entry = interruptedEntry({
      restartRecoveryRuns: [{ runId: "recovery", lifecycleGeneration: "generation-1" }],
    });

    expect(
      projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: "generation-1",
        entry,
        event: {
          runId: "ordinary-run",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        snapshotPatch: {
          status: "done",
          abortedLastRun: false,
          restartRecoveryRuns: undefined,
          mainRestartRecovery: undefined,
        },
      }),
    ).toEqual({ action: "suppress" });
  });

  it("suppresses an unmatched completion while a current foreground owner is active", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      mainRestartRecovery: recoveryState({
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["current-owner"],
        },
      }),
    });

    expect(
      projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: "generation-1",
        entry,
        event: {
          runId: "unrelated-run",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        snapshotPatch: { status: "done", abortedLastRun: false },
      }),
    ).toEqual({ action: "suppress" });
  });

  it("applies ordinary lifecycle completion without recovery metadata", () => {
    expect(
      projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: "generation-1",
        entry: { abortedLastRun: false },
        event: {
          runId: "ordinary-run",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        snapshotPatch: { status: "done", abortedLastRun: false },
      }),
    ).toEqual({
      action: "apply",
      patch: { status: "done", abortedLastRun: false },
    });
  });

  it("does not preserve foreground claims from an older lifecycle generation", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      restartRecoveryRuns: [{ runId: "recovery", lifecycleGeneration: "generation-2" }],
      mainRestartRecovery: recoveryState({
        foregroundClaims: {
          lifecycleGeneration: "generation-1",
          tokens: ["stale-owner"],
        },
      }),
    });

    expect(
      projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: "generation-2",
        entry,
        event: {
          runId: "recovery",
          lifecycleGeneration: "generation-2",
          data: { phase: "end" },
        },
        snapshotPatch: { status: "done", abortedLastRun: false },
      }),
    ).toEqual({
      action: "apply",
      patch: {
        status: "done",
        abortedLastRun: false,
        restartRecoveryRuns: undefined,
        mainRestartRecovery: undefined,
      },
    });
  });

  it("does not let a delayed lifecycle event erase a recovery tombstone", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      status: "failed",
      restartRecoveryRuns: [{ runId: "old-run", lifecycleGeneration: "generation-1" }],
      mainRestartRecovery: recoveryState({
        revision: 4,
        chargedAttempts: 3,
        tombstone: { reason: "automatic recovery exhausted" },
      }),
    });

    expect(
      projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: "generation-1",
        entry,
        event: {
          runId: "old-run",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        snapshotPatch: { status: "done", abortedLastRun: false },
      }),
    ).toEqual({
      action: "apply",
      patch: {
        status: "done",
        abortedLastRun: false,
        restartRecoveryRuns: entry.restartRecoveryRuns,
        mainRestartRecovery: entry.mainRestartRecovery,
      },
    });
  });

  it("builds an empty clear patch when no main recovery state exists", () => {
    expect(buildMainSessionRecoveryClearPatch({ abortedLastRun: false })).toEqual({});
  });
});
