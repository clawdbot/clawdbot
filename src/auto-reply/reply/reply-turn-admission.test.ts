// Tests reply turn admission decisions for active, queued, and aborted runs.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  markDiagnosticToolStartedForTest,
  resetDiagnosticRunActivityForTest,
} from "../../logging/diagnostic-run-activity.js";
import {
  interruptSessionWorkAdmissions,
  runExclusiveSessionLifecycleMutation,
} from "../../sessions/session-lifecycle-admission.js";
import {
  createReplyOperation,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  REPLY_RUN_STALE_TAKEOVER_MS,
  REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS,
  replyRunRegistry,
  runAfterReplyOperationClear,
  testing,
  type ReplyOperation,
} from "./reply-run-registry.js";
import { admitReplyTurn, runWithReplyOperationLifecycleAdmission } from "./reply-turn-admission.js";

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
  const storePath = path.join(root, "sessions.json");
  fs.writeFileSync(storePath, JSON.stringify(entries));
  return storePath;
}

describe("reply turn admission", () => {
  afterEach(() => {
    testing.resetReplyRunRegistry();
    resetDiagnosticRunActivityForTest();
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
        fs.writeFileSync(
          storePath,
          JSON.stringify({
            [sessionKey]: { sessionId, updatedAt: Date.now(), archivedAt: Date.now() },
          }),
        );
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
        fs.writeFileSync(storePath, JSON.stringify({}));
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
        fs.writeFileSync(
          storePath,
          JSON.stringify({
            [sessionKey]: { sessionId: nextSessionId, updatedAt: Date.now() },
          }),
        );
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
        fs.writeFileSync(
          storePath,
          JSON.stringify({
            [sessionKey]: { sessionId: nextSessionId, updatedAt: Date.now() },
          }),
        );
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
        fs.writeFileSync(
          storePath,
          JSON.stringify({
            [sessionKey]: { sessionId: "session-after-reset", updatedAt: Date.now() },
          }),
        );
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
      onFollowupAdmissionWaitChange: (waiting) => waitChanges.push(waiting),
    });

    let settled = false;
    void admitted.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(settled).toBe(false);
    expect(waitChanges).toEqual([]);

    active.complete();
    const result = await admitted;
    expect(waitChanges).toEqual([]);

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
      onFollowupAdmissionWaitChange: (waiting) => waitChanges.push(waiting),
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
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: { sessionId: nextSessionId, updatedAt: Date.now() },
      }),
    );
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
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: { sessionId: nextSessionId, updatedAt: Date.now() },
      }),
    );
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
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: { sessionId: nextSessionId, updatedAt: Date.now() },
      }),
    );

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
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        [sessionKey]: { sessionId: nextSessionId, updatedAt: Date.now() },
      }),
    );
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
      vi.setSystemTime(startedAt + REPLY_RUN_STALE_TAKEOVER_MS + 1);

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
      let settled = false;
      const result = admitReplyTurn({
        sessionKey: "agent:main:telegram:topic:fresh-visible",
        sessionId: "waiting-session",
        kind: "visible",
        resetTriggered: false,
        upstreamAbortSignal: abortController.signal,
      }).then((admission) => {
        settled = true;
        return admission;
      });

      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      expect(settled).toBe(false);
      expect(replyRunRegistry.get("agent:main:telegram:topic:fresh-visible")).toBe(active);

      abortController.abort();
      await expect(result).resolves.toMatchObject({
        status: "skipped",
        reason: "aborted",
        activeOperation: active,
      });
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
        vi.setSystemTime(startedAt + REPLY_RUN_STALE_TAKEOVER_MS + 1);

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
});
