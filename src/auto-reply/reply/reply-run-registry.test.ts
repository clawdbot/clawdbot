// Tests active reply run registry add, lookup, and cleanup behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import {
  getDiagnosticSessionActivitySnapshot,
  resetDiagnosticRunActivityForTest,
  RUN_STALE_TAKEOVER_MS,
} from "../../logging/diagnostic-run-activity.js";
import { diagnosticLogger } from "../../logging/diagnostic-runtime.js";
import { MAX_TIMER_TIMEOUT_MS } from "../../shared/number-coercion.js";
import {
  testing,
  abortActiveReplyRuns,
  createReplyOperation,
  expireStaleReplyOperation,
  forceClearReplyRunBySessionId,
  isReplyRunActiveForSessionId,
  isReplyRunAbortableForCompaction,
  isReplyRunAbortableForSignal,
  queueReplyRunMessage,
  REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS,
  REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS,
  replyRunRegistry,
  runAfterReplyOperationClear,
  resolveActiveReplyRunSessionId,
  waitForReplyRunEndBySessionId,
} from "./reply-run-registry.js";
import { admitReplyTurn } from "./reply-turn-admission.js";

describe("reply run registry", () => {
  afterEach(() => {
    testing.resetReplyRunRegistry();
    resetDiagnosticRunActivityForTest();
    vi.restoreAllMocks();
  });

  it("keeps ownership stable by sessionKey while sessionId rotates", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "session-old",
        resetTriggered: false,
      });

      const oldWaitPromise = waitForReplyRunEndBySessionId("session-old", 1_000);

      operation.updateSessionId("session-new");

      expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);
      expect(resolveActiveReplyRunSessionId("agent:main:main")).toBe("session-new");
      expect(isReplyRunActiveForSessionId("session-old")).toBe(false);
      expect(isReplyRunActiveForSessionId("session-new")).toBe(true);

      let settled = false;
      void oldWaitPromise.then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);

      operation.complete();

      await expect(oldWaitPromise).resolves.toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("treats queued reply operations as non-abortable for compaction", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-compact",
      resetTriggered: false,
    });

    expect(isReplyRunActiveForSessionId("session-compact")).toBe(true);
    expect(isReplyRunAbortableForCompaction("session-compact")).toBe(false);

    operation.setPhase("running");

    expect(isReplyRunAbortableForCompaction("session-compact")).toBe(true);
  });

  it("mirrors active reply operations into diagnostic work state", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:telegram:direct:chat-1",
      sessionId: "session-1",
      resetTriggered: false,
    });

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-1",
        sessionKey: "agent:main:telegram:direct:chat-1",
      }).activeWorkKind,
    ).toBe("embedded_run");

    operation.updateSessionId("session-2");

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-2",
        sessionKey: "agent:main:telegram:direct:chat-1",
      }).activeWorkKind,
    ).toBe("embedded_run");

    operation.complete();

    expect(
      getDiagnosticSessionActivitySnapshot({
        sessionId: "session-2",
        sessionKey: "agent:main:telegram:direct:chat-1",
      }).activeWorkKind,
    ).toBeUndefined();
  });

  it("clears queued operations immediately on user abort", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-queued",
      resetTriggered: false,
    });

    expect(replyRunRegistry.isActive("agent:main:main")).toBe(true);

    operation.abortByUser();

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
  });

  it("runs completeThen callbacks after active state clears", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-complete",
      resetTriggered: false,
    });
    const afterClear = vi.fn(() => {
      expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
      expect(isReplyRunActiveForSessionId("session-complete")).toBe(false);
    });

    operation.completeThen(afterClear);

    expect(operation.result).toEqual({ kind: "completed" });
    expect(afterClear).toHaveBeenCalledTimes(1);
  });

  it("clears active state before a deferred after-clear barrier settles", async () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-deferred",
      resetTriggered: false,
    });
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const afterClear = vi.fn();
    runAfterReplyOperationClear(operation, afterClear);

    operation.completeWithAfterClearBarrier(barrier);

    expect(operation.result).toEqual({ kind: "completed" });
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
    expect(afterClear).not.toHaveBeenCalled();

    releaseBarrier();
    await barrier;
    await vi.waitFor(() => {
      expect(afterClear).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps later after-clear work behind earlier delivery barriers", async () => {
    const first = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "first-session",
      resetTriggered: false,
    });
    let releaseFirst: () => void = () => {};
    const firstBarrier = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstAfterClear = vi.fn();
    runAfterReplyOperationClear(first, firstAfterClear);
    first.completeWithAfterClearBarrier(firstBarrier);

    const second = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "second-session",
      resetTriggered: false,
    });
    let releaseSecond: () => void = () => {};
    const secondBarrier = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const secondAfterClear = vi.fn();
    runAfterReplyOperationClear(second, secondAfterClear);
    second.completeWithAfterClearBarrier(secondBarrier);

    releaseSecond();
    await secondBarrier;
    expect(secondAfterClear).not.toHaveBeenCalled();

    releaseFirst();
    await firstBarrier;
    await vi.waitFor(() => {
      expect(firstAfterClear).toHaveBeenCalledWith("first-session");
      expect(secondAfterClear).toHaveBeenCalledWith("second-session");
    });
  });

  it("keeps follow-up admission blocked until slow delivery settles", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "hung-session",
        resetTriggered: false,
      });
      let releaseBarrier: () => void = () => {};
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);
      operation.completeWithAfterClearBarrier(barrier, 35 * 60_000);

      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      expect(afterClear).not.toHaveBeenCalled();
      expect(() =>
        createReplyOperation({
          sessionKey: "agent:main:main",
          sessionId: "blocked-session",
          resetTriggered: false,
          respectFollowupAdmissionBarrier: true,
        }),
      ).toThrow("Reply follow-up admission is blocked");

      releaseBarrier();
      await barrier;
      await vi.waitFor(() => {
        expect(afterClear).toHaveBeenCalledWith("hung-session");
      });
      const next = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "next-session",
        resetTriggered: false,
        respectFollowupAdmissionBarrier: true,
      });
      next.complete();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("extends a hung delivery barrier only while bounded owner work remains active", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "active-owner-session",
        resetTriggered: false,
      });
      let ownerActive = true;
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);
      operation.completeWithAfterClearBarrier(new Promise<void>(() => {}), {
        maxTimeoutMs: REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS * 3,
        shouldExtend: () => ownerActive,
      });

      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      expect(afterClear).not.toHaveBeenCalled();

      ownerActive = false;
      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      await vi.waitFor(() => {
        expect(afterClear).toHaveBeenCalledWith("active-owner-session");
      });
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps follow-up admission blocked during an unsettled inter-block delay", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:mattermost:direct:user-1",
        sessionId: "mattermost-delivery-session",
        resetTriggered: false,
      });
      let settledDeliveryCount = 1;
      const queuedDeliveryCount = 2;
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);
      operation.completeWithAfterClearBarrier(new Promise<void>(() => {}), {
        maxTimeoutMs: REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS * 3,
        shouldExtend: () => settledDeliveryCount < queuedDeliveryCount,
      });

      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      expect(afterClear).not.toHaveBeenCalled();
      expect(() =>
        createReplyOperation({
          sessionKey: "agent:main:mattermost:direct:user-1",
          sessionId: "queued-followup",
          resetTriggered: false,
          respectFollowupAdmissionBarrier: true,
        }),
      ).toThrow();

      settledDeliveryCount = 2;
      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS);
      await vi.waitFor(() => {
        expect(afterClear).toHaveBeenCalledWith("mattermost-delivery-session");
      });

      const followup = createReplyOperation({
        sessionKey: "agent:main:mattermost:direct:user-1",
        sessionId: "admitted-followup",
        resetTriggered: false,
        respectFollowupAdmissionBarrier: true,
      });
      followup.complete();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("eventually releases a permanently hung delivery barrier at the default timeout", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "hung-session",
        resetTriggered: false,
      });
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);
      operation.completeWithAfterClearBarrier(new Promise<void>(() => {}));

      await vi.advanceTimersByTimeAsync(REPLY_RUN_IDLE_SETTLE_TIMEOUT_MS - 1);
      expect(afterClear).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => {
        expect(afterClear).toHaveBeenCalledWith("hung-session");
      });
      const next = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "next-session",
        resetTriggered: false,
        respectFollowupAdmissionBarrier: true,
      });
      next.complete();
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("retains failed operations until final delivery completes", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-failed",
      resetTriggered: false,
    });
    const afterClear = vi.fn();
    operation.retainFailureUntilComplete();
    runAfterReplyOperationClear(operation, afterClear);

    operation.fail("run_failed", new Error("provider failed"));

    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    expect(replyRunRegistry.get("agent:main:main")).toBe(operation);
    expect(afterClear).not.toHaveBeenCalled();

    operation.complete();

    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
    expect(afterClear).toHaveBeenCalledTimes(1);
  });

  it("keeps retained terminal failures immutable across late aborts", () => {
    const upstreamAbort = new AbortController();
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:failed-final",
      sessionId: "session-failed-final",
      resetTriggered: false,
      upstreamAbortSignal: upstreamAbort.signal,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => true,
    });
    operation.setPhase("running");
    operation.retainFailureUntilComplete();

    operation.fail("run_failed", new Error("provider failed"));
    upstreamAbort.abort(new Error("late upstream abort"));

    expect(operation.abortSignal.aborted).toBe(false);
    expect(operation.abortByUser()).toBe(false);
    expect(operation.abortForRestart()).toBe(false);
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    expect(operation.phase).toBe("failed");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("records upstream cancellation as an aborted operation", () => {
    const upstreamAbort = new AbortController();
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:upstream-cancelled",
      sessionId: "session-upstream-cancelled",
      resetTriggered: false,
      upstreamAbortSignal: upstreamAbort.signal,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");

    upstreamAbort.abort(new Error("caller cancelled"));

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(operation.phase).toBe("aborted");
    expect(operation.abortSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith("user_abort");
    operation.complete();
  });

  it("records upstream restart cancellation separately", () => {
    const upstreamAbort = new AbortController();
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:upstream-restart",
      sessionId: "session-upstream-restart",
      resetTriggered: false,
      upstreamAbortSignal: upstreamAbort.signal,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");

    upstreamAbort.abort(createAgentRunRestartAbortError());

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(operation.phase).toBe("aborted");
    expect(operation.abortSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith("restart");
    operation.complete();
  });

  it("clears queued ownership when the upstream signal is already aborted", () => {
    const upstreamAbort = new AbortController();
    upstreamAbort.abort(new Error("caller already cancelled"));

    const operation = createReplyOperation({
      sessionKey: "agent:main:already-cancelled",
      sessionId: "session-already-cancelled",
      resetTriggered: false,
      upstreamAbortSignal: upstreamAbort.signal,
    });

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(operation.phase).toBe("aborted");
    expect(operation.abortSignal.aborted).toBe(true);
    expect(replyRunRegistry.isActive("agent:main:already-cancelled")).toBe(false);
  });

  it("does not cancel the backend twice when upstream abort follows a user abort", () => {
    const upstreamAbort = new AbortController();
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:duplicate-cancel",
      sessionId: "session-duplicate-cancel",
      resetTriggered: false,
      upstreamAbortSignal: upstreamAbort.signal,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => true,
    });
    operation.setPhase("running");

    expect(operation.abortByUser()).toBe(true);
    upstreamAbort.abort(createAgentRunRestartAbortError());

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith("user_abort");
    operation.complete();
  });

  it("force-releases a running aborted operation when the owner never returns", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const operation = createReplyOperation({
        sessionKey: "agent:main:hung-abort",
        sessionId: "session-hung-abort",
        resetTriggered: false,
      });
      operation.attachBackend({
        kind: "embedded",
        cancel,
        isStreaming: () => true,
      });
      operation.setPhase("running");
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);
      const waitPromise = replyRunRegistry.waitForIdle("agent:main:hung-abort");

      operation.abortByUser();

      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS - 1);
      expect(replyRunRegistry.get("agent:main:hung-abort")).toBe(operation);
      expect(afterClear).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);

      expect(replyRunRegistry.get("agent:main:hung-abort")).toBeUndefined();
      await expect(waitPromise).resolves.toBe(true);
      expect(afterClear).toHaveBeenCalledTimes(1);
      const next = await admitReplyTurn({
        sessionKey: "agent:main:hung-abort",
        sessionId: "session-after-hung-abort",
        kind: "visible",
        resetTriggered: false,
      });
      expect(next.status).toBe("owned");
      if (next.status === "owned") {
        next.operation.complete();
      }
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps late owner complete harmless after forced terminal release", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:late-complete",
        sessionId: "session-late-complete",
        resetTriggered: false,
      });
      operation.setPhase("running");
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);

      operation.abortByUser();
      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);
      operation.complete();

      expect(replyRunRegistry.isActive("agent:main:late-complete")).toBe(false);
      expect(afterClear).toHaveBeenCalledTimes(1);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("force-releases retained failures when the owner never completes", async () => {
    vi.useFakeTimers();
    try {
      const operation = createReplyOperation({
        sessionKey: "agent:main:retained-hung-failure",
        sessionId: "session-retained-hung-failure",
        resetTriggered: false,
      });
      operation.retainFailureUntilComplete();
      const afterClear = vi.fn();
      runAfterReplyOperationClear(operation, afterClear);

      operation.fail("run_failed", new Error("delivery payload pending"));
      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);

      expect(replyRunRegistry.get("agent:main:retained-hung-failure")).toBeUndefined();
      expect(afterClear).toHaveBeenCalledTimes(1);
      expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("keeps run_stalled attribution when backend cancel re-enters abortByUser", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:reentrant-expire",
      sessionId: "reentrant-session",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      // Mirrors the run loop's abort handler: backend cancellation propagates
      // synchronously back into a user-shaped abort on the same operation.
      cancel: () => {
        operation.abortByUser();
      },
      isStreaming: () => true,
    });
    operation.setPhase("running");

    expect(expireStaleReplyOperation(operation, "no_activity")).toBe(true);
    expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
    expect(replyRunRegistry.get("agent:main:reentrant-expire")).toBeUndefined();
  });

  it("cancels terminal settle when the owner clears state first", async () => {
    vi.useFakeTimers();
    try {
      const warnSpy = vi.spyOn(diagnosticLogger, "warn").mockImplementation(() => undefined);
      const operation = createReplyOperation({
        sessionKey: "agent:main:owner-clears",
        sessionId: "session-owner-clears",
        resetTriggered: false,
      });
      operation.setPhase("running");

      operation.abortByUser();
      operation.complete();
      await vi.advanceTimersByTimeAsync(REPLY_RUN_TERMINAL_SETTLE_TIMEOUT_MS);

      expect(replyRunRegistry.isActive("agent:main:owner-clears")).toBe(false);
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("reply run terminal settle: forced release"),
      );
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("force-clears retained failed operations", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-retained",
      resetTriggered: false,
    });
    operation.retainFailureUntilComplete();

    expect(forceClearReplyRunBySessionId("session-retained", new Error("stuck"))).toBe(true);
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    expect(replyRunRegistry.isActive("agent:main:main")).toBe(false);
  });

  it("force-clears a running operation after abort without backend cleanup", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "session-running",
        resetTriggered: false,
      });
      operation.attachBackend({
        kind: "embedded",
        cancel,
        isStreaming: () => true,
      });
      operation.setPhase("running");

      operation.abortByUser();
      const waitPromise = waitForReplyRunEndBySessionId("session-running", 1_000);

      expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
      expect(cancel).toHaveBeenCalledWith("user_abort");
      expect(isReplyRunActiveForSessionId("session-running")).toBe(true);

      expect(forceClearReplyRunBySessionId("session-running", new Error("stuck"))).toBe(true);

      expect(isReplyRunActiveForSessionId("session-running")).toBe(false);
      await expect(waitPromise).resolves.toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("rejects aborts while the attached backend is finalizing", () => {
    let abortable = false;
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:finalizing",
      sessionId: "session-finalizing",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => abortable,
    });
    operation.setPhase("running");

    expect(replyRunRegistry.abort("agent:main:finalizing")).toBe(false);
    expect(abortActiveReplyRuns({ mode: "all" })).toBe(false);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    abortable = true;
    expect(replyRunRegistry.abort("agent:main:finalizing")).toBe(true);
    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
    expect(cancel).toHaveBeenCalledWith("user_abort");
  });

  it("keeps finalizing reply bookkeeping through forced in-process restart", () => {
    const cancel = vi.fn();
    const operation = createReplyOperation({
      sessionKey: "agent:main:restart-finalizing",
      sessionId: "session-restart-finalizing",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      cancel,
      isStreaming: () => false,
      isAbortable: () => false,
    });
    operation.setPhase("running");

    expect(abortActiveReplyRuns({ mode: "all" })).toBe(false);
    expect(replyRunRegistry.isActive("agent:main:restart-finalizing")).toBe(true);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    operation.complete();
    expect(replyRunRegistry.isActive("agent:main:restart-finalizing")).toBe(false);
  });

  it("keeps abort frozen after the backend detaches for reply delivery", () => {
    const cancel = vi.fn();
    const upstreamAbort = new AbortController();
    const operation = createReplyOperation({
      sessionKey: "agent:main:delivery-finalizing",
      sessionId: "session-delivery-finalizing",
      resetTriggered: false,
      upstreamAbortSignal: upstreamAbort.signal,
    });
    const backend = {
      kind: "embedded" as const,
      cancel,
      isStreaming: () => false,
      isAbortable: () => false,
    };
    operation.attachBackend(backend);
    operation.setPhase("running");
    operation.freezeAbort();
    operation.detachBackend(backend);

    expect(isReplyRunAbortableForSignal(upstreamAbort.signal)).toBe(false);
    expect(isReplyRunAbortableForSignal(new AbortController().signal)).toBe(true);
    expect(replyRunRegistry.abort("agent:main:delivery-finalizing")).toBe(false);
    expect(operation.result).toBeNull();
    expect(cancel).not.toHaveBeenCalled();

    upstreamAbort.abort();
    expect(operation.abortSignal.aborted).toBe(false);

    operation.complete();
    expect(replyRunRegistry.isActive("agent:main:delivery-finalizing")).toBe(false);
    expect(isReplyRunAbortableForSignal(upstreamAbort.signal)).toBe(false);
  });

  it("clamps oversized wait timers instead of resolving idle waits immediately", async () => {
    vi.useFakeTimers();
    try {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "session-running",
        resetTriggered: false,
      });

      const waitPromise = waitForReplyRunEndBySessionId(
        "session-running",
        MAX_TIMER_TIMEOUT_MS + 1,
      );

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      operation.complete();
      await expect(waitPromise).resolves.toBe(true);
    } finally {
      await vi.runOnlyPendingTimersAsync();
      vi.useRealTimers();
    }
  });

  it("queues messages only through the active running backend", () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-running",
      resetTriggered: false,
    });

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      queueMessage,
    });

    expect(queueReplyRunMessage("session-running", "before running")).toBe(false);

    operation.setPhase("running");

    expect(queueReplyRunMessage("session-running", "hello")).toBe(true);
    expect(queueMessage).toHaveBeenCalledWith("hello");
  });

  it("queues messages only when the task-suggestion tool surface matches", () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-task-suggestions",
      resetTriggered: false,
    });
    operation.attachBackend({
      kind: "embedded",
      taskSuggestionDeliveryMode: "gateway",
      cancel: vi.fn(),
      isStreaming: () => true,
      queueMessage,
    });
    operation.setPhase("running");

    expect(
      queueReplyRunMessage("session-task-suggestions", "legacy client", {
        taskSuggestionDeliveryMode: undefined,
      }),
    ).toBe(false);
    expect(
      queueReplyRunMessage("session-task-suggestions", "capable client", {
        taskSuggestionDeliveryMode: "gateway",
      }),
    ).toBe(true);
    expect(queueReplyRunMessage("session-task-suggestions", "internal completion")).toBe(true);
    expect(queueMessage).toHaveBeenCalledTimes(2);
    expect(queueMessage).toHaveBeenNthCalledWith(1, "capable client", {
      taskSuggestionDeliveryMode: "gateway",
    });
    expect(queueMessage).toHaveBeenNthCalledWith(2, "internal completion");
  });

  it("queues messages through active non-streaming backends with live stopped state", () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-running",
      resetTriggered: false,
    });

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => false,
      isStopped: () => false,
      queueMessage,
    });
    operation.setPhase("running");

    expect(queueReplyRunMessage("session-running", "hello")).toBe(true);
    expect(queueMessage).toHaveBeenCalledWith("hello");
  });

  it("refuses stale reply-run steering until real activity resumes", () => {
    vi.useFakeTimers();
    try {
      const queueMessage = vi.fn(async () => {});
      const operation = createReplyOperation({
        sessionKey: "agent:main:main",
        sessionId: "session-running",
        resetTriggered: false,
      });
      operation.attachBackend({
        kind: "embedded",
        cancel: vi.fn(),
        isStreaming: () => true,
        queueMessage,
      });
      operation.setPhase("running");

      vi.advanceTimersByTime(RUN_STALE_TAKEOVER_MS + 1);

      expect(queueReplyRunMessage("session-running", "stale")).toBe(false);
      expect(queueMessage).not.toHaveBeenCalled();

      operation.recordActivity();

      expect(queueReplyRunMessage("session-running", "fresh")).toBe(true);
      expect(queueMessage).toHaveBeenCalledWith("fresh");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not queue messages through stopped backends", () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-running",
      resetTriggered: false,
    });

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      isStopped: () => true,
      queueMessage,
    });
    operation.setPhase("running");

    expect(queueReplyRunMessage("session-running", "hello")).toBe(false);
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("fails closed when backend stopped state checks throw", () => {
    const queueMessage = vi.fn(async () => {});
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-running",
      resetTriggered: false,
    });

    operation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      isStreaming: () => true,
      isStopped: () => {
        throw new Error("bad stopped state");
      },
      queueMessage,
    });
    operation.setPhase("running");

    expect(queueReplyRunMessage("session-running", "hello")).toBe(false);
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("aborts compacting runs through the registry compatibility helper", () => {
    const compactingOperation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-compacting",
      resetTriggered: false,
    });
    compactingOperation.setPhase("preflight_compacting");

    const runningOperation = createReplyOperation({
      sessionKey: "agent:main:other",
      sessionId: "session-running",
      resetTriggered: false,
    });
    runningOperation.setPhase("running");

    expect(abortActiveReplyRuns({ mode: "compacting" })).toBe(true);
    expect(compactingOperation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
    expect(runningOperation.result).toBeNull();
  });
});
