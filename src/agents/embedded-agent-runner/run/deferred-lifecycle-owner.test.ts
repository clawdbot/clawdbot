import { afterEach, describe, expect, it, vi } from "vitest";
import { createReplyOperation } from "../../../auto-reply/reply/reply-run-registry.js";
import {
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
} from "../../run-termination.js";
import {
  abortEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunActive,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../runs.js";
import {
  createDeferredEmbeddedRunLifecycleManager,
  createEmbeddedAttemptDeferredLifecycleOwner,
} from "./deferred-lifecycle-owner.js";

function runHandle(runId: string): EmbeddedAgentQueueHandle {
  return {
    runId,
    queueMessage: async () => undefined,
    isStreaming: () => true,
    isCompacting: () => false,
    abort: vi.fn(),
  };
}

describe("deferred logical-turn lifecycle", () => {
  const sessionId = "deferred-lifecycle-session";
  const sessionKey = "agent:main:deferred-lifecycle";
  const handles: EmbeddedAgentQueueHandle[] = [];

  afterEach(() => {
    for (const handle of handles) {
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    }
    handles.length = 0;
  });

  it.each([false, true])(
    "publishes CLI cancellation authority before releasing the embedded attempt (reply owner: %s)",
    async (withReplyOperation) => {
      const operation = withReplyOperation
        ? createReplyOperation({ sessionId, sessionKey, resetTriggered: false })
        : undefined;
      operation?.setPhase("running");
      const embeddedHandle = runHandle("logical-run");
      handles.push(embeddedHandle);
      setActiveEmbeddedRun(sessionId, embeddedHandle, sessionKey);
      const clearEmbedded = vi.fn(() =>
        clearActiveEmbeddedRun(sessionId, embeddedHandle, sessionKey),
      );
      const manager = createDeferredEmbeddedRunLifecycleManager({
        runId: "logical-run",
        sessionId,
        sessionKey,
        abortSignal: operation?.abortSignal,
        replyOperation: operation,
      });
      manager.adopt({ complete: async () => clearEmbedded(), discard: clearEmbedded });

      try {
        manager.handoffToCli();

        expect(clearEmbedded).toHaveBeenCalledOnce();
        expect(isEmbeddedAgentRunActive(sessionId)).toBe(true);
        expect(abortEmbeddedAgentRun(sessionId)).toBe(true);
        expect(manager.signal.aborted).toBe(true);
        if (operation) {
          expect(operation.result).toEqual({ kind: "aborted", code: "aborted_by_user" });
          expect(manager.signal.reason).toBe(operation.abortSignal.reason);
        }
        await manager.complete();
        // Reply registration remains owned by outer cleanup after the native handle is released.
        expect(isEmbeddedAgentRunActive(sessionId)).toBe(withReplyOperation);
        operation?.complete();
        expect(isEmbeddedAgentRunActive(sessionId)).toBe(false);
      } finally {
        await manager.complete();
        operation?.complete();
      }
    },
  );

  it("does not let a retired reply owner cancel its same-key successor", async () => {
    const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
    operation.setPhase("running");
    const manager = createDeferredEmbeddedRunLifecycleManager({
      runId: "logical-run",
      sessionId,
      sessionKey,
      abortSignal: operation.abortSignal,
      replyOperation: operation,
    });
    operation.complete();
    const current = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
    const cancel = vi.fn();
    current.setPhase("running");
    current.attachBackend({ kind: "cli", cancel });
    try {
      manager.abort("restart");
      expect(current.result).toBeNull();
      expect(current.abortSignal.aborted).toBe(false);
      expect(cancel).not.toHaveBeenCalled();
      expect(operation.result).toEqual({ kind: "completed" });
    } finally {
      await manager.complete();
      current.complete();
      operation.complete();
    }
  });

  it.each(["user_abort", "restart", "superseded"] as const)(
    "preserves frozen reply ownership on %s",
    async (reason) => {
      const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
      operation.setPhase("running");
      operation.freezeAbort();
      const manager = createDeferredEmbeddedRunLifecycleManager({
        runId: "logical-run",
        sessionId,
        sessionKey,
        abortSignal: operation.abortSignal,
        replyOperation: operation,
      });
      try {
        manager.abort(reason);
        expect(operation.result).toEqual(
          reason === "superseded" ? { kind: "aborted", code: "aborted_for_supersession" } : null,
        );
        expect(operation.abortSignal.aborted).toBe(false);
        expect(manager.signal.aborted).toBe(true);
        if (reason === "restart") {
          expect(isAgentRunRestartAbortReason(manager.signal.reason)).toBe(true);
        } else if (reason === "superseded") {
          expect(isAgentRunSupersededAbortReason(manager.signal.reason)).toBe(true);
        }
        const firstReason = manager.signal.reason;
        manager.abort(reason === "restart" ? "user_abort" : "restart");
        expect(manager.signal.reason).toBe(firstReason);
      } finally {
        await manager.complete();
        operation.complete();
      }
    },
  );

  it("records only the accepted candidate terminal trajectory", async () => {
    const recordEvent = vi.fn();
    const flush = vi.fn(async () => undefined);
    const clearActiveRun = vi.fn();
    const discarded = createEmbeddedAttemptDeferredLifecycleOwner({
      runId: "logical-run",
      sessionId,
      trajectoryRecorder: { recordEvent, flush, describeFlushState: () => undefined },
      clearActiveRun,
    });
    discarded.recordSessionEnd({ status: "error" });
    discarded.discard();
    expect(recordEvent).not.toHaveBeenCalled();

    const accepted = createEmbeddedAttemptDeferredLifecycleOwner({
      runId: "logical-run",
      sessionId,
      trajectoryRecorder: { recordEvent, flush, describeFlushState: () => undefined },
      clearActiveRun,
    });
    accepted.recordSessionEnd({ status: "success" });
    await accepted.complete();

    expect(recordEvent).toHaveBeenCalledOnce();
    expect(recordEvent).toHaveBeenCalledWith("session.ended", { status: "success" });
    expect(flush).toHaveBeenCalledOnce();
    expect(clearActiveRun).toHaveBeenCalledTimes(2);
  });
});
