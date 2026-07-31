import { describe, expect, it } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import { projectMainSessionRecoveryLifecycle } from "./main-session-recovery-lifecycle.js";

function recoveryEntry(params?: { hasCurrentOwner?: boolean }): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 100,
    status: "running",
    abortedLastRun: false,
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

  it("does not let an older same-id terminal settle its replacement generation", () => {
    expect(
      projectMainSessionRecoveryLifecycle({
        currentLifecycleGeneration: "generation-current",
        entry: recoveryEntry({ hasCurrentOwner: true }),
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
        restartRecoveryTerminalRunIds: ["recovery"],
      },
    });
  });
});
