import { describe, expect, it } from "vitest";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../../config/sessions.js";
import { buildMainSessionRecoveryClearPatch } from "./main-session-recovery-clear.js";
import { projectMainSessionRecoveryLifecycle } from "./main-session-recovery-lifecycle.js";
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

function claimForeground(
  entry: SessionEntry,
  overrides: Partial<{
    claimId: string;
    cycleId: string;
    lifecycleGeneration: string;
    sessionId: string;
    sessionKey: string;
  }> = {},
) {
  return transitionMainSessionRecovery(entry, {
    kind: "claim_foreground",
    cycleId: "unused",
    lifecycleGeneration: "generation-1",
    sessionId: "session-1",
    sessionKey,
    claimId: "foreground-1",
    ...overrides,
  });
}

type LifecycleProjectionParams = Parameters<typeof projectMainSessionRecoveryLifecycle>[0];

function projectLifecycle(
  entry: LifecycleProjectionParams["entry"],
  event: LifecycleProjectionParams["event"],
  snapshotPatch: LifecycleProjectionParams["snapshotPatch"],
  currentLifecycleGeneration = event.lifecycleGeneration,
) {
  if (!currentLifecycleGeneration) {
    throw new Error("expected lifecycle generation");
  }
  return projectMainSessionRecoveryLifecycle({
    currentLifecycleGeneration,
    entry,
    event,
    snapshotPatch,
  });
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

  it("marks without charging and replaces an older lifecycle owner for the same run", () => {
    const entry = interruptedEntry({
      lifecycleRunId: "dead-run",
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
      { runId: "shared-run", lifecycleGeneration: "generation-2" },
    ]);
    expect(entry.lifecycleRunId).toBeUndefined();
  });

  it("rejects foreground work after the automatic recovery budget is exhausted", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({ chargedAttempts: 3 }),
    });
    const before = structuredClone(entry);

    expect(claimForeground(entry)).toEqual({ kind: "rejected", reason: "recovery_exhausted" });
    expect(entry).toEqual(before);
  });

  it("clears orphaned lifecycle fences before healthy foreground admission", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      mainRestartRecovery: undefined,
      restartRecoveryRuns: [{ runId: "stale-run", lifecycleGeneration: "stale-generation" }],
    });

    expect(claimForeground(entry)).toEqual({ kind: "applied" });
    expect(entry).toMatchObject({
      status: "running",
      abortedLastRun: false,
    });
    expect(entry.restartRecoveryRuns).toBeUndefined();
    expect(entry.mainRestartRecovery).toBeUndefined();
  });

  it("clears orphaned recovery residue when the row never recorded a status", () => {
    // Production shape (2026-07-26): fences from two dead gateway generations on
    // a row whose status was never persisted, so it matched no cleanup branch.
    const entry = interruptedEntry({
      status: undefined,
      abortedLastRun: false,
      mainRestartRecovery: undefined,
      restartRecoveryRuns: [
        { runId: "stale-run-1", lifecycleGeneration: "dead-generation-1" },
        { runId: "stale-run-2", lifecycleGeneration: "dead-generation-2" },
      ],
    });

    expect(claimForeground(entry)).toEqual({ kind: "applied" });
    expect(entry.restartRecoveryRuns).toBeUndefined();
    expect(entry.mainRestartRecovery).toBeUndefined();
    expect(entry.abortedLastRun).toBe(false);
  });

  it("clears orphaned recovery residue before terminal foreground admission", () => {
    const entry = interruptedEntry({
      status: "failed",
      mainRestartRecovery: undefined,
      restartRecoveryRuns: [{ runId: "stale-run", lifecycleGeneration: "dead-generation" }],
    });

    expect(claimForeground(entry)).toEqual({ kind: "applied" });
    expect(entry).toMatchObject({ status: "failed", abortedLastRun: false });
    expect(entry.restartRecoveryRuns).toBeUndefined();
    expect(entry.mainRestartRecovery).toBeUndefined();
    expect(entry.restartRecoveryDeliveryRunId).toBeUndefined();
  });

  it("clears terminal residue while a delivery claim is still recorded", () => {
    const entry = interruptedEntry({
      status: "failed",
      abortedLastRun: true,
      mainRestartRecovery: undefined,
      restartRecoveryRuns: undefined,
      restartRecoveryDeliveryRunId: "pending-delivery",
    });

    expect(claimForeground(entry)).toEqual({ kind: "applied" });
    expect(entry.abortedLastRun).toBe(false);
    expect(entry.mainRestartRecovery).toBeUndefined();
    // The delivery claim is owned by the delivery path, not recovery cleanup.
    expect(entry.restartRecoveryDeliveryRunId).toBe("pending-delivery");
  });

  it("keeps interrupted running recovery residue authoritative", () => {
    const entry = interruptedEntry({
      mainRestartRecovery: undefined,
      restartRecoveryRuns: [{ runId: "pending-run", lifecycleGeneration: "generation-1" }],
    });

    expect(claimForeground(entry, { cycleId: "cycle-2" })).toMatchObject({
      kind: "foreground_claimed",
    });
    expect(entry.abortedLastRun).toBe(true);
    expect(entry.restartRecoveryRuns).toEqual([
      { runId: "pending-run", lifecycleGeneration: "generation-1" },
    ]);
    expect(entry.mainRestartRecovery).toMatchObject({
      cycleId: "cycle-2",
      foregroundClaims: {
        lifecycleGeneration: "generation-1",
        tokens: ["foreground-1"],
      },
    });
  });

  it("keeps lifecycle fences while a recovery delivery owner remains", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      mainRestartRecovery: undefined,
      restartRecoveryDeliveryRunId: "active-recovery",
      restartRecoveryRuns: [{ runId: "active-recovery", lifecycleGeneration: "generation-1" }],
    });
    const before = structuredClone(entry);

    expect(claimForeground(entry)).toEqual({ kind: "no_change" });
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

    expect(claimForeground(entry)).toMatchObject({ kind: "foreground_claimed" });
    expect(entry.mainRestartRecovery).toMatchObject({
      chargedAttempts: 1,
      foregroundClaims: {
        lifecycleGeneration: "generation-1",
        tokens: ["foreground-1"],
      },
    });
    expect(entry.mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("moves a reservation into the lifecycle fence during Gateway admission", () => {
    const entry = interruptedEntry({
      pendingFinalDelivery: { kind: "replayable", text: " captured reply ", createdAt: 1 },
      restartRecoveryDeliveryRunId: "recovery-1",
      restartRecoveryDeliverySourceRunId: "source-1",
      restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration: "generation-old" }],
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
      pendingFinalDelivery: { kind: "replayable", text: "captured reply", createdAt: 1 },
      restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration: "generation-1" }],
      mainRestartRecovery: {
        revision: 3,
        chargedAttempts: 1,
      },
    });
    expect(entry.mainRestartRecovery?.reservation).toBeUndefined();
    expect(entry.lifecycleRunId).toBe("recovery-1");

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
    expect(entry.lifecycleRunId).toBeUndefined();
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
        executionIdentity: { state: "disabled" },
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
      lifecycleRunId: "exhausted-run",
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
    expect(entry.mainRestartRecovery?.tombstone?.reason).toBe(view.reason);
    expect(entry.lifecycleRunId).toBeUndefined();
    expect(observe(entry, "generation-1")).toEqual({ status: "tombstoned" });

    entry.abortedLastRun = true;
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
      projectLifecycle(
        entry,
        {
          runId: "interrupted",
          lifecycleGeneration: "generation-1",
          data: { phase: "error", stopReason: "restart" },
        },
        { status: "failed" },
      ),
    ).toEqual({ action: "suppress" });

    expect(
      projectLifecycle(
        entry,
        {
          runId: "recovery",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        { status: "done", abortedLastRun: false },
      ),
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
      projectLifecycle(
        entry,
        {
          runId: "recovery",
          lifecycleGeneration: "generation-1",
          data: { phase: "error", error: "provider failed" },
        },
        { status: "failed", abortedLastRun: false },
      ),
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
      projectLifecycle(
        entry,
        {
          runId: "old-run",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        { status: "done", abortedLastRun: false },
        "generation-2",
      ),
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
      projectLifecycle(
        entry,
        {
          runId: "old-run",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        { status: "done", abortedLastRun: false },
        "generation-2",
      ),
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
      projectLifecycle(
        entry,
        {
          runId: "recovery-1",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        {
          status: "done",
          abortedLastRun: false,
          restartRecoveryRuns: undefined,
          mainRestartRecovery: undefined,
        },
      ),
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
      projectLifecycle(
        entry,
        {
          runId: "recovery-1",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        { status: "done", abortedLastRun: false },
      ),
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
      projectLifecycle(
        entry,
        {
          runId: "ordinary-run",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        {
          status: "done",
          abortedLastRun: false,
          restartRecoveryRuns: undefined,
          mainRestartRecovery: undefined,
        },
      ),
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
      projectLifecycle(
        entry,
        {
          runId: "unrelated-run",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        { status: "done", abortedLastRun: false },
      ),
    ).toEqual({ action: "suppress" });
  });

  it("applies ordinary lifecycle completion without recovery metadata", () => {
    expect(
      projectLifecycle(
        { abortedLastRun: false },
        {
          runId: "ordinary-run",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        { status: "done", abortedLastRun: false },
      ),
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
      projectLifecycle(
        entry,
        {
          runId: "recovery",
          lifecycleGeneration: "generation-2",
          data: { phase: "end" },
        },
        { status: "done", abortedLastRun: false },
      ),
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
      projectLifecycle(
        entry,
        {
          runId: "old-run",
          lifecycleGeneration: "generation-1",
          data: { phase: "end" },
        },
        { status: "done", abortedLastRun: false },
      ),
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

  it("clears every main recovery ownership field", () => {
    expect(
      buildMainSessionRecoveryClearPatch({
        abortedLastRun: true,
        restartRecoveryRuns: [{ runId: "stale-run", lifecycleGeneration: "dead-generation" }],
        mainRestartRecovery: recoveryState(),
      }),
    ).toStrictEqual({
      abortedLastRun: false,
      restartRecoveryRuns: undefined,
      mainRestartRecovery: undefined,
    });
  });
});
