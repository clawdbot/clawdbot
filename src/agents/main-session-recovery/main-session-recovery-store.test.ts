import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntriesCore,
} from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { loadSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import * as recoveryOwnerRelease from "./main-session-recovery-owner-release.js";
import {
  claimMainSessionRecoveryOwner,
  commitMainSessionRecovery,
  createRestoreAdmittedRecoveryInterrupted,
  inspectMainSessionRecoveryRequired,
  refreshMainSessionRecoveryOwner,
  releaseMainSessionRecoveryOwner,
} from "./main-session-recovery-store.js";

const sessionKey = "agent:main:main";
const executionIdentity = (runId: string) => ({
  tokenVersion: 1 as const,
  contextId: `context-${runId}`,
  executionId: `execution-${runId}`,
  runId,
  createdAt: 1,
});
const enabledExecutionIdentity = (runId: string) => ({
  state: "enabled" as const,
  token: executionIdentity(runId),
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("main session recovery store", () => {
  let dir: string;
  let lifecycleGeneration: string;
  let storePath: string;

  beforeEach(() => {
    dir = tempDirs.make("openclaw-main-recovery-store-");
    lifecycleGeneration = getAgentEventLifecycleGeneration();
    storePath = path.join(dir, "sessions.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function write(entry: SessionEntry): Promise<void> {
    await sessionAccessor.replaceSessionEntry({ sessionKey, storePath }, entry);
  }

  function read(): SessionEntry {
    return sessionAccessor.loadSessionEntry({ sessionKey, storePath })!;
  }

  function trajectoryTarget(): ReturnType<typeof resolveSqliteTargetFromSessionStorePath> {
    return resolveSqliteTargetFromSessionStorePath(storePath, { agentId: "main" });
  }

  function readStore(): Record<string, SessionEntry> {
    return Object.fromEntries(
      listSessionEntriesCore({ storePath }).map(({ sessionKey: key, entry }) => [key, entry]),
    );
  }

  async function seedExact(entries: Record<string, SessionEntry>): Promise<void> {
    await applySessionEntryLifecycleMutation({
      storePath,
      upserts: Object.entries(entries).map(([key, entry]) => ({ sessionKey: key, entry })),
      skipMaintenance: true,
    });
  }

  function interruptedEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
    return {
      sessionId: "session-1",
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-1",
        revision: 1,
        chargedAttempts: 0,
      },
      ...overrides,
    };
  }

  type ClaimParams = Parameters<typeof claimMainSessionRecoveryOwner>[0];
  type CommitParams = Parameters<typeof commitMainSessionRecovery>[0];

  function commitRecovery(
    command: CommitParams["command"],
    options: Omit<CommitParams, "command" | "target"> = {},
  ) {
    return commitMainSessionRecovery({ command, target: { sessionKey, storePath }, ...options });
  }

  function claimRecovery(
    overrides: Omit<ClaimParams, "lifecycleGeneration" | "sessionId" | "target"> = {},
  ) {
    return claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey, storePath },
      ...overrides,
    });
  }

  async function reserve(targetSessionKey = sessionKey) {
    const result = await commitMainSessionRecovery({
      command: {
        kind: "prepare_attempt",
        attempt: 1,
        lifecycleGeneration,
        now: 200,
        observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
        runId: "recovery-1",
        executionIdentity: enabledExecutionIdentity("recovery-1"),
      },
      target: { sessionKey: targetSessionKey, storePath },
    });
    if (result.transition.kind !== "reserved") {
      throw new Error("expected reservation");
    }
    return result.transition.reservation;
  }

  it("persists a cycle before returning a legacy interrupted observation", async () => {
    await write({
      sessionId: "session-1",
      updatedAt: 100,
      status: "running",
      abortedLastRun: true,
    });

    const result = await commitRecovery(
      {
        kind: "observe",
        cycleId: "cycle-1",
        lifecycleGeneration,
        sessionKey,
      },
      { requireWriteSuccess: true },
    );

    expect(result.transition).toMatchObject({
      kind: "observed",
      view: { status: "recoverable" },
    });
    expect(read().mainRestartRecovery).toMatchObject({
      cycleId: "cycle-1",
      revision: 1,
    });
  });

  it("preserves a concurrent foreground claim while cancelling its reservation", async () => {
    await write(interruptedEntry());
    const reservation = await reserve();
    await commitRecovery({
      kind: "claim_foreground",
      cycleId: "unused",
      lifecycleGeneration,
      sessionId: "session-1",
      sessionKey,
      claimId: "foreground-1",
    });

    await commitRecovery({ kind: "cancel_reservation", reservation });

    expect(read().mainRestartRecovery).toMatchObject({
      chargedAttempts: 0,
      foregroundClaims: {
        lifecycleGeneration,
        tokens: ["foreground-1"],
      },
    });
  });

  it("transfers a resumed recovery run to one durable lifecycle owner", async () => {
    await write(
      interruptedEntry({
        restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration: "generation-old" }],
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 2,
          chargedAttempts: 1,
          reservation: { runId: "recovery-1", attempt: 1, lifecycleGeneration },
        },
      }),
    );

    const admitted = await commitRecovery({
      kind: "admit_recovery",
      lifecycleGeneration,
      now: 300,
      runId: "recovery-1",
      sessionId: "session-1",
    });

    expect(admitted.transition).toEqual({ kind: "admitted_recovery" });
    expect(read().restartRecoveryRuns).toEqual([{ runId: "recovery-1", lifecycleGeneration }]);
    expect(read().abortedLastRun).toBe(false);
  });

  it("rejects an observation after the session is replaced", async () => {
    await write({
      sessionId: "session-2",
      updatedAt: 300,
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-2",
        revision: 1,
        chargedAttempts: 0,
      },
    });

    const result = await commitRecovery({
      kind: "prepare_attempt",
      attempt: 1,
      lifecycleGeneration,
      now: 400,
      observation: { sessionId: "session-1", cycleId: "cycle-1", revision: 1 },
      runId: "stale-recovery",
      executionIdentity: enabledExecutionIdentity("stale-recovery"),
    });

    expect(result.transition).toEqual({ kind: "rejected", reason: "session_replaced" });
    expect(read().mainRestartRecovery?.reservation).toBeUndefined();
  });

  it("does not cancel a reservation after its session is replaced", async () => {
    await write(interruptedEntry());
    const reservation = await reserve();

    await write({
      sessionId: "session-2",
      updatedAt: 300,
      status: "running",
      abortedLastRun: true,
      mainRestartRecovery: {
        cycleId: "cycle-2",
        revision: 4,
        chargedAttempts: 2,
      },
    });

    const cancelled = await commitRecovery({ kind: "cancel_reservation", reservation });

    expect(cancelled.transition).toEqual({ kind: "rejected", reason: "stale_reservation" });
    expect(read()).toMatchObject({
      sessionId: "session-2",
      mainRestartRecovery: {
        cycleId: "cycle-2",
        revision: 4,
        chargedAttempts: 2,
      },
    });
  });

  it("does not let an old reservation survive healthy clear and immediate re-wedge", async () => {
    await write(interruptedEntry());
    const reservation = await reserve();
    await commitRecovery({ kind: "clear" });
    await commitRecovery({ kind: "mark_interrupted", cycleId: "cycle-2", now: 300 });

    const cancelled = await commitRecovery({ kind: "cancel_reservation", reservation });

    expect(cancelled.transition).toEqual({ kind: "rejected", reason: "stale_reservation" });
    expect(read().mainRestartRecovery).toMatchObject({
      cycleId: "cycle-2",
      chargedAttempts: 0,
    });
  });

  it("claims the exact foreground row without scanning aliases", async () => {
    await write(interruptedEntry());
    const accessorSpy = vi.spyOn(sessionAccessor, "applySessionEntryReplacements");

    const claim = await claimRecovery();

    expect(claim.kind).toBe("claimed");
    expect(accessorSpy).toHaveBeenCalledOnce();
    expect(accessorSpy.mock.calls[0]?.[0]).toMatchObject({ sessionKeys: [sessionKey] });
  });

  it("atomically clears orphaned lifecycle fences from a healthy row", async () => {
    await write(
      interruptedEntry({
        abortedLastRun: false,
        mainRestartRecovery: undefined,
        restartRecoveryRuns: [{ runId: "stale-run", lifecycleGeneration: "stale-generation" }],
      }),
    );

    await expect(claimRecovery()).resolves.toEqual({ kind: "not_required" });
    expect(read()).toMatchObject({
      sessionId: "session-1",
      status: "running",
      abortedLastRun: false,
    });
    expect(read().restartRecoveryRuns).toBeUndefined();
    expect(read().mainRestartRecovery).toBeUndefined();
  });

  it("atomically clears orphaned recovery residue from a terminal row", async () => {
    await write(
      interruptedEntry({
        status: "failed",
        mainRestartRecovery: undefined,
        restartRecoveryRuns: [{ runId: "stale-run", lifecycleGeneration: "dead-generation" }],
      }),
    );

    await expect(claimRecovery()).resolves.toEqual({ kind: "not_required" });
    expect(read()).toMatchObject({
      sessionId: "session-1",
      status: "failed",
      abortedLastRun: false,
    });
    expect(read().restartRecoveryRuns).toBeUndefined();
    expect(read().mainRestartRecovery).toBeUndefined();
    expect(read().restartRecoveryDeliveryRunId).toBeUndefined();
  });

  it("inspects terminal recovery residue as non-blocking before foreground cleanup", async () => {
    const residue = interruptedEntry({
      status: "done",
      mainRestartRecovery: undefined,
      restartRecoveryRuns: [{ runId: "stale-run", lifecycleGeneration: "dead-generation" }],
    });
    await write(residue);

    await expect(
      inspectMainSessionRecoveryRequired({
        expectedSessionId: "session-1",
        lifecycleGeneration,
        target: { sessionKey, storePath },
      }),
    ).resolves.toEqual({ kind: "not_required" });
    expect(read()).toMatchObject({
      status: "done",
      abortedLastRun: true,
      restartRecoveryRuns: residue.restartRecoveryRuns,
    });
    expect(read().mainRestartRecovery).toBeUndefined();

    await expect(claimRecovery()).resolves.toEqual({ kind: "not_required" });
    expect(read()).toMatchObject({ status: "done", abortedLastRun: false });
    expect(read().restartRecoveryRuns).toBeUndefined();
  });

  it("binds a foreground claim to its lifecycle run", async () => {
    await write(interruptedEntry());

    const claim = await claimRecovery({ runId: "foreground-run" });

    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    expect(read()).toMatchObject({
      restartRecoveryRuns: [{ lifecycleGeneration, runId: "foreground-run" }],
      mainRestartRecovery: {
        foregroundClaims: {
          lifecycleGeneration,
          runIdsByClaimId: { [claim.lease.claimId]: "foreground-run" },
        },
      },
    });
  });

  it("releases an owner after the durable row session id rotates", async () => {
    await write(interruptedEntry());
    const claim = await claimRecovery();
    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    const current = read();
    await write({ ...current, sessionId: "session-2" });

    await expect(releaseMainSessionRecoveryOwner(claim.lease)).resolves.toBeUndefined();

    expect(read().mainRestartRecovery?.foregroundClaims).toBeUndefined();
  });

  it("keeps retrying an exact owner release after immediate store retries fail", async () => {
    vi.useFakeTimers();
    try {
      await write(interruptedEntry());
      const claim = await claimRecovery();
      if (claim.kind !== "claimed") {
        throw new Error("expected foreground owner claim");
      }
      const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
      let failures = 0;
      vi.spyOn(sessionAccessor, "applySessionEntryReplacements").mockImplementation(
        async (params) => {
          if (failures < 3) {
            failures += 1;
            throw new Error("transient session-store failure");
          }
          return await applySessionEntryReplacements(params);
        },
      );

      const schedulePending = vi
        .spyOn(recoveryOwnerRelease, "scheduleMainSessionRecoveryPendingTarget")
        .mockImplementation(() => {});
      const immediateRelease = releaseMainSessionRecoveryOwner(claim.lease);
      const immediateReleaseRejected = expect(immediateRelease).rejects.toThrow(
        "transient session-store failure",
      );
      await vi.advanceTimersByTimeAsync(100);
      await immediateReleaseRejected;
      expect(read().mainRestartRecovery?.foregroundClaims?.tokens).toEqual([claim.lease.claimId]);

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(read().mainRestartRecovery?.foregroundClaims).toBeUndefined();
      });
      await vi.waitFor(() =>
        expect(schedulePending).toHaveBeenCalledWith({
          sessionId: "session-1",
          sessionKey,
          storePath,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves interrupted non-main rows to their specialized recovery owner", async () => {
    const subagentKey = "agent:main:subagent:child";
    await seedExact({ [subagentKey]: interruptedEntry({ spawnDepth: 1 }) });

    const claim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey: subagentKey, storePath },
    });

    expect(claim).toEqual({ kind: "not_required" });
    expect(readStore()[subagentKey]?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
  });

  it("does not let a replacement bypass a tombstoned predecessor", async () => {
    await write(
      interruptedEntry({
        status: "failed",
        abortedLastRun: false,
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 4,
          chargedAttempts: 3,
          tombstone: { reason: "automatic recovery exhausted" },
        },
      }),
    );

    await expect(claimRecovery({ replacementSessionId: "session-2" })).resolves.toEqual({
      kind: "invalidated",
      reason: "state_changed",
    });
  });

  it("does not let foreground work bypass an exhausted predecessor", async () => {
    await write(
      interruptedEntry({
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 4,
          chargedAttempts: 3,
        },
      }),
    );

    await expect(claimRecovery()).resolves.toEqual({
      kind: "invalidated",
      reason: "recovery_exhausted",
    });
    expect(read().mainRestartRecovery?.foregroundClaims).toBeUndefined();
  });

  it("validates a transferred owner against the latest durable row", async () => {
    await write(interruptedEntry());
    const claim = await claimRecovery();
    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }

    await expect(refreshMainSessionRecoveryOwner(claim.lease)).resolves.toBeDefined();
    await releaseMainSessionRecoveryOwner(claim.lease);
    await expect(refreshMainSessionRecoveryOwner(claim.lease)).resolves.toBeUndefined();
  });

  it("returns a retry target only when the final foreground owner releases", async () => {
    await write(interruptedEntry());
    const first = await claimRecovery();
    const second = await claimRecovery();
    if (first.kind !== "claimed" || second.kind !== "claimed") {
      throw new Error("expected foreground owner claims");
    }

    await expect(releaseMainSessionRecoveryOwner(first.lease)).resolves.toBeUndefined();
    await expect(releaseMainSessionRecoveryOwner(second.lease)).resolves.toEqual({
      sessionId: "session-1",
      sessionKey,
      storePath,
    });
    await expect(releaseMainSessionRecoveryOwner(second.lease)).resolves.toEqual({
      sessionId: "session-1",
      sessionKey,
      storePath,
    });
  });

  it("carries the durable partition owner into the owner-release retry target", async () => {
    await write(interruptedEntry());
    const claim = await claimMainSessionRecoveryOwner({
      lifecycleGeneration,
      sessionId: "session-1",
      target: { sessionKey, storePath, agentId: "main" },
    });
    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    expect(claim.lease.agentId).toBe("main");

    await expect(releaseMainSessionRecoveryOwner(claim.lease)).resolves.toEqual({
      sessionId: "session-1",
      sessionKey,
      storePath,
      agentId: "main",
    });
  });

  it("does not let an old lease release a same-token claim from a new cycle", async () => {
    await write(interruptedEntry());
    const oldClaim = await claimRecovery();
    if (oldClaim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    await commitRecovery({ kind: "clear" });
    await commitRecovery({ kind: "mark_interrupted", cycleId: "cycle-2", now: 300 });
    await commitRecovery({
      kind: "claim_foreground",
      cycleId: "unused",
      lifecycleGeneration,
      sessionId: "session-1",
      sessionKey,
      claimId: oldClaim.lease.claimId,
    });

    await releaseMainSessionRecoveryOwner(oldClaim.lease);

    expect(read().mainRestartRecovery).toMatchObject({
      cycleId: "cycle-2",
      foregroundClaims: {
        lifecycleGeneration,
        tokens: [oldClaim.lease.claimId],
      },
    });
  });

  it("retries a transient owner release write failure", async () => {
    await write(interruptedEntry());
    const claim = await claimRecovery();
    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    const applySessionEntryReplacements = sessionAccessor.applySessionEntryReplacements;
    const accessorSpy = vi
      .spyOn(sessionAccessor, "applySessionEntryReplacements")
      .mockRejectedValueOnce(new Error("transient writer failure"))
      .mockImplementation(async (params) => await applySessionEntryReplacements(params));

    await releaseMainSessionRecoveryOwner(claim.lease);

    expect(accessorSpy).toHaveBeenCalledTimes(2);
    expect(read().mainRestartRecovery?.foregroundClaims).toBeUndefined();
  });

  it("rejects an old claimant queued ahead of the current lifecycle generation", async () => {
    await write(interruptedEntry());

    let enterWriter = () => {};
    const writerEntered = new Promise<void>((resolve) => {
      enterWriter = resolve;
    });
    let releaseWriter = () => {};
    const writerGate = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const blocker = sessionAccessor.applySessionEntryReplacements({
      storePath,
      update: async () => {
        enterWriter();
        await writerGate;
        return { result: undefined };
      },
    });
    await writerEntered;

    const staleClaim = commitRecovery({
      kind: "claim_foreground",
      cycleId: "unused",
      lifecycleGeneration,
      sessionId: "session-1",
      sessionKey,
      claimId: "stale-owner",
    });
    const staleOwnerClaim = claimRecovery({
      allowMissingSession: true,
      replacementSessionId: "session-2",
    });
    const staleInspection = inspectMainSessionRecoveryRequired({
      expectedSessionId: "session-1",
      lifecycleGeneration,
      target: { sessionKey, storePath },
    });
    await Promise.resolve();
    const currentGeneration = rotateAgentEventLifecycleGeneration();
    const currentClaim = commitRecovery({
      kind: "claim_foreground",
      cycleId: "unused",
      lifecycleGeneration: currentGeneration,
      sessionId: "session-1",
      sessionKey,
      claimId: "current-owner",
    });
    releaseWriter();

    await blocker;
    expect((await staleClaim).transition).toEqual({
      kind: "rejected",
      reason: "stale_generation",
    });
    await expect(staleOwnerClaim).resolves.toEqual({
      kind: "invalidated",
      reason: "stale_generation",
    });
    await expect(staleInspection).resolves.toEqual({
      kind: "invalidated",
      reason: "stale_generation",
    });
    expect((await currentClaim).transition).toMatchObject({
      kind: "foreground_claimed",
      claim: { claimId: "current-owner" },
    });
    expect(read().mainRestartRecovery?.foregroundClaims).toEqual({
      lifecycleGeneration: currentGeneration,
      tokens: ["current-owner"],
    });
  });

  it("rejects a delayed admitted-interruption callback after lifecycle rotation", async () => {
    await write(
      interruptedEntry({
        abortedLastRun: false,
        restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration }],
      }),
    );
    rotateAgentEventLifecycleGeneration();

    const result = await commitRecovery({
      kind: "mark_admitted_recovery_interrupted",
      lifecycleGeneration,
      now: 300,
      runId: "recovery-1",
      sessionId: "session-1",
    });

    expect(result.transition).toEqual({ kind: "rejected", reason: "stale_generation" });
    expect(read()).toMatchObject({
      sessionId: "session-1",
      status: "running",
      abortedLastRun: false,
    });
  });

  it("rejects a transferred foreground lease after lifecycle rotation", async () => {
    await write(interruptedEntry());
    const claim = await claimRecovery();
    if (claim.kind !== "claimed") {
      throw new Error("expected foreground owner claim");
    }
    rotateAgentEventLifecycleGeneration();

    await expect(refreshMainSessionRecoveryOwner(claim.lease)).resolves.toBeUndefined();
  });

  it("records one interrupted trajectory ending when an admitted recovery is restored", async () => {
    await write(
      interruptedEntry({
        abortedLastRun: false,
        lifecycleRunId: "recovery-1",
        restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration }],
      }),
    );

    const restoreAdmittedRecovery = createRestoreAdmittedRecoveryInterrupted({
      agentId: "main",
      lifecycleGeneration,
      logWarn: () => {},
      runId: "recovery-1",
      sessionId: () => "session-1",
      sessionKey,
      storePath,
      trajectoryTarget: trajectoryTarget(),
    });

    await expect(restoreAdmittedRecovery()).resolves.toEqual({
      sessionId: "session-1",
      sessionKey,
      storePath,
      agentId: "main",
    });
    const restoredEntry = read();
    expect(restoredEntry).toMatchObject({
      sessionId: "session-1",
      status: "running",
      abortedLastRun: true,
    });
    expect(restoredEntry.lifecycleRunId).toBeUndefined();

    // The pre-dispatch restore boundary records the canonical terminal event,
    // and a repeated closure invocation must not fabricate a duplicate.
    await expect(restoreAdmittedRecovery()).resolves.toBeUndefined();
    const trajectoryEvents = await loadSqliteTrajectoryRuntimeEvents({
      sessionId: "session-1",
      storePath,
    });
    expect(trajectoryEvents).toEqual([
      expect.objectContaining({
        type: "session.ended",
        runId: "recovery-1",
        data: expect.objectContaining({ status: "interrupted", aborted: true }),
      }),
    ]);
  });

  it("records the trajectory ending even if shutdown begins immediately after the rollback commits", async () => {
    await write(
      interruptedEntry({
        abortedLastRun: false,
        lifecycleRunId: "recovery-1",
        restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration }],
      }),
    );

    let continuation = true;
    const restoreAdmittedRecovery = createRestoreAdmittedRecoveryInterrupted({
      agentId: "main",
      lifecycleGeneration,
      logWarn: () => {},
      runId: "recovery-1",
      sessionId: () => "session-1",
      sessionKey,
      shouldContinue: () => continuation,
      storePath,
      trajectoryTarget: trajectoryTarget(),
    });

    const resultPromise = restoreAdmittedRecovery();
    continuation = false;
    await expect(resultPromise).resolves.toEqual({
      sessionId: "session-1",
      sessionKey,
      storePath,
      agentId: "main",
    });

    const trajectoryEvents = await loadSqliteTrajectoryRuntimeEvents({
      sessionId: "session-1",
      storePath,
    });
    expect(trajectoryEvents).toEqual([
      expect.objectContaining({
        type: "session.ended",
        runId: "recovery-1",
        data: expect.objectContaining({ status: "interrupted", aborted: true }),
      }),
    ]);
  });

  it("records no trajectory ending when the admitted recovery restore is rejected", async () => {
    await write(
      interruptedEntry({
        abortedLastRun: false,
        lifecycleRunId: "recovery-1",
        restartRecoveryRuns: [{ runId: "recovery-1", lifecycleGeneration }],
      }),
    );
    const restoreAdmittedRecovery = createRestoreAdmittedRecoveryInterrupted({
      agentId: "main",
      lifecycleGeneration,
      logWarn: () => {},
      runId: "recovery-1",
      sessionId: () => "rotated-session",
      sessionKey,
      storePath,
      trajectoryTarget: trajectoryTarget(),
    });

    await expect(restoreAdmittedRecovery()).resolves.toBeUndefined();
    expect(read()).toMatchObject({ abortedLastRun: false });
    expect(await loadSqliteTrajectoryRuntimeEvents({ sessionId: "session-1", storePath })).toEqual(
      [],
    );
  });
});
