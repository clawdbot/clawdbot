// Tests reply turn admission decisions for active, queued, and aborted runs.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions/types.js";
import {
  resetDiagnosticRunActivityForTest,
  RUN_STALE_TAKEOVER_MS,
} from "../../logging/diagnostic-run-activity.js";
import { markDiagnosticToolStartedForTest } from "../../logging/diagnostic-run-activity.test-support.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import {
  createReplyOperation,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS,
  replyRunRegistry,
  runAfterReplyOperationClear,
  type ReplyOperation,
} from "./reply-run-registry.js";
import { testing } from "./reply-run-registry.test-support.js";
import { admitReplyTurn, runWithReplyOperationLifecycleAdmission } from "./reply-turn-admission.js";

const recoveryOwnerReleaseMocks = vi.hoisted(() => ({
  schedulePendingTarget: vi.fn(),
}));

vi.mock("../../agents/main-session-recovery-owner-release.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/main-session-recovery-owner-release.js")>()),
  scheduleMainSessionRecoveryPendingTarget: recoveryOwnerReleaseMocks.schedulePendingTarget,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createDeferred() {
  let resolve = () => {};
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createSessionStore(entries: Record<string, object>): string {
  const root = tempDirs.make("openclaw-reply-admission-");
  // The store handle stays a sessions.json path; the sqlite-backed accessor
  // resolves it to the per-agent DB, so fixtures must seed through the accessor.
  const storePath = path.join(root, "sessions.json");
  for (const [sessionKey, entry] of Object.entries(entries)) {
    replaceSessionEntrySync({ sessionKey, storePath }, entry as SessionEntry);
  }
  return storePath;
}

async function readSessionEntry(
  storePath: string,
  sessionKey: string,
): Promise<SessionEntry | undefined> {
  return loadSessionEntry({ sessionKey, storePath });
}

describe("reply turn admission", () => {
  afterEach(() => {
    testing.resetReplyRunRegistry();
    resetDiagnosticRunActivityForTest();
    recoveryOwnerReleaseMocks.schedulePendingTarget.mockClear();
  });

  it("rejects a reply when an archive commits before admission", async () => {
    const sessionKey = "agent:main:telegram:topic:archived";
    const sessionId = "session-before-archive";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        await replaceSessionEntry({ sessionKey, storePath }, {
          sessionId,
          updatedAt: Date.now(),
          archivedAt: Date.now(),
        } as SessionEntry);
      },
    });
    await mutationStarted.promise;

    const admission = admitReplyTurn({
      sessionKey,
      sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });
    releaseMutation.resolve();
    await mutation;

    await expect(admission).rejects.toThrow(
      `Session "${sessionKey}" is archived. Restore it before starting new work.`,
    );
  });

  it("rejects a reply when deletion commits before admission", async () => {
    const sessionKey = "agent:main:telegram:topic:deleted";
    const sessionId = "session-before-delete";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        await deleteSessionEntryLifecycle({
          storePath,
          archiveTranscript: false,
          target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
        });
      },
    });
    await mutationStarted.promise;

    const admission = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });
    releaseMutation.resolve();
    await mutation;

    await expect(admission).rejects.toThrow(/deleted while starting work/i);
  });

  it("uses the persisted session id when reset commits before admission", async () => {
    const sessionKey = "agent:main:telegram:topic:reset";
    const sessionId = "session-before-reset";
    const nextSessionId = "session-after-reset";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        await replaceSessionEntry({ sessionKey, storePath }, {
          sessionId: nextSessionId,
          updatedAt: Date.now(),
        } as SessionEntry);
      },
    });
    await mutationStarted.promise;

    const admission = admitReplyTurn({
      sessionKey,
      sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });
    releaseMutation.resolve();
    await mutation;
    const result = await admission;

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe(nextSessionId);
      result.operation.complete();
    }
  });

  it("rejects expected-session work when reset commits before admission", async () => {
    const sessionKey = "agent:main:telegram:topic:reset-expected";
    const sessionId = "session-before-reset";
    const nextSessionId = "session-after-reset";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        await replaceSessionEntry({ sessionKey, storePath }, {
          sessionId: nextSessionId,
          updatedAt: Date.now(),
        } as SessionEntry);
      },
    });
    await mutationStarted.promise;

    const admission = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });
    releaseMutation.resolve();
    await mutation;

    await expect(admission).rejects.toThrow(/changed while starting work/i);
  });

  it("drops queued work when reset cleanup cancels admission", async () => {
    const sessionKey = "agent:main:telegram:topic:queued-reset";
    const sessionId = "session-before-reset";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const abortController = new AbortController();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
        abortController.abort();
        await replaceSessionEntry({ sessionKey, storePath }, {
          sessionId: "session-after-reset",
          updatedAt: Date.now(),
        } as SessionEntry);
      },
    });
    await mutationStarted.promise;

    const admission = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "queued_followup",
      resetTriggered: false,
      upstreamAbortSignal: abortController.signal,
    });
    releaseMutation.resolve();
    await mutation;

    await expect(admission).resolves.toEqual({
      status: "skipped",
      reason: "aborted",
    });
  });

  it("drops queued work when the session is archived", async () => {
    const sessionKey = "agent:main:telegram:topic:queued-archive";
    const sessionId = "session-before-archive";
    const storePath = createSessionStore({
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        archivedAt: Date.now(),
      },
    });

    await expect(
      admitReplyTurn({
        sessionKey,
        sessionId,
        expectedSessionId: sessionId,
        storePath,
        kind: "queued_followup",
        resetTriggered: false,
      }),
    ).resolves.toEqual({
      status: "skipped",
      reason: "lifecycle-invalidated",
    });
  });

  it("holds lifecycle admission until a running reply operation clears", async () => {
    const sessionKey = "agent:main:telegram:topic:running-reset";
    const sessionId = "session-before-reset";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const admission = await admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });
    expect(admission.status).toBe("owned");
    if (admission.status !== "owned") {
      return;
    }
    admission.operation.setPhase("running");
    let mutationRan = false;
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      prepare: async () => {
        await interruptSessionWorkAdmissions({
          scope: storePath,
          identities: [sessionKey, sessionId],
        });
      },
      run: async () => {
        mutationRan = true;
      },
    });

    await vi.waitFor(() => {
      expect(admission.operation.abortSignal.aborted).toBe(true);
    });
    expect(admission.operation.result).toEqual({
      kind: "aborted",
      code: "aborted_for_restart",
    });
    expect(mutationRan).toBe(false);

    admission.operation.complete();
    await mutation;
    expect(mutationRan).toBe(true);
  });

  it.each(["visible", "heartbeat", "queued_followup"] as const)(
    "fences restart recovery from %s reply admission until the operation clears",
    async (kind) => {
      const sessionKey = `agent:main:telegram:topic:recovery-race:${kind}`;
      const sessionId = "interrupted-session";
      const storePath = createSessionStore({
        [sessionKey]: {
          sessionId,
          updatedAt: 100,
          status: "running",
          abortedLastRun: true,
          mainRestartRecovery: {
            cycleId: "cycle-1",
            revision: 1,
            chargedAttempts: 2,
          },
        },
      });
      const admission = await admitReplyTurn({
        sessionKey,
        sessionId,
        expectedSessionId: sessionId,
        storePath,
        kind,
        resetTriggered: false,
      });
      expect(admission.status).toBe("owned");
      if (admission.status !== "owned") {
        return;
      }

      const claimedEntry = await readSessionEntry(storePath, sessionKey);
      admission.operation.complete();
      await vi.waitFor(async () => {
        const entry = await readSessionEntry(storePath, sessionKey);
        expect(entry?.mainRestartRecovery?.foregroundClaims).toBeUndefined();
      });

      expect(claimedEntry?.mainRestartRecovery).toMatchObject({
        foregroundClaims: {
          tokens: [expect.any(String)],
        },
      });
      await expect(readSessionEntry(storePath, sessionKey)).resolves.toMatchObject({
        sessionId,
        status: "running",
      });
    },
  );

  it.each(["visible", "heartbeat"] as const)(
    "rejects %s reply admission for a tombstoned recovery session",
    async (kind) => {
      const sessionKey = `agent:main:telegram:topic:recovery-tombstone:${kind}`;
      const sessionId = "tombstoned-session";
      const storePath = createSessionStore({
        [sessionKey]: {
          sessionId,
          updatedAt: 100,
          status: "failed",
          abortedLastRun: false,
          mainRestartRecovery: {
            cycleId: "cycle-1",
            revision: 4,
            chargedAttempts: 3,
            tombstone: { reason: "automatic recovery exhausted" },
          },
        },
      });

      await expect(
        admitReplyTurn({
          sessionKey,
          sessionId,
          expectedSessionId: sessionId,
          storePath,
          kind,
          resetTriggered: false,
        }),
      ).rejects.toThrow(/changed while starting work/i);
    },
  );

  it("drops a queued followup for an admitted recovery fence", async () => {
    const sessionKey = "agent:main:telegram:topic:admitted-recovery";
    const sessionId = "admitted-recovery-session";
    const storePath = createSessionStore({
      [sessionKey]: {
        sessionId,
        updatedAt: 100,
        status: "running",
        abortedLastRun: false,
        restartRecoveryRuns: [{ runId: "recovery-run", lifecycleGeneration: "generation-1" }],
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 3,
          chargedAttempts: 1,
        },
      },
    });

    await expect(
      admitReplyTurn({
        sessionKey,
        sessionId,
        expectedSessionId: sessionId,
        storePath,
        kind: "queued_followup",
        resetTriggered: false,
      }),
    ).resolves.toEqual({ status: "skipped", reason: "lifecycle-invalidated" });
  });

  it("schedules released recovery only after retained admission exits", async () => {
    const sourceSessionKey = "agent:main:telegram:slash:recovery-adoption";
    const sessionKey = "agent:main:telegram:topic:recovery-adoption";
    const sessionId = "interrupted-session";
    const storePath = createSessionStore({
      [sessionKey]: {
        sessionId,
        updatedAt: 100,
        status: "running",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 1,
          chargedAttempts: 0,
        },
      },
    });
    const blocker = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    const reservation = createReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "source-session",
      resetTriggered: false,
    });

    const result = await admitReplyTurn({
      sessionKey,
      sessionId: reservation.sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
      waitForActive: false,
      retainLifecycleAdmissionOnActive: true,
      adoptOperation: reservation,
    });

    expect(result).toMatchObject({ status: "skipped", reason: "active-run" });
    expect(recoveryOwnerReleaseMocks.schedulePendingTarget).not.toHaveBeenCalled();
    await expect(readSessionEntry(storePath, sessionKey)).resolves.not.toHaveProperty(
      "mainRestartRecovery.foregroundClaims",
    );
    if (result.status === "skipped") {
      result.lifecycleAdmission?.release();
    }
    await vi.waitFor(() => {
      expect(recoveryOwnerReleaseMocks.schedulePendingTarget).toHaveBeenCalledWith({
        sessionId,
        sessionKey,
        storePath,
      });
    });

    blocker.complete();
    reservation.complete();
  });

  it("leaves interrupted subagent sessions to the subagent recovery owner", async () => {
    const sessionKey = "agent:main:subagent:child-1";
    const sessionId = "subagent-session";
    const storePath = createSessionStore({
      [sessionKey]: {
        sessionId,
        updatedAt: 100,
        status: "running",
        abortedLastRun: true,
        spawnDepth: 1,
      },
    });

    const admission = await admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });

    expect(admission.status).toBe("owned");
    if (admission.status === "owned") {
      admission.operation.complete();
    }
    await expect(readSessionEntry(storePath, sessionKey)).resolves.not.toHaveProperty(
      "mainRestartRecovery",
    );
  });

  it("holds interrupted queued reply work until its owner exits", async () => {
    const sessionKey = "agent:main:telegram:topic:queued-delete";
    const sessionId = "session-before-delete";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const admission = await admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });
    expect(admission.status).toBe("owned");
    if (admission.status !== "owned") {
      return;
    }

    let mutationRan = false;
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      prepare: async () => {
        await interruptSessionWorkAdmissions({
          scope: storePath,
          identities: [sessionKey, sessionId],
        });
      },
      run: async () => {
        mutationRan = true;
      },
    });

    await vi.waitFor(() => {
      expect(admission.operation.abortSignal.aborted).toBe(true);
    });
    expect(admission.operation.result).toEqual({
      kind: "aborted",
      code: "aborted_for_restart",
    });
    expect(mutationRan).toBe(false);
    expect(replyRunRegistry.get(sessionKey)).toBe(admission.operation);

    admission.operation.complete();
    await mutation;
    expect(mutationRan).toBe(true);
    expect(replyRunRegistry.get(sessionKey)).toBeUndefined();
  });

  it("excludes the initiating reply admission from an in-band lifecycle mutation", async () => {
    const sessionKey = "agent:main:telegram:topic:in-band-reset";
    const sessionId = "session-before-reset";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const admission = await admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });
    expect(admission.status).toBe("owned");
    if (admission.status !== "owned") {
      return;
    }

    await runWithReplyOperationLifecycleAdmission(admission.operation, async () => {
      await runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: [sessionKey, sessionId],
        prepare: async () => {
          await interruptSessionWorkAdmissions({
            scope: storePath,
            identities: [sessionKey, sessionId],
          });
        },
        run: async () => undefined,
      });
    });

    expect(admission.operation.abortSignal.aborted).toBe(false);
    admission.operation.complete();
  });

  it("skips an aborted reply waiting behind a lifecycle mutation", async () => {
    const sessionKey = "agent:main:telegram:topic:aborted";
    const sessionId = "session-before-abort";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const mutationStarted = createDeferred();
    const releaseMutation = createDeferred();
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [sessionKey, sessionId],
      run: async () => {
        mutationStarted.resolve();
        await releaseMutation.promise;
      },
    });
    await mutationStarted.promise;
    const controller = new AbortController();
    const admission = admitReplyTurn({
      sessionKey,
      sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
      upstreamAbortSignal: controller.signal,
    });
    controller.abort();
    releaseMutation.resolve();
    await mutation;

    await expect(admission).resolves.toEqual({ status: "skipped", reason: "aborted" });
  });

  it("waits for visible turns and reuses the active session id", async () => {
    const waitChanges: boolean[] = [];
    const active = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    active.setPhase("running");

    const admitted = admitReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "new-session",
      kind: "visible",
      resetTriggered: false,
      onReplyAdmissionWaitChange: (waiting) => waitChanges.push(waiting),
    });

    let settled = false;
    void admitted.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
    expect(waitChanges).toEqual([true]);

    active.complete();
    const result = await admitted;
    expect(waitChanges).toEqual([true, false]);

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe("active-session");
      result.operation.complete();
    }
  });

  it("does not apply cleanup settle timeout to visible turn admission", async () => {
    vi.useFakeTimers();
    try {
      const active = createReplyOperation({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "active-session",
        resetTriggered: false,
      });
      active.setPhase("running");

      const admitted = admitReplyTurn({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "waiting-session",
        kind: "visible",
        resetTriggered: false,
      });

      let settled = false;
      void admitted.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(settled).toBe(false);

      active.complete();
      const result = await admitted;
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        result.operation.complete();
      }
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps the cleanup settle timeout for queued follow-up retry", async () => {
    vi.useFakeTimers();
    try {
      const active = createReplyOperation({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "active-session",
        resetTriggered: false,
      });
      active.setPhase("running");

      const admitted = admitReplyTurn({
        sessionKey: "agent:main:discord:channel:42",
        sessionId: "queued-session",
        kind: "queued_followup",
        resetTriggered: false,
      });

      await vi.advanceTimersByTimeAsync(15_000);

      await expect(admitted).resolves.toMatchObject({
        status: "skipped",
        reason: "active-run",
        activeOperation: active,
      });
      active.complete();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps an already-waiting follow-up behind the delivery barrier", async () => {
    const waitChanges: boolean[] = [];
    const active = createReplyOperation({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const admitted = admitReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "queued-session",
      kind: "queued_followup",
      resetTriggered: false,
      onReplyAdmissionWaitChange: (waiting) => waitChanges.push(waiting),
    });
    let settled = false;
    void admitted.then(() => {
      settled = true;
    });

    await Promise.resolve();
    active.completeWithAfterClearBarrier(barrier);
    await Promise.resolve();

    expect(settled).toBe(false);
    await vi.waitFor(() => {
      expect(waitChanges).toEqual([true]);
    });

    releaseBarrier();
    const result = await admitted;
    expect(waitChanges).toEqual([true, false]);
    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      result.operation.complete();
    }
  });

  it("allows a visible turn to claim the lane while delivery settles", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    active.completeWithAfterClearBarrier(barrier);
    const result = await admitReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "visible-session",
      kind: "visible",
      resetTriggered: false,
    });

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      result.operation.complete();
    }
    releaseBarrier();
    await barrier;
  });

  it("skips heartbeat turns while delivery settles", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    active.completeWithAfterClearBarrier(barrier);
    const result = await admitReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "heartbeat-session",
      kind: "heartbeat",
      resetTriggered: false,
    });

    expect(result).toEqual({ status: "skipped", reason: "active-run" });
    releaseBarrier();
    await barrier;
  });

  it("passes a visible turn's rotated session to after-clear work", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let admissionSessionId: string | undefined;
    runAfterReplyOperationClear(active, (sessionId) => {
      admissionSessionId = sessionId;
    });

    active.completeWithAfterClearBarrier(barrier);
    const visibleAdmission = await admitReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: "visible-session",
      kind: "visible",
      resetTriggered: false,
    });
    expect(visibleAdmission.status).toBe("owned");
    if (visibleAdmission.status === "owned") {
      visibleAdmission.operation.updateSessionId("rotated-session");
      visibleAdmission.operation.complete();
    }

    releaseBarrier();
    await barrier;
    await vi.waitFor(() => {
      expect(admissionSessionId).toBe("rotated-session");
    });
    const queuedResult = await admitReplyTurn({
      sessionKey: "agent:main:discord:channel:42",
      sessionId: admissionSessionId ?? "queued-session",
      kind: "queued_followup",
      resetTriggered: false,
    });
    expect(queuedResult.status).toBe("owned");
    if (queuedResult.status === "owned") {
      expect(queuedResult.operation.sessionId).toBe("rotated-session");
      queuedResult.operation.complete();
    }
  });

  it("uses the active run's final session id after waiting", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "pre-compact-session",
      resetTriggered: false,
    });
    active.setPhase("preflight_compacting");

    const admitted = admitReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "new-session",
      kind: "visible",
      resetTriggered: false,
    });

    await Promise.resolve();
    active.updateSessionId("post-compact-session");
    active.complete();
    const result = await admitted;

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe("post-compact-session");
      result.operation.complete();
    }
  });

  it("accepts an expected session id rotated by the active run", async () => {
    const sessionKey = "agent:main:telegram:topic:compaction";
    const sessionId = "pre-compact-session";
    const nextSessionId = "post-compact-session";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const active = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    active.setPhase("preflight_compacting");

    const admitted = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionId: nextSessionId,
      updatedAt: Date.now(),
    } as SessionEntry);
    active.updateSessionId(nextSessionId);
    active.complete();
    const result = await admitted;

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe(nextSessionId);
      result.operation.complete();
    }
  });

  it("accepts a rotation already published by the expected active run", async () => {
    const sessionKey = "agent:main:telegram:topic:compaction-before-admission";
    const sessionId = "pre-compact-session";
    const nextSessionId = "post-compact-session";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const active = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    active.setPhase("preflight_compacting");
    active.updateSessionId(nextSessionId);
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionId: nextSessionId,
      updatedAt: Date.now(),
    } as SessionEntry);
    active.complete();

    const result = await admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      expectedActiveOperation: active,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe(nextSessionId);
      result.operation.complete();
    }
  });

  it("accepts a rotation published by the live owner after the caller snapshot", async () => {
    const sessionKey = "agent:main:telegram:topic:late-compaction-owner";
    const sessionId = "pre-compact-session";
    const nextSessionId = "post-compact-session";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const active = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    active.setPhase("preflight_compacting");
    active.updateSessionId(nextSessionId);
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionId: nextSessionId,
      updatedAt: Date.now(),
    } as SessionEntry);

    const admitted = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
      waitForActive: true,
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    active.complete();
    const result = await admitted;

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe(nextSessionId);
      result.operation.complete();
    }
  });

  it("rejects a fresh post-reset owner as rotation proof", async () => {
    const sessionKey = "agent:main:telegram:topic:fresh-post-reset-owner";
    const sessionId = "session-before-reset";
    const nextSessionId = "session-after-reset";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId: nextSessionId, updatedAt: Date.now() },
    });
    const freshOwner = createReplyOperation({
      sessionKey,
      sessionId: nextSessionId,
      resetTriggered: false,
    });

    const admitted = admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
      waitForActive: true,
    });

    await expect(admitted).rejects.toThrow(/changed while starting work/i);
    freshOwner.complete();
  });

  it.each([
    ["failed", (operation: ReplyOperation) => operation.fail("run_failed")],
    [
      "user-aborted",
      (operation: ReplyOperation) => {
        operation.abortByUser();
        operation.complete();
      },
    ],
  ])("accepts a rotation published before the expected run %s", async (_outcome, finish) => {
    const sessionKey = "agent:main:telegram:topic:compaction-terminal-outcome";
    const sessionId = "pre-compact-session";
    const nextSessionId = "post-compact-session";
    const storePath = createSessionStore({
      [sessionKey]: { sessionId, updatedAt: Date.now() },
    });
    const active = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    active.setPhase("preflight_compacting");
    active.updateSessionId(nextSessionId);
    await replaceSessionEntry({ sessionKey, storePath }, {
      sessionId: nextSessionId,
      updatedAt: Date.now(),
    } as SessionEntry);
    finish(active);

    const result = await admitReplyTurn({
      sessionKey,
      sessionId,
      expectedSessionId: sessionId,
      expectedActiveOperation: active,
      storePath,
      kind: "visible",
      resetTriggered: false,
    });

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.operation.sessionId).toBe(nextSessionId);
      result.operation.complete();
    }
  });

  it("skips heartbeat turns while a visible turn owns the lane", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "visible-session",
      resetTriggered: false,
    });

    const result = await admitReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "heartbeat-session",
      kind: "heartbeat",
      resetTriggered: false,
    });

    expect(result).toMatchObject({
      status: "skipped",
      reason: "active-run",
      activeOperation: active,
    });
    active.complete();
  });

  it("lets visible turns reclaim a stale active operation", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const startedAt = Date.now();
      const active = createReplyOperation({
        sessionKey: "agent:main:telegram:topic:stale-visible",
        sessionId: "stale-session",
        resetTriggered: false,
      });
      active.attachBackend({
        kind: "embedded",
        cancel,
        isStreaming: () => true,
      });
      active.setPhase("running");
      vi.setSystemTime(startedAt + RUN_STALE_TAKEOVER_MS + 1);

      const result = await admitReplyTurn({
        sessionKey: "agent:main:telegram:topic:stale-visible",
        sessionId: "replacement-session",
        kind: "visible",
        resetTriggered: false,
      });

      expect(active.result).toEqual({ kind: "failed", code: "run_stalled" });
      expect(active.abortSignal.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledWith("superseded");
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        result.operation.complete();
      }
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps visible turns waiting while an active operation is still fresh", async () => {
    vi.useFakeTimers();
    try {
      const active = createReplyOperation({
        sessionKey: "agent:main:telegram:topic:fresh-visible",
        sessionId: "fresh-session",
        resetTriggered: false,
      });
      active.setPhase("running");
      active.recordActivity();
      const abortController = new AbortController();
      const waitChanges: boolean[] = [];
      let settled = false;
      const result = admitReplyTurn({
        sessionKey: "agent:main:telegram:topic:fresh-visible",
        sessionId: "waiting-session",
        kind: "visible",
        resetTriggered: false,
        upstreamAbortSignal: abortController.signal,
        onReplyAdmissionWaitChange: (waiting) => waitChanges.push(waiting),
      }).then((admission) => {
        settled = true;
        return admission;
      });

      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      expect(settled).toBe(false);
      expect(waitChanges).toEqual([true]);
      expect(replyRunRegistry.get("agent:main:telegram:topic:fresh-visible")).toBe(active);

      abortController.abort();
      await expect(result).resolves.toMatchObject({
        status: "skipped",
        reason: "aborted",
        activeOperation: active,
      });
      expect(waitChanges).toEqual([true, false]);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("defers takeover to the blocked-tool floor while a quiet tool is active", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const startedAt = Date.now();
      const active = createReplyOperation({
        sessionKey: "agent:main:telegram:topic:quiet-tool",
        sessionId: "quiet-tool-session",
        resetTriggered: false,
      });
      active.attachBackend({
        kind: "embedded",
        cancel,
        isStreaming: () => true,
      });
      active.setPhase("running");
      markDiagnosticToolStartedForTest({
        sessionId: "quiet-tool-session",
        sessionKey: "agent:main:telegram:topic:quiet-tool",
        toolName: "exec",
        toolCallId: "tool-quiet-1",
      });

      // 12 minutes of silence with an active tool: past the generic takeover
      // window but inside the blocked-tool floor — must NOT be reclaimed.
      vi.setSystemTime(startedAt + 12 * 60_000);
      const abortController = new AbortController();
      let settled = false;
      const waiting = admitReplyTurn({
        sessionKey: "agent:main:telegram:topic:quiet-tool",
        sessionId: "replacement-quiet-tool",
        kind: "visible",
        resetTriggered: false,
        upstreamAbortSignal: abortController.signal,
      }).then((admission) => {
        settled = true;
        return admission;
      });
      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      expect(settled).toBe(false);
      expect(cancel).not.toHaveBeenCalled();

      // Past the 15-minute floor the same waiting turn reclaims it.
      vi.setSystemTime(startedAt + 16 * 60_000);
      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      const result = await waiting;
      expect(active.result).toEqual({ kind: "failed", code: "run_stalled" });
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        result.operation.complete();
      }
      abortController.abort();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it.each(["heartbeat", "queued_followup"] as const)(
    "does not let %s turns reclaim a stale active operation",
    async (kind) => {
      vi.useFakeTimers();
      try {
        const cancel = vi.fn();
        const startedAt = Date.now();
        const active = createReplyOperation({
          sessionKey: `agent:main:telegram:topic:stale-${kind}`,
          sessionId: `stale-${kind}-session`,
          resetTriggered: false,
        });
        active.attachBackend({
          kind: "embedded",
          cancel,
          isStreaming: () => true,
        });
        active.setPhase("running");
        vi.setSystemTime(startedAt + RUN_STALE_TAKEOVER_MS + 1);

        const admission = admitReplyTurn({
          sessionKey: `agent:main:telegram:topic:stale-${kind}`,
          sessionId: `replacement-${kind}-session`,
          kind,
          resetTriggered: false,
          waitTimeoutMs: 1,
        });
        if (kind === "queued_followup") {
          await Promise.resolve();
          await vi.advanceTimersByTimeAsync(100);
        }
        const result = await admission;

        expect(result).toMatchObject({
          status: "skipped",
          reason: "active-run",
          activeOperation: active,
        });
        expect(cancel).not.toHaveBeenCalled();
        expect(replyRunRegistry.get(`agent:main:telegram:topic:stale-${kind}`)).toBe(active);
        active.complete();
      } finally {
        await vi.runOnlyPendingTimersAsync();
        vi.useRealTimers();
      }
    },
  );

  it("lets visible turns reclaim terminal operations after settle grace elapsed", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = Date.now();
      const active = createReplyOperation({
        sessionKey: "agent:main:telegram:topic:terminal-unreleased",
        sessionId: "terminal-unreleased-session",
        resetTriggered: false,
      });
      active.setPhase("running");
      active.abortByUser();
      vi.setSystemTime(startedAt + REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);

      const result = await admitReplyTurn({
        sessionKey: "agent:main:telegram:topic:terminal-unreleased",
        sessionId: "replacement-terminal-session",
        kind: "visible",
        resetTriggered: false,
      });

      expect(active.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
      expect(replyRunRegistry.get("agent:main:telegram:topic:terminal-unreleased")).not.toBe(
        active,
      );
      expect(result.status).toBe("owned");
      if (result.status === "owned") {
        result.operation.complete();
      }
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("stops waiting when the caller aborts", async () => {
    const active = createReplyOperation({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "active-session",
      resetTriggered: false,
    });
    const abortController = new AbortController();
    const admitted = admitReplyTurn({
      sessionKey: "agent:main:telegram:topic:42",
      sessionId: "waiting-session",
      kind: "queued_followup",
      resetTriggered: false,
      upstreamAbortSignal: abortController.signal,
    });

    abortController.abort();

    await expect(admitted).resolves.toMatchObject({
      status: "skipped",
      reason: "aborted",
      activeOperation: active,
    });
    active.complete();
  });

  it("adopts a source-keyed command reservation into the target run slot", async () => {
    const sourceSessionKey = "agent:main:telegram:slash:adopt-user";
    const targetSessionKey = "agent:main:telegram:group:adopt-target";
    const targetSessionId = "target-session-adopt";
    const storePath = createSessionStore({
      [targetSessionKey]: { sessionId: targetSessionId, updatedAt: Date.now() },
    });
    const reservation = createReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "source-reservation-adopt",
      resetTriggered: false,
    });

    const admission = await admitReplyTurn({
      sessionKey: targetSessionKey,
      sessionId: reservation.sessionId,
      expectedSessionId: targetSessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
      waitForActive: false,
      adoptOperation: reservation,
    });

    expect(admission.status).toBe("owned");
    if (admission.status !== "owned") {
      return;
    }
    expect(admission.operation).toBe(reservation);
    expect(reservation.key).toBe(targetSessionKey);
    expect(replyRunRegistry.get(sourceSessionKey)).toBeUndefined();
    expect(replyRunRegistry.get(targetSessionKey)).toBe(reservation);

    // Target lifecycle interrupts must reach the adopted operation: reset or
    // delete on the target session interlocks with the continuation run.
    reservation.setPhase("running");
    let mutationRan = false;
    const mutation = runExclusiveSessionLifecycleMutation({
      scope: storePath,
      identities: [targetSessionKey, targetSessionId],
      prepare: async () => {
        await interruptSessionWorkAdmissions({
          scope: storePath,
          identities: [targetSessionKey, targetSessionId],
        });
      },
      run: async () => {
        mutationRan = true;
      },
    });
    await vi.waitFor(() => {
      expect(reservation.abortSignal.aborted).toBe(true);
    });
    expect(reservation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(mutationRan).toBe(false);

    reservation.complete();
    await mutation;
    expect(mutationRan).toBe(true);
  });

  it("skips adoption without waiting when the target run slot is owned", async () => {
    const sourceSessionKey = "agent:main:telegram:slash:busy-user";
    const targetSessionKey = "agent:main:telegram:group:busy-target";
    const targetSessionId = "target-session-busy";
    const storePath = createSessionStore({
      [targetSessionKey]: { sessionId: targetSessionId, updatedAt: Date.now() },
    });
    const blocker = createReplyOperation({
      sessionKey: targetSessionKey,
      sessionId: targetSessionId,
      resetTriggered: false,
    });
    blocker.setPhase("running");
    const reservation = createReplyOperation({
      sessionKey: sourceSessionKey,
      sessionId: "source-reservation-busy",
      resetTriggered: false,
    });

    const admission = await admitReplyTurn({
      sessionKey: targetSessionKey,
      sessionId: reservation.sessionId,
      expectedSessionId: targetSessionId,
      storePath,
      kind: "visible",
      resetTriggered: false,
      waitForActive: false,
      adoptOperation: reservation,
    });

    expect(admission).toMatchObject({
      status: "skipped",
      reason: "active-run",
      activeOperation: blocker,
    });
    // The reservation stays source-keyed so the command turn's own delivery
    // lifecycle is unaffected; queue policy handles the busy target.
    expect(reservation.key).toBe(sourceSessionKey);
    expect(replyRunRegistry.get(sourceSessionKey)).toBe(reservation);
    expect(replyRunRegistry.get(targetSessionKey)).toBe(blocker);
    expect(reservation.result).toBeNull();

    blocker.complete();
    reservation.complete();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
