import { describe, expect, it } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { projectMainSessionRecoveryLifecycle } from "./main-session-recovery-lifecycle.js";
import { transitionMainSessionRecovery } from "./main-session-recovery-state.js";

function recoveryEntry(params?: {
  hasCurrentOwner?: boolean;
  ownsDelivery?: boolean;
}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 100,
    status: "running",
    abortedLastRun: false,
    ...(params?.ownsDelivery ? { restartRecoveryDeliveryRunId: "recovery" } : {}),
    restartRecoveryRuns: [
      { runId: "recovery", lifecycleGeneration: "generation-old" },
      { runId: "recovery", lifecycleGeneration: "generation-current" },
    ],
    mainRestartRecovery: {
      cycleId: "cycle-1",
      revision: 5,
      chargedAttempts: 2,
      ...(params?.hasCurrentOwner
        ? {
            foregroundClaims: {
              lifecycleGeneration: "generation-current",
              tokens: ["current-owner"],
            },
          }
        : {}),
    },
  };
}

describe("main-session recovery run ownership", () => {
  it("transfers process-owned recovery leases to a restart marker", () => {
    const entry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
      restartRecoveryRuns: [{ runId: "drain-run", lifecycleGeneration: "generation-current" }],
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 4,
        chargedAttempts: 2,
        reservation: {
          runId: "reserved-run",
          attempt: 2,
          lifecycleGeneration: "generation-current",
        },
        foregroundClaims: {
          lifecycleGeneration: "generation-current",
          tokens: ["foreground-1"],
          runIdsByClaimId: { "foreground-1": "drain-run" },
        },
      },
    };

    transitionMainSessionRecovery(entry, {
      kind: "mark_interrupted",
      cycleId: "unused-cycle",
      now: 200,
      runs: [{ runId: "drain-run", lifecycleGeneration: "generation-current" }],
    });

    expect(entry.mainRestartRecovery).toEqual({
      cycleId: "cycle-1",
      revision: 5,
      chargedAttempts: 2,
    });
    expect(
      projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: "generation-current",
        entry,
        event: {
          runId: "drain-run",
          lifecycleGeneration: "generation-current",
          data: { phase: "end" },
        },
        snapshotPatch: { status: "done", abortedLastRun: false },
      }),
    ).toEqual({ action: "apply", patch: { restartRecoveryRuns: undefined } });
  });

  it("settles a resumed run once when older generations retain the same run id", () => {
    expect(
      projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: "generation-current",
        entry: recoveryEntry(),
        event: {
          runId: "recovery",
          lifecycleGeneration: "generation-current",
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

  it.each([
    { name: "admitted delivery owner", params: { ownsDelivery: true } },
    { name: "foreground owner", params: { hasCurrentOwner: true, ownsDelivery: true } },
  ])("does not let an older same-id terminal settle or tombstone its $name", ({ params }) => {
    expect(
      projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: "generation-current",
        entry: recoveryEntry(params),
        event: {
          runId: "recovery",
          lifecycleGeneration: "generation-old",
          data: { phase: "end" },
        },
        snapshotPatch: { status: "done", abortedLastRun: false },
      }),
    ).toEqual({
      action: "apply",
      patch: {
        restartRecoveryRuns: [{ runId: "recovery", lifecycleGeneration: "generation-current" }],
      },
    });
  });

  it("suppresses a duplicate older terminal after its fence has been consumed", () => {
    const entry = recoveryEntry({ ownsDelivery: true });
    entry.restartRecoveryRuns = [{ runId: "recovery", lifecycleGeneration: "generation-current" }];

    expect(
      projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: "generation-current",
        entry,
        event: {
          runId: "recovery",
          lifecycleGeneration: "generation-old",
          data: { phase: "end" },
        },
        snapshotPatch: { status: "done", abortedLastRun: false },
      }),
    ).toEqual({ action: "suppress" });
  });
});
