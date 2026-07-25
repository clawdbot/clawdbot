import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { getAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { runWithAgentCommandRecoveryOwner } from "./agent-command-recovery-owner.js";
import type { AgentCommandOpts } from "./command/types.js";
import { claimMainSessionRecoveryOwner } from "./main-session-recovery-store.js";

const recoveryOwnerMocks = vi.hoisted(() => ({
  scheduleMainSessionRecoveryPendingTarget: vi.fn(),
}));

vi.mock("./main-session-recovery-owner-release.js", () => ({
  scheduleMainSessionRecoveryPendingTarget:
    recoveryOwnerMocks.scheduleMainSessionRecoveryPendingTarget,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sessionKey = "agent:main:main";

afterEach(() => {
  vi.clearAllMocks();
});

describe("agent command restart recovery ownership", () => {
  function createTarget() {
    const storePath = path.join(tempDirs.make("openclaw-agent-command-owner-"), "sessions.json");
    return {
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

  it("rejects standalone work owned by a legacy session-key alias", async () => {
    const target = createTarget();
    await applySessionEntryLifecycleMutation({
      storePath: target.storePath,
      upserts: [
        {
          sessionKey: "main",
          entry: {
            sessionId: target.sessionId,
            updatedAt: 100,
            status: "running",
            abortedLastRun: true,
          },
        },
      ],
      skipMaintenance: true,
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

  it("rejects a legacy interrupted predecessor after the canonical key is reused", async () => {
    const base = createTarget();
    const target = {
      ...base,
      isNewSession: true,
      previousSessionId: base.sessionId,
      sessionId: "replacement-session",
    };
    await applySessionEntryLifecycleMutation({
      storePath: target.storePath,
      upserts: [
        {
          sessionKey,
          entry: { sessionId: target.sessionId, updatedAt: 200 },
        },
        {
          sessionKey: "main",
          entry: {
            sessionId: target.previousSessionId,
            updatedAt: 100,
            status: "running",
            abortedLastRun: true,
          },
        },
      ],
      skipMaintenance: true,
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
    ).rejects.toThrow("changed while starting work");
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
