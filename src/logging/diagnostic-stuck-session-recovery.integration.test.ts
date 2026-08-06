// Stuck session recovery integration tests cover end-to-end recovery diagnostics.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveEmbeddedSessionLane } from "../agents/embedded-agent-runner/lanes.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import { testing as embeddedRunTesting } from "../agents/embedded-agent-runner/runs.test-support.js";
import {
  createReplyOperation,
  runAfterReplyOperationClear,
} from "../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../auto-reply/reply/reply-run-registry.test-support.js";
import {
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { enqueueCommandInLane, getQueueSize, resetCommandLane } from "../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../process/command-queue.test-support.js";
import {
  getDiagnosticSessionActivitySnapshot,
  markDiagnosticArgumentChurnObservation,
  markDiagnosticEmbeddedRunStarted,
  markDiagnosticRunProgress,
} from "./diagnostic-run-activity.js";
import { markDiagnosticModelStartedForTest } from "./diagnostic-run-activity.test-support.js";
import {
  testing as recoveryTesting,
  recoverStuckDiagnosticSession,
} from "./diagnostic-stuck-session-recovery.runtime.js";
import {
  logSessionStateChange,
  resetDiagnosticStateForTest,
  startDiagnosticHeartbeat,
} from "./diagnostic.js";

async function expectPendingAfterEventLoopTurn(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  expect(settled).toBe(false);
}

describe("stuck session recovery integration", () => {
  afterEach(() => {
    recoveryTesting.resetRecoveriesInFlight();
    embeddedRunTesting.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetCommandQueueStateForTest();
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
  });

  it("recovers repeated paid-call-shaped activity once without duplicate queued delivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-08-04T03:00:00Z"));
    const sessionKey = "agent:main:repeated-requests";
    const sessionId = "repeated-requests-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
    operation.setPhase("running");
    let markActiveStarted!: () => void;
    const activeStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve;
    });
    const active = enqueueCommandInLane(
      lane,
      () =>
        new Promise<"aborted">((resolve) => {
          markActiveStarted();
          operation.abortSignal.addEventListener(
            "abort",
            () => {
              operation.complete();
              resolve("aborted");
            },
            { once: true },
          );
        }),
      { warnAfterMs: Number.MAX_SAFE_INTEGER },
    );
    let deliveries = 0;
    const queued = enqueueCommandInLane(
      lane,
      async () => {
        deliveries += 1;
        return "delivered";
      },
      { warnAfterMs: Number.MAX_SAFE_INTEGER },
    );
    await activeStarted;

    const events: DiagnosticEventPayload[] = [];
    const unsubscribe = onDiagnosticEvent((event) => events.push(event));
    startDiagnosticHeartbeat(
      { diagnostics: { enabled: true } },
      {
        recoverStuckSession: recoverStuckDiagnosticSession,
        testTimings: { stuckSessionWarnMs: 30_000, stuckSessionAbortMs: 90_000 },
      },
    );
    logSessionStateChange({ sessionId, sessionKey, state: "processing" });
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey, runId: sessionId });
    markDiagnosticModelStartedForTest({
      sessionId,
      sessionKey,
      runId: sessionId,
      provider: "mock",
      model: "repeated-request-model",
      observationUnit: "request",
    });
    for (let attempt = 2; attempt <= 3; attempt += 1) {
      await vi.advanceTimersByTimeAsync(30_000);
      markDiagnosticModelStartedForTest({
        sessionId,
        sessionKey,
        runId: sessionId,
        provider: "mock",
        model: "repeated-request-model",
        observationUnit: "request",
      });
    }
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();

    await expect(active).resolves.toBe("aborted");
    await expect(queued).resolves.toBe("delivered");
    await vi.advanceTimersByTimeAsync(1);
    expect(deliveries).toBe(1);
    expect(getQueueSize(lane)).toBe(0);
    expect(events.filter((event) => event.type === "session.recovery.requested")).toHaveLength(1);
    expect(events.find((event) => event.type === "session.recovery.completed")).toMatchObject({
      status: "aborted",
      action: "abort_embedded_run",
    });
    unsubscribe();
  });

  it("does not reset a blocked lane while a reply operation is still active", async () => {
    const sessionKey = "agent:main:active-reply";
    const sessionId = "active-reply-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);

    void enqueueCommandInLane(lane, () => new Promise<never>(() => {}), {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    const queued = enqueueCommandInLane(lane, async () => "drained", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });

    expect(getQueueSize(lane)).toBe(2);

    await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 180_000,
      queueDepth: 1,
    });

    await expectPendingAfterEventLoopTurn(queued);
    expect(getQueueSize(lane)).toBe(2);

    operation.complete();
    expect(resetCommandLane(lane)).toBe(1);
    await expect(queued).resolves.toBe("drained");
  });

  it("does not reset sibling-key lane work while the same session file has an active embedded run", async () => {
    const activeSessionKey = "agent:main:visible";
    const fallbackSessionKey = "agent:main:fallback";
    const activeSessionId = "active-session-file-run";
    const fallbackSessionId = "fallback-session-file-run";
    const sessionFile = "/tmp/openclaw-diagnostic-shared-session.jsonl";
    const lane = resolveEmbeddedSessionLane(fallbackSessionKey);
    const handle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    };

    setActiveEmbeddedRun(activeSessionId, handle, activeSessionKey, sessionFile);
    void enqueueCommandInLane(lane, () => new Promise<never>(() => {}), {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    const queued = enqueueCommandInLane(lane, async () => "drained", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });

    const outcome = await recoverStuckDiagnosticSession({
      sessionId: fallbackSessionId,
      sessionKey: fallbackSessionKey,
      sessionFile,
      ageMs: 180_000,
      queueDepth: 1,
    });

    expect(outcome).toMatchObject({
      status: "skipped",
      action: "observe_only",
      reason: "active_embedded_run",
      activeSessionId,
    });
    await expectPendingAfterEventLoopTurn(queued);
    expect(getQueueSize(lane)).toBe(2);

    clearActiveEmbeddedRun(activeSessionId, handle, activeSessionKey, sessionFile);
    expect(resetCommandLane(lane)).toBe(1);
    await expect(queued).resolves.toBe("drained");
  });

  it("aborts registered pre-run lane work and drains queued messages", async () => {
    const sessionKey = "agent:main:active-pre-run";
    const sessionId = "active-pre-run-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    let markActiveStarted!: () => void;
    const activeStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve;
    });

    const active = enqueueCommandInLane(
      lane,
      () =>
        new Promise<"aborted">((resolve) => {
          markActiveStarted();
          if (operation.abortSignal.aborted) {
            resolve("aborted");
            return;
          }
          operation.abortSignal.addEventListener(
            "abort",
            () => {
              operation.complete();
              resolve("aborted");
            },
            { once: true },
          );
        }),
      { warnAfterMs: Number.MAX_SAFE_INTEGER },
    );
    const queued = enqueueCommandInLane(lane, async () => "drained", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });

    expect(getQueueSize(lane)).toBe(2);
    await activeStarted;

    const outcome = await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 720_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    await expect(active).resolves.toBe("aborted");
    await expect(queued).resolves.toBe("drained");
    expect(outcome.status).toBe("aborted");
    expect(getQueueSize(lane)).toBe(0);
  });

  it("keeps queued lane work behind reply-only force-clear settlement", async () => {
    vi.useFakeTimers();
    try {
      const sessionKey = "agent:main:reply-only-force-clear";
      const sessionId = "reply-only-force-clear-session";
      const lane = resolveEmbeddedSessionLane(sessionKey);
      const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
      operation.attachBackend({
        kind: "embedded",
        cancel: () => {},
        isStreaming: () => true,
      });
      operation.setPhase("running");
      let ownerCleared = false;
      runAfterReplyOperationClear(operation, () => {
        ownerCleared = true;
      });

      void enqueueCommandInLane(lane, () => new Promise<never>(() => {}), {
        warnAfterMs: Number.MAX_SAFE_INTEGER,
      });
      const queued = enqueueCommandInLane(
        lane,
        async () => {
          expect(ownerCleared).toBe(true);
          return "drained";
        },
        { warnAfterMs: Number.MAX_SAFE_INTEGER },
      );

      const recovery = recoverStuckDiagnosticSession({
        sessionId,
        sessionKey,
        ageMs: 720_000,
        queueDepth: 1,
        allowActiveAbort: true,
      });
      // The shared deadline can leave the owner-settlement clamp's final 100 ms.
      await vi.advanceTimersByTimeAsync(15_100);

      await expect(recovery).resolves.toMatchObject({
        status: "aborted",
        action: "abort_embedded_run",
        aborted: false,
        drained: false,
        forceCleared: true,
      });
      await expect(queued).resolves.toBe("drained");
      expect(ownerCleared).toBe(true);
      expect(getQueueSize(lane)).toBe(0);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("reclaims continuous argument churn after its semantic progress clock becomes stale", async () => {
    const sessionKey = "agent:main:argument-churn";
    const sessionId = "argument-churn-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    let markActiveStarted!: () => void;
    const activeStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve;
    });

    const active = enqueueCommandInLane(
      lane,
      () =>
        new Promise<"aborted">((resolve) => {
          markActiveStarted();
          operation.abortSignal.addEventListener(
            "abort",
            () => {
              operation.complete();
              resolve("aborted");
            },
            { once: true },
          );
        }),
      { warnAfterMs: Number.MAX_SAFE_INTEGER },
    );
    const queued = enqueueCommandInLane(lane, async () => "drained", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    await activeStarted;

    const proofNow = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(proofNow - 6 * 60_000);
    markDiagnosticEmbeddedRunStarted({ sessionId, sessionKey });
    markDiagnosticArgumentChurnObservation({
      sessionId,
      sessionKey,
      runId: sessionId,
      active: true,
    });
    for (let step = 1; step <= 12; step += 1) {
      vi.setSystemTime(proofNow - 6 * 60_000 + step * 30_000);
      markDiagnosticRunProgress({
        sessionId,
        sessionKey,
        runId: sessionId,
        reason: "model_call:stream_progress",
      });
      markDiagnosticArgumentChurnObservation({
        sessionId,
        sessionKey,
        runId: sessionId,
        active: true,
      });
    }
    vi.useRealTimers();
    expect(getDiagnosticSessionActivitySnapshot({ sessionId, sessionKey })).toMatchObject({
      activeWorkKind: "embedded_run",
      lastProgressReason: "tool_loop:argument_churn",
    });

    const outcome = await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 6 * 60_000,
      queueDepth: 1,
      staleActiveProgressAbortMs: 5 * 60_000,
    });

    await expect(active).resolves.toBe("aborted");
    await expect(queued).resolves.toBe("drained");
    expect(outcome).toMatchObject({ status: "aborted", action: "abort_embedded_run" });
    expect(getQueueSize(lane)).toBe(0);
  });

  it("releases a wedged lane after a clean abort when session work remains queued (#91700)", async () => {
    const sessionKey = "agent:main:wedged-delivery";
    const sessionId = "wedged-delivery-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    operation.setPhase("running");
    // Cancel settles the registry (clean abort+drain) while the lane task that
    // hosted the run stays wedged, mirroring a hang past the run's own cleanup.
    operation.attachBackend({
      kind: "embedded",
      cancel: () => queueMicrotask(() => operation.complete()),
      isStreaming: () => false,
    });
    void enqueueCommandInLane(lane, () => new Promise<never>(() => {}), {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    expect(getQueueSize(lane)).toBe(1);

    const outcome = await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 720_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    expect(outcome).toMatchObject({
      status: "aborted",
      action: "abort_embedded_run",
      aborted: true,
      drained: true,
      forceCleared: false,
      released: 1,
    });
    const queued = enqueueCommandInLane(lane, async () => "drained", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    await expect(queued).resolves.toBe("drained");
  });

  it("does not reset a lane that unwedged and started a queued turn during the abort (#91700)", async () => {
    const sessionKey = "agent:main:unwedged-during-abort";
    const sessionId = "unwedged-during-abort-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);
    const operation = createReplyOperation({
      sessionKey,
      sessionId,
      resetTriggered: false,
    });
    operation.setPhase("running");
    let markHostStarted!: () => void;
    const hostStarted = new Promise<void>((resolve) => {
      markHostStarted = resolve;
    });
    // Host task frees the lane on abort; the queued turn then pumps to active
    // and only it settles the registry, so the drain resolves with fresh work
    // already running — the race the queueDepth reset must not clobber.
    const host = enqueueCommandInLane(
      lane,
      () =>
        new Promise<"aborted">((resolve) => {
          markHostStarted();
          operation.abortSignal.addEventListener("abort", () => resolve("aborted"), {
            once: true,
          });
        }),
      { warnAfterMs: Number.MAX_SAFE_INTEGER },
    );
    let releaseFreshTurn!: (value: "done") => void;
    const freshTurn = enqueueCommandInLane(
      lane,
      () => {
        operation.complete();
        return new Promise<"done">((resolve) => {
          releaseFreshTurn = resolve;
        });
      },
      { warnAfterMs: Number.MAX_SAFE_INTEGER },
    );
    await hostStarted;

    const outcome = await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 720_000,
      queueDepth: 1,
      allowActiveAbort: true,
    });

    await expect(host).resolves.toBe("aborted");
    expect(outcome).toMatchObject({
      status: "aborted",
      aborted: true,
      drained: true,
      released: 0,
    });
    // The fresh turn still owns the lane slot: later work must wait for it.
    const third = enqueueCommandInLane(lane, async () => "third", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    await expectPendingAfterEventLoopTurn(third);
    expect(getQueueSize(lane)).toBe(2);
    releaseFreshTurn("done");
    await expect(freshTurn).resolves.toBe("done");
    await expect(third).resolves.toBe("third");
  });

  it("does not reset a blocked lane while unregistered lane work is still active", async () => {
    const sessionKey = "agent:main:unregistered-work";
    const sessionId = "unregistered-work-session";
    const lane = resolveEmbeddedSessionLane(sessionKey);

    void enqueueCommandInLane(lane, () => new Promise<never>(() => {}), {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });
    const queued = enqueueCommandInLane(lane, async () => "drained", {
      warnAfterMs: Number.MAX_SAFE_INTEGER,
    });

    expect(getQueueSize(lane)).toBe(2);

    await recoverStuckDiagnosticSession({
      sessionId,
      sessionKey,
      ageMs: 180_000,
      queueDepth: 1,
    });

    await expectPendingAfterEventLoopTurn(queued);
    expect(getQueueSize(lane)).toBe(2);

    expect(resetCommandLane(lane)).toBe(1);
    await expect(queued).resolves.toBe("drained");
  });
});
