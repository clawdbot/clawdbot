import { describe, expect, it } from "vitest";
import type {
  InternalSessionEntry as SessionEntry,
  MainRestartRecoveryState,
} from "../../config/sessions.js";
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
  it.each([false, true])(
    "refreshes the budget only after a runtime turn starts (audit=%s)",
    (audit) => {
      const entry = interruptedEntry();
      for (let attempt = 1; attempt <= 7; attempt++) {
        const view = observe(entry, "generation-1");
        if (view.status !== "recoverable") {
          throw new Error("expected a recoverable session");
        }
        expect(view.nextAttempt).toBe(attempt);
        expect(
          transitionMainSessionRecovery(entry, {
            kind: "prepare_attempt",
            attempt,
            lifecycleGeneration: "generation-1",
            now: 200 + attempt,
            observation: view.observation,
            runId: "recovery-1",
            executionIdentity: { state: audit ? "enabled" : "disabled" },
          }).kind,
        ).toBe("reserved");
        expect(
          transitionMainSessionRecovery(entry, {
            kind: "admit_recovery",
            lifecycleGeneration: "generation-1",
            now: 300 + attempt,
            runId: "recovery-1",
            sessionId: "session-1",
          }).kind,
        ).toBe("admitted_recovery");
        if (attempt <= 4) {
          const registration = {
            kind: "register_recovery_turn" as const,
            attempt,
            cycleId: "cycle-1",
            lifecycleGeneration: "generation-1",
            runId: "recovery-1",
            sessionId: "session-1",
          };
          if (audit) {
            transitionMainSessionRecovery(entry, {
              ...registration,
              kind: "bind_admitted_execution_identity",
              token: executionIdentity("recovery-1"),
            });
          }
          expect(transitionMainSessionRecovery(entry, registration).kind).toBe("applied");
          expect(transitionMainSessionRecovery(entry, registration).kind).toBe("no_change");
        }
        transitionMainSessionRecovery(entry, {
          kind: "mark_admitted_recovery_interrupted",
          lifecycleGeneration: "generation-1",
          now: 400 + attempt,
          runId: "recovery-1",
          sessionId: "session-1",
        });
      }
      expect(observe(entry, "generation-1")).toMatchObject({ status: "exhausted" });
      expect(entry.mainRestartRecovery).toMatchObject({ chargedAttempts: 7, startedAttempt: 4 });
      expect(entry.mainRestartRecovery?.executionIdentity).toEqual(
        audit ? executionIdentity("recovery-1") : undefined,
      );
      expect(
        transitionMainSessionRecovery(entry, {
          kind: "register_recovery_turn",
          attempt: 4,
          cycleId: "cycle-1",
          lifecycleGeneration: "generation-1",
          runId: "recovery-1",
          sessionId: "session-1",
        }),
      ).toEqual({ kind: "rejected", reason: "stale_reservation" });
      expect(observe(entry, "generation-1")).toMatchObject({ status: "exhausted" });
    },
  );

  it("keeps reservation identity-free and cancellation leaves no identity state", () => {
    const entry = interruptedEntry();
    const prepared = transitionMainSessionRecovery(entry, {
      kind: "prepare_attempt",
      attempt: 1,
      lifecycleGeneration: "generation-1",
      now: 200,
      observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
      runId: "recovery-1",
      executionIdentity: { state: "enabled" },
    });
    expect(prepared.kind).toBe("reserved");
    if (prepared.kind !== "reserved") {
      throw new Error("expected reservation");
    }
    expect(prepared.reservation.executionIdentityAdmission).toBeUndefined();

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "prepare_attempt",
        attempt: 1,
        lifecycleGeneration: "generation-1",
        now: 201,
        observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
        runId: "recovery-2",
        executionIdentity: { state: "enabled" },
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

  it("reuses only identity bound after admitted execution", () => {
    const entry = interruptedEntry();
    const prepared = transitionMainSessionRecovery(entry, {
      kind: "prepare_attempt",
      attempt: 1,
      lifecycleGeneration: "generation-1",
      now: 200,
      observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
      runId: "recovery-1",
      executionIdentity: { state: "enabled" },
    });
    if (prepared.kind !== "reserved") {
      throw new Error("expected reservation");
    }

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "admit_recovery",
        lifecycleGeneration: "generation-1",
        now: 220,
        runId: "recovery-1",
        sessionId: "session-1",
      }),
    ).toEqual({ kind: "admitted_recovery" });
    expect(
      transitionMainSessionRecovery(entry, {
        kind: "bind_admitted_execution_identity",
        attempt: 1,
        cycleId: "cycle-1",
        lifecycleGeneration: "generation-1",
        runId: "recovery-1",
        sessionId: "session-1",
        token: executionIdentity("recovery-1"),
      }),
    ).toEqual({ kind: "applied" });
    expect(
      transitionMainSessionRecovery(entry, {
        kind: "mark_admitted_recovery_interrupted",
        lifecycleGeneration: "generation-1",
        now: 250,
        runId: "recovery-1",
        sessionId: "session-1",
      }),
    ).toMatchObject({ kind: "applied" });
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
      executionIdentity: { state: "enabled" },
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
    expect(entry.mainRestartRecovery?.executionIdentity).toBeUndefined();
  });

  it("rejects a delayed bind from an older cycle that reused the public run id", () => {
    const entry = interruptedEntry({
      abortedLastRun: false,
      lifecycleRunId: "recovery-1",
      restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration: "generation-1" }],
      mainRestartRecovery: recoveryState({ cycleId: "cycle-2" }),
    });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "bind_admitted_execution_identity",
        attempt: 1,
        cycleId: "cycle-1",
        lifecycleGeneration: "generation-1",
        runId: "recovery-1",
        sessionId: "session-1",
        token: executionIdentity("recovery-1"),
      }),
    ).toEqual({ kind: "rejected", reason: "stale_reservation" });
    expect(entry.mainRestartRecovery?.executionIdentity).toBeUndefined();
  });

  it("rejects a delayed bind after a newer disabled attempt reuses the run", () => {
    const entry = interruptedEntry();
    const first = transitionMainSessionRecovery(entry, {
      kind: "prepare_attempt",
      attempt: 1,
      lifecycleGeneration: "generation-1",
      now: 200,
      observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
      runId: "recovery-1",
      executionIdentity: { state: "enabled" },
    });
    expect(first.kind).toBe("reserved");
    expect(
      transitionMainSessionRecovery(entry, {
        kind: "admit_recovery",
        lifecycleGeneration: "generation-1",
        now: 220,
        runId: "recovery-1",
        sessionId: "session-1",
      }),
    ).toEqual({ kind: "admitted_recovery" });
    expect(
      transitionMainSessionRecovery(entry, {
        kind: "mark_admitted_recovery_interrupted",
        lifecycleGeneration: "generation-1",
        now: 230,
        runId: "recovery-1",
        sessionId: "session-1",
      }),
    ).toEqual({ kind: "applied" });
    const second = transitionMainSessionRecovery(entry, {
      kind: "prepare_attempt",
      attempt: 2,
      lifecycleGeneration: "generation-1",
      now: 240,
      observation: {
        sessionId: "session-1",
        cycleId: "cycle-1",
        revision: entry.mainRestartRecovery!.revision,
      },
      runId: "recovery-1",
      executionIdentity: { state: "disabled" },
    });
    expect(second.kind).toBe("reserved");
    expect(
      transitionMainSessionRecovery(entry, {
        kind: "admit_recovery",
        lifecycleGeneration: "generation-1",
        now: 250,
        runId: "recovery-1",
        sessionId: "session-1",
      }),
    ).toEqual({ kind: "admitted_recovery" });

    expect(
      transitionMainSessionRecovery(entry, {
        kind: "bind_admitted_execution_identity",
        attempt: 1,
        cycleId: "cycle-1",
        lifecycleGeneration: "generation-1",
        runId: "recovery-1",
        sessionId: "session-1",
        token: executionIdentity("recovery-1"),
      }),
    ).toEqual({ kind: "rejected", reason: "stale_reservation" });
    expect(entry.mainRestartRecovery?.executionIdentity).toBeUndefined();
  });
});
