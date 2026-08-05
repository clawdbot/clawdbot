import { describe, expect, it } from "vitest";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../config/sessions.js";
import { transitionMainSessionRecovery } from "./main-session-recovery-state.js";

const executionIdentity = (runId: string) => ({
  tokenVersion: 1 as const,
  contextId: `context-${runId}`,
  executionId: `execution-${runId}`,
  runId,
  createdAt: 1,
});

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
    sessionKey: "agent:main:main",
  });
  if (result.kind !== "observed") {
    throw new Error("expected recovery observation");
  }
  return result.view;
}

function claimForeground(entry: SessionEntry) {
  return transitionMainSessionRecovery(entry, {
    kind: "claim_foreground",
    cycleId: "unused",
    lifecycleGeneration: "generation-1",
    sessionId: "session-1",
    sessionKey: "agent:main:main",
    claimId: "foreground-1",
  });
}

describe("main session recovery execution identity state", () => {
  it("captures identity at reservation and clears it with a cancelled reservation", () => {
    const entry = interruptedEntry();
    const prepared = transitionMainSessionRecovery(entry, {
      kind: "prepare_attempt",
      attempt: 1,
      lifecycleGeneration: "generation-1",
      now: 200,
      observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
      runId: "recovery-1",
      executionIdentity: { state: "enabled", token: executionIdentity("recovery-1") },
    });
    expect(prepared.kind).toBe("reserved");
    if (prepared.kind !== "reserved") {
      throw new Error("expected reservation");
    }
    expect(prepared.reservation).toMatchObject({
      executionIdentityAdmission: {
        kind: "capture",
        token: executionIdentity("recovery-1"),
      },
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "prepare_attempt",
        attempt: 1,
        lifecycleGeneration: "generation-1",
        now: 201,
        observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
        runId: "recovery-2",
        executionIdentity: { state: "enabled", token: executionIdentity("recovery-2") },
      }),
    ).toEqual({ kind: "rejected", reason: "stale_revision" });
    expect(entry.mainRestartRecovery?.reservation).toMatchObject({
      runId: "recovery-1",
      attempt: 1,
    });

    expect(claimForeground(entry).kind).toBe("foreground_claimed");
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
    expect(entry.mainRestartRecovery?.executionIdentity).toBeUndefined();
    expect(observe(entry, "generation-1")).toEqual({ status: "blocked" });
  });

  it("reuses captured identity after an ambiguous dispatch", () => {
    const entry = interruptedEntry();
    const prepared = transitionMainSessionRecovery(entry, {
      kind: "prepare_attempt",
      attempt: 1,
      lifecycleGeneration: "generation-1",
      now: 200,
      observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
      runId: "recovery-1",
      executionIdentity: { state: "enabled", token: executionIdentity("recovery-1") },
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
    const retry = transitionMainSessionRecovery(entry, {
      kind: "prepare_attempt",
      attempt: 2,
      lifecycleGeneration: "generation-1",
      now: 300,
      observation: {
        sessionId: "session-1",
        cycleId: "cycle-1",
        revision: entry.mainRestartRecovery!.revision,
      },
      runId: "recovery-1",
      executionIdentity: {
        state: "enabled",
        token: { ...executionIdentity("replacement"), runId: "recovery-1" },
      },
    });
    expect(retry).toMatchObject({
      kind: "reserved",
      reservation: {
        executionIdentityAdmission: {
          kind: "retry-reference",
          token: executionIdentity("recovery-1"),
        },
      },
    });
  });

  it("keeps disabled recovery identity out of durable state and reservations", () => {
    const entry = interruptedEntry();

    const prepared = transitionMainSessionRecovery(entry, {
      kind: "prepare_attempt",
      attempt: 1,
      lifecycleGeneration: "generation-1",
      now: 200,
      observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
      runId: "recovery-1",
      executionIdentity: { state: "disabled" },
    });

    expect(prepared).toMatchObject({ kind: "reserved" });
    if (prepared.kind !== "reserved") {
      throw new Error("expected reservation");
    }
    expect(prepared.reservation.executionIdentityAdmission).toBeUndefined();
    expect(entry.mainRestartRecovery?.executionIdentity).toBeUndefined();
  });

  it("does not propagate a previously retained token while collection is disabled", () => {
    const retained = executionIdentity("recovery-1");
    const entry = interruptedEntry({
      mainRestartRecovery: recoveryState({ executionIdentity: retained }),
    });

    const prepared = transitionMainSessionRecovery(entry, {
      kind: "prepare_attempt",
      attempt: 1,
      lifecycleGeneration: "generation-1",
      now: 200,
      observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
      runId: "recovery-1",
      executionIdentity: { state: "disabled" },
    });

    expect(prepared).toMatchObject({ kind: "reserved" });
    if (prepared.kind !== "reserved") {
      throw new Error("expected reservation");
    }
    expect(prepared.reservation.executionIdentityAdmission).toBeUndefined();
    expect(entry.mainRestartRecovery?.executionIdentity).toEqual(retained);
  });
});
