import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../infra/agent-events.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { runWithAgentCommandRecoveryOwner } from "./agent-command-recovery-owner.js";
import type { AgentCommandOpts } from "./command/types.js";
import { MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER } from "./main-session-recovery/main-session-recovery-admission.js";
import { claimMainSessionRecoveryOwner } from "./main-session-recovery/main-session-recovery-store.js";

const recoveryOwnerMocks = vi.hoisted(() => ({
  scheduleMainSessionRecoveryPendingTarget: vi.fn(),
}));

vi.mock("./main-session-recovery/main-session-recovery-owner-release.js", () => ({
  scheduleMainSessionRecoveryPendingTarget:
    recoveryOwnerMocks.scheduleMainSessionRecoveryPendingTarget,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:main";

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("agent command restart recovery ownership", () => {
  function createTarget() {
    const storePath = path.join(tempDirs.make("openclaw-agent-command-owner-"), "sessions.json");
    return {
      sessionAgentId: "main",
      isNewSession: false,
      sessionId: "session-1",
      sessionKey,
      storePath,
    };
  }

  async function write(target: ReturnType<typeof createTarget>, entry: SessionEntry) {
    await replaceSessionEntry({ sessionKey, storePath: target.storePath }, entry);
  }

  it("rejects standalone work when interruption appears during preparation", async () => {
    const target = createTarget();
    await write(target, { sessionId: target.sessionId, updatedAt: 100 });
    const run = vi.fn();

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "reject_uncoordinated",
        opts: {} as AgentCommandOpts,
        prepare: async () => {
          await write(target, {
            sessionId: target.sessionId,
            updatedAt: 200,
            status: "running",
            abortedLastRun: true,
          });
          return target;
        },
        run,
      }),
    ).rejects.toThrow("interrupted work pending restart recovery");
    expect(run).not.toHaveBeenCalled();
    expect(
      (loadSessionEntry({ sessionKey, storePath: target.storePath }) as SessionEntry | undefined)
        ?.mainRestartRecovery?.foregroundClaims,
    ).toBeUndefined();
  });

  it("refreshes the prepared working copy after claiming a recovery owner", async () => {
    const base = createTarget();
    const staleEntry: SessionEntry = {
      sessionId: base.sessionId,
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
    };
    const target = {
      ...base,
      sessionEntry: { ...staleEntry },
      sessionStore: { [sessionKey]: { ...staleEntry } },
    };
    await write(target, staleEntry);

    await runWithAgentCommandRecoveryOwner({
      lifecycleGeneration: getAgentEventLifecycleGeneration(),
      mode: "claim",
      opts: { runId: "foreground-run" } as AgentCommandOpts,
      prepare: async () => target,
      run: async (prepared) => {
        const claims = prepared.sessionEntry.mainRestartRecovery?.foregroundClaims;
        expect(claims?.tokens).toEqual([expect.any(String)]);
        expect(Object.values(claims?.runIdsByClaimId ?? {})).toContain("foreground-run");
        expect(prepared.sessionStore[sessionKey]).toEqual(prepared.sessionEntry);
        const completed = { ...prepared.sessionEntry, abortedLastRun: false };
        await write(target, completed);
      },
    });

    const completed = loadSessionEntry({
      sessionKey,
      storePath: target.storePath,
    }) as SessionEntry | undefined;
    expect(completed?.abortedLastRun).toBe(false);
    expect(completed?.mainRestartRecovery).toBeUndefined();
    expect(recoveryOwnerMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenLastCalledWith(
      undefined,
    );
  });

  it("allows standalone work when interruption clears during preparation", async () => {
    const target = createTarget();
    await write(target, {
      sessionId: target.sessionId,
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
    });
    const run = vi.fn(async () => "ran");

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "reject_uncoordinated",
        opts: {} as AgentCommandOpts,
        prepare: async () => {
          await write(target, { sessionId: target.sessionId, updatedAt: 200 });
          return target;
        },
        run,
      }),
    ).resolves.toBe("ran");
    expect(run).toHaveBeenCalledOnce();
  });

  it("admits foreground work after clearing terminal recovery residue", async () => {
    const target = createTarget();
    await write(target, {
      sessionId: target.sessionId,
      updatedAt: 100,
      status: "failed",
      abortedLastRun: true,
      restartRecoveryRuns: [{ runId: "stale-run", lifecycleGeneration: "dead-generation" }],
    });
    const run = vi.fn(async () => "ran");

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "claim",
        opts: {} as AgentCommandOpts,
        prepare: async () => target,
        run,
      }),
    ).resolves.toBe("ran");
    expect(run).toHaveBeenCalledOnce();
    const stored = loadSessionEntry({ sessionKey, storePath: target.storePath }) as SessionEntry;
    expect(stored).toMatchObject({ status: "failed", abortedLastRun: false });
    expect(stored.restartRecoveryRuns).toBeUndefined();
    expect(stored.mainRestartRecovery).toBeUndefined();
  });

  it("allows read-only standalone inspection of terminal recovery residue", async () => {
    const target = createTarget();
    const residue: SessionEntry = {
      sessionId: target.sessionId,
      updatedAt: 100,
      status: "done",
      abortedLastRun: true,
      restartRecoveryRuns: [{ runId: "stale-run", lifecycleGeneration: "dead-generation" }],
    };
    await write(target, residue);
    const run = vi.fn(async () => "ran");

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "reject_uncoordinated",
        opts: {} as AgentCommandOpts,
        prepare: async () => target,
        run,
      }),
    ).resolves.toBe("ran");
    expect(run).toHaveBeenCalledOnce();
    const stored = loadSessionEntry({ sessionKey, storePath: target.storePath }) as SessionEntry;
    expect(stored).toMatchObject({
      status: "done",
      abortedLastRun: true,
      restartRecoveryRuns: residue.restartRecoveryRuns,
    });
    expect(stored.mainRestartRecovery).toBeUndefined();
  });

  it("runs a Gateway-admitted recovery without acquiring a foreground owner", async () => {
    const target = createTarget();
    await write(target, {
      sessionId: target.sessionId,
      updatedAt: 200,
      status: "running",
      abortedLastRun: false,
      restartRecoveryRuns: [{ runId: "recovery-run", lifecycleGeneration: "previous" }],
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 3,
        chargedAttempts: 1,
      },
    });
    const run = vi.fn(async () => "recovered");

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "claim",
        opts: { mainRestartRecoveryAdmitted: true } as AgentCommandOpts,
        prepare: async () => target,
        run,
      }),
    ).resolves.toBe("recovered");
    expect(run).toHaveBeenCalledOnce();
  });

  it("restores a Gateway-admitted recovery when command preparation fails", async () => {
    const target = createTarget();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    await write(target, {
      sessionId: target.sessionId,
      updatedAt: 200,
      status: "running",
      abortedLastRun: false,
      restartRecoveryRuns: [{ runId: "recovery-run", lifecycleGeneration }],
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 3,
        chargedAttempts: 1,
      },
    });
    const restoredTarget = {
      sessionId: target.sessionId,
      sessionKey,
      storePath: target.storePath,
    };
    const restoreAdmittedRecovery = vi.fn(async () => {
      const entry = loadSessionEntry({ sessionKey, storePath: target.storePath }) as SessionEntry;
      entry.abortedLastRun = true;
      await write(target, entry);
      return restoredTarget;
    });
    const run = vi.fn();

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration,
        mode: "claim",
        opts: { mainRestartRecoveryAdmitted: true } as AgentCommandOpts,
        prepare: async () => {
          throw new Error("model preparation failed");
        },
        restoreAdmittedRecovery,
        run,
      }),
    ).rejects.toThrow("model preparation failed");

    expect(restoreAdmittedRecovery).toHaveBeenCalledOnce();
    expect(recoveryOwnerMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenCalledWith(
      restoredTarget,
    );
    expect(run).not.toHaveBeenCalled();
    expect(loadSessionEntry({ sessionKey, storePath: target.storePath })).toMatchObject({
      abortedLastRun: true,
    });
  });

  it("keeps retrying admitted recovery restoration after immediate store failures", async () => {
    vi.useFakeTimers();
    try {
      const target = createTarget();
      const restoredTarget = {
        sessionId: target.sessionId,
        sessionKey,
        storePath: target.storePath,
      };
      let failures = 0;
      const restoreAdmittedRecovery = vi.fn(async () => {
        if (failures < 3) {
          failures += 1;
          throw new Error("transient session-store failure");
        }
        return restoredTarget;
      });
      const recovery = runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "claim",
        opts: { mainRestartRecoveryAdmitted: true } as AgentCommandOpts,
        prepare: async () => {
          throw new Error("model preparation failed");
        },
        restoreAdmittedRecovery,
        run: vi.fn(),
      });
      const rejected = expect(recovery).rejects.toThrow("model preparation failed");

      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(restoreAdmittedRecovery).toHaveBeenCalledTimes(3);
      expect(recoveryOwnerMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenCalledWith(
        undefined,
      );

      await vi.advanceTimersByTimeAsync(1_000);
      expect(restoreAdmittedRecovery).toHaveBeenCalledTimes(4);
      expect(recoveryOwnerMocks.scheduleMainSessionRecoveryPendingTarget).toHaveBeenCalledWith(
        restoredTarget,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["before preparation", "during claim"] as const)(
    "keeps requester settlement pending when recovery starts %s",
    async (timing) => {
      const target = createTarget();
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      await write(target, {
        sessionId: target.sessionId,
        updatedAt: 200,
        status: "running",
        abortedLastRun: false,
        restartRecoveryRuns: [{ runId: "recovery-run", lifecycleGeneration }],
        mainRestartRecovery: { cycleId: "cycle-1", revision: 3, chargedAttempts: 1 },
      });
      // This is the production failure, not a mocked admission rejection.
      await expect(
        claimMainSessionRecoveryOwner({
          lifecycleGeneration,
          sessionId: target.sessionId,
          target: { sessionKey, storePath: target.storePath },
        }),
      ).resolves.toEqual({ kind: "invalidated", reason: "state_changed" });
      const startOwner = () =>
        beginSessionWorkAdmission({
          scope: target.storePath,
          identities: [sessionKey, target.sessionId],
          owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
          assertAllowed: () => {},
        });
      let owner: Awaited<ReturnType<typeof startOwner>> | undefined;
      const ownerStarted = createDeferred();
      if (timing === "before preparation") {
        owner = await startOwner();
        ownerStarted.resolve();
      } else {
        const commit = sessionAccessor.applySessionEntryReplacements;
        vi.spyOn(sessionAccessor, "applySessionEntryReplacements").mockImplementationOnce(
          async (params) => {
            owner = await startOwner();
            ownerStarted.resolve();
            return await commit(params);
          },
        );
      }
      vi.useFakeTimers();
      const run = vi.fn(async () => "consolidated final");
      const prepare = vi.fn(async () => ({
        ...target,
        sessionEntry: loadSessionEntry({ sessionKey, storePath: target.storePath }),
        runLease: { release: vi.fn(async () => {}) },
      }));
      let settled = false;
      const wake = runWithAgentCommandRecoveryOwner({
        lifecycleGeneration,
        mode: "claim",
        opts: {
          runId: "settle-turn",
          inputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" },
        } as AgentCommandOpts,
        prepare,
        run,
      }).finally(() => {
        settled = true;
      });
      void wake.catch(() => {});
      try {
        await ownerStarted.promise;
        await vi.advanceTimersByTimeAsync(300_000);
        expect({ settled, executions: run.mock.calls.length }).toEqual({
          settled: false,
          executions: 0,
        });
        await write(target, { sessionId: target.sessionId, updatedAt: 300, status: "done" });
        owner!.release();
        await expect(wake).resolves.toBe("consolidated final");
        expect(run).toHaveBeenCalledOnce();
        expect(run).toHaveBeenCalledWith(
          expect.objectContaining({ sessionEntry: expect.objectContaining({ status: "done" }) }),
        );
        for (const result of prepare.mock.results) {
          expect((await result.value).runLease.release).toHaveBeenCalledOnce();
        }
      } finally {
        owner?.release();
        await wake.catch(() => {});
      }
    },
  );

  it.each([
    "cancelled",
    "cancelled during refresh",
    "cancelled during claim",
    "replaced",
    "rerouted",
    "tombstoned",
    "ownerless",
    "generation rotated",
  ] as const)("does not execute a %s requester settle turn", async (outcome) => {
    const target = createTarget();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const entry: SessionEntry = {
      sessionId: target.sessionId,
      updatedAt: 200,
      status: "running",
      abortedLastRun: false,
      restartRecoveryRuns: [{ runId: "recovery-run", lifecycleGeneration }],
      mainRestartRecovery: { cycleId: "cycle-1", revision: 3, chargedAttempts: 1 },
    };
    await write(
      target,
      outcome === "cancelled during claim" ? { ...entry, abortedLastRun: true } : entry,
    );
    const owner =
      outcome === "ownerless" || outcome === "cancelled during claim"
        ? undefined
        : await beginSessionWorkAdmission({
            scope: target.storePath,
            identities: [sessionKey, target.sessionId],
            owner: MAIN_SESSION_RECOVERY_WORK_ADMISSION_OWNER,
            assertAllowed: () => {},
          });
    const controller = new AbortController();
    if (outcome === "cancelled during claim") {
      const commit = sessionAccessor.applySessionEntryReplacements;
      vi.spyOn(sessionAccessor, "applySessionEntryReplacements").mockImplementationOnce(
        async (params) => {
          const result = await commit(params);
          controller.abort();
          return result;
        },
      );
    }
    const prepared = createDeferred();
    let preparationCount = 0;
    const release = vi.fn(async () => {});
    const run = vi.fn();
    const wake = runWithAgentCommandRecoveryOwner({
      lifecycleGeneration,
      mode: "claim",
      opts: {
        runId: "settle-turn",
        abortSignal: controller.signal,
        inputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" },
      } as AgentCommandOpts,
      prepare: async () => {
        preparationCount += 1;
        prepared.resolve();
        if (preparationCount > 1 && outcome === "cancelled during refresh") {
          controller.abort();
        }
        return {
          ...target,
          ...(outcome === "rerouted" && preparationCount > 1
            ? { sessionId: "replacement-session" }
            : {}),
          runLease: { release },
        };
      },
      run,
    });
    void wake.catch(() => {});
    try {
      await prepared.promise;
      if (outcome === "cancelled") {
        controller.abort();
        await expect(wake).rejects.toMatchObject({ name: "AbortError" });
      } else {
        if (outcome === "replaced" || outcome === "rerouted") {
          await write(target, { sessionId: "replacement-session", updatedAt: 300 });
        } else if (outcome === "tombstoned") {
          await write(target, {
            ...entry,
            status: "failed",
            mainRestartRecovery: {
              ...entry.mainRestartRecovery!,
              tombstone: { reason: "automatic recovery exhausted" },
            },
          });
        }
        if (outcome === "generation rotated") {
          rotateAgentEventLifecycleGeneration();
        }
        owner?.release();
        if (outcome === "cancelled during refresh" || outcome === "cancelled during claim") {
          await expect(wake).rejects.toMatchObject({ name: "AbortError" });
        } else if (outcome === "generation rotated") {
          await expect(wake).rejects.toThrow();
        } else {
          await expect(wake).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
        }
      }
      expect(run).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalled();
      if (outcome === "cancelled during claim") {
        expect(
          loadSessionEntry({ sessionKey, storePath: target.storePath })?.mainRestartRecovery
            ?.foregroundClaims,
        ).toBeUndefined();
      }
    } finally {
      owner?.release();
      controller.abort();
      await wake.catch(() => {});
    }
  });

  it("rejects ordinary work while an admitted recovery is still running", async () => {
    const target = createTarget();
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    await write(target, {
      sessionId: target.sessionId,
      updatedAt: 200,
      status: "running",
      abortedLastRun: false,
      restartRecoveryRuns: [{ runId: "recovery-run", lifecycleGeneration: "gateway-generation" }],
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 3,
        chargedAttempts: 1,
      },
    });
    const run = vi.fn();

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration,
        mode: "reject_uncoordinated",
        opts: {} as AgentCommandOpts,
        prepare: async () => target,
        run,
      }),
    ).rejects.toThrow("interrupted work pending restart recovery");
    expect(run).not.toHaveBeenCalled();
  });

  it("fences the durable predecessor during an automatic freshness rollover", async () => {
    const base = createTarget();
    const target = {
      ...base,
      isNewSession: true,
      previousSessionId: "session-1",
      sessionId: "session-2",
    };
    await write(base, {
      sessionId: target.previousSessionId,
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
    });
    const run = vi.fn();

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "reject_uncoordinated",
        opts: {} as AgentCommandOpts,
        prepare: async () => target,
        run,
      }),
    ).rejects.toThrow("interrupted work pending restart recovery");
    expect(run).not.toHaveBeenCalled();
  });

  it("allows a freshness successor after its clean replacement commits", async () => {
    const base = createTarget();
    const target = {
      ...base,
      isNewSession: true,
      previousSessionId: "session-1",
      sessionId: "session-2",
    };
    await write(base, { sessionId: target.sessionId, updatedAt: 200 });
    const run = vi.fn(async () => "successor");

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "claim",
        opts: {} as AgentCommandOpts,
        prepare: async () => target,
        run,
      }),
    ).resolves.toBe("successor");
    expect(run).toHaveBeenCalledOnce();
  });

  it("binds a transferred rollover lease to its exact predecessor", async () => {
    const base = createTarget();
    await write(base, {
      sessionId: base.sessionId,
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
    });
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const claim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: base.sessionId,
      target: { sessionKey, storePath: base.storePath },
    });
    if (claim.kind !== "claimed") {
      throw new Error("expected recovery owner claim");
    }
    const target = {
      ...base,
      isNewSession: true,
      previousSessionId: "different-predecessor",
      sessionId: "successor-session",
    };
    const run = vi.fn();

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration,
        mode: "claim",
        opts: { mainRestartRecoveryOwnerLease: claim.lease } as AgentCommandOpts,
        prepare: async () => target,
        run,
      }),
    ).rejects.toThrow("recovery owner changed during ingress preparation");
    expect(run).not.toHaveBeenCalled();
  });

  it("binds a transferred recovery owner to the actual agent run", async () => {
    const target = createTarget();
    await write(target, {
      sessionId: target.sessionId,
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
    });
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const claim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: target.sessionId,
      target: { sessionKey, storePath: target.storePath },
    });
    if (claim.kind !== "claimed") {
      throw new Error("expected recovery owner claim");
    }
    const run = vi.fn(async () => {
      const entry = loadSessionEntry({ sessionKey, storePath: target.storePath }) as SessionEntry;
      expect(entry.restartRecoveryRuns).toContainEqual({
        lifecycleGeneration,
        runId: "foreground-run",
      });
      expect(entry.mainRestartRecovery?.foregroundClaims?.runIdsByClaimId).toEqual({
        [claim.lease.claimId]: "foreground-run",
      });
      return "ran";
    });

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration,
        mode: "claim",
        opts: {
          mainRestartRecoveryOwnerLease: claim.lease,
          runId: "foreground-run",
        } as AgentCommandOpts,
        prepare: async () => target,
        run,
      }),
    ).resolves.toBe("ran");
    expect(run).toHaveBeenCalledOnce();
  });

  it("allows an explicitly requested fresh session without a predecessor", async () => {
    const target = { ...createTarget(), sessionId: "fresh-session" };
    const run = vi.fn(async () => "fresh");

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "reject_uncoordinated",
        opts: { sessionId: target.sessionId } as AgentCommandOpts,
        prepare: async () => target,
        run,
      }),
    ).resolves.toBe("fresh");
    expect(run).toHaveBeenCalledOnce();
  });

  it("invalidates an explicit session replaced during preparation", async () => {
    const target = createTarget();
    await write(target, { sessionId: target.sessionId, updatedAt: 100 });
    const run = vi.fn();

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "reject_uncoordinated",
        opts: { sessionId: target.sessionId } as AgentCommandOpts,
        prepare: async () => {
          await write(target, { sessionId: "replacement-session", updatedAt: 200 });
          return target;
        },
        run,
      }),
    ).rejects.toMatchObject({ code: "SESSION_WORK_START_CHANGED" });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a synthetic explicit replacement from a standalone process", async () => {
    const base = createTarget();
    const target = {
      ...base,
      isNewSession: true,
      previousSessionId: base.sessionId,
      sessionId: "fresh-session",
    };
    await write(base, {
      sessionId: base.sessionId,
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
    });
    const run = vi.fn(async () => "fresh");

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "reject_uncoordinated",
        opts: { sessionId: target.sessionId } as AgentCommandOpts,
        prepare: async () => target,
        run,
      }),
    ).rejects.toThrow("interrupted work pending restart recovery");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects standalone reuse of a tombstoned session", async () => {
    const target = createTarget();
    await write(target, {
      sessionId: target.sessionId,
      updatedAt: 100,
      status: "failed",
      abortedLastRun: false,
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 4,
        chargedAttempts: 3,
        tombstone: { reason: "automatic recovery exhausted" },
      },
    });
    const run = vi.fn(async () => "reused");

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "reject_uncoordinated",
        opts: { sessionId: target.sessionId } as AgentCommandOpts,
        prepare: async () => target,
        run,
      }),
    ).rejects.toThrow("interrupted work pending restart recovery");
    expect(run).not.toHaveBeenCalled();
  });

  it("revalidates a fresh key when interruption appears during preparation", async () => {
    const base = createTarget();
    const target = { ...base, isNewSession: true, sessionId: "fresh-session" };
    const run = vi.fn();

    await expect(
      runWithAgentCommandRecoveryOwner({
        lifecycleGeneration: getAgentEventLifecycleGeneration(),
        mode: "reject_uncoordinated",
        opts: {} as AgentCommandOpts,
        prepare: async () => {
          await write(base, {
            sessionId: target.sessionId,
            updatedAt: 200,
            status: "running",
            abortedLastRun: true,
          });
          return target;
        },
        run,
      }),
    ).rejects.toThrow("interrupted work pending restart recovery");
    expect(run).not.toHaveBeenCalled();
  });
});
