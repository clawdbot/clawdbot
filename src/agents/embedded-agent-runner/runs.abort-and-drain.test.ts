import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createReplyOperation,
  isReplyRunActiveForSessionId,
} from "../../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import {
  abortAndDrainEmbeddedAgentRun,
  clearActiveEmbeddedRun,
  isEmbeddedAgentRunHandleActive,
  setActiveEmbeddedRun,
} from "./runs.js";
import { testing } from "./runs.test-support.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(abort: () => void): RunHandle {
  return {
    abort,
    isCompacting: () => false,
    isStreaming: () => true,
    queueMessage: async () => {},
  };
}

describe("abortAndDrainEmbeddedAgentRun", () => {
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    vi.useRealTimers();
  });

  it("does not abort or force-clear a replacement run during stuck recovery", async () => {
    vi.useFakeTimers();
    const staleAbort = vi.fn();
    const replacementAbort = vi.fn();
    const staleHandle = createRunHandle(staleAbort);
    const replacementHandle = createRunHandle(replacementAbort);
    setActiveEmbeddedRun("session-replaced-during-recovery", staleHandle, "agent:main");
    staleAbort.mockImplementation(() => {
      setActiveEmbeddedRun("session-replaced-during-recovery", replacementHandle, "agent:main");
      clearActiveEmbeddedRun("session-replaced-during-recovery", staleHandle, "agent:main");
    });

    const resultPromise = abortAndDrainEmbeddedAgentRun({
      sessionId: "session-replaced-during-recovery",
      sessionKey: "agent:main",
      settleMs: 100,
      forceClear: true,
      reason: "stuck_recovery",
    });
    await vi.advanceTimersByTimeAsync(100);

    await expect(resultPromise).resolves.toEqual({
      aborted: true,
      drained: true,
      forceCleared: false,
    });
    expect(staleAbort).toHaveBeenCalledOnce();
    expect(replacementAbort).not.toHaveBeenCalled();
    expect(isEmbeddedAgentRunHandleActive("session-replaced-during-recovery")).toBe(true);
  });

  it("does not report a replaced handle drained before its owner clears", async () => {
    vi.useFakeTimers();
    const sessionId = "session-replaced-before-old-owner-clears";
    const sessionKey = "agent:replaced-before-old-owner-clears";
    const replacementHandle = createRunHandle(vi.fn());
    const staleHandle = createRunHandle(() => {
      setActiveEmbeddedRun(sessionId, replacementHandle, sessionKey);
    });
    setActiveEmbeddedRun(sessionId, staleHandle, sessionKey);

    const resultPromise = abortAndDrainEmbeddedAgentRun({
      sessionId,
      sessionKey,
      settleMs: 100,
      forceClear: true,
      reason: "stuck_recovery",
    });
    await vi.advanceTimersByTimeAsync(100);

    await expect(resultPromise).resolves.toEqual({
      aborted: true,
      drained: false,
      forceCleared: false,
    });
    expect(isEmbeddedAgentRunHandleActive(sessionId)).toBe(true);
  });

  it("waits for the captured reply operation after its embedded handle clears", async () => {
    vi.useFakeTimers();
    const sessionId = "session-reply-owner-still-active";
    const sessionKey = "agent:reply-owner-still-active";
    const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
    operation.setPhase("running");
    const handle = createRunHandle(() => {
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    });
    setActiveEmbeddedRun(sessionId, handle, sessionKey);

    const resultPromise = abortAndDrainEmbeddedAgentRun({
      sessionId,
      sessionKey,
      settleMs: 100,
      forceClear: true,
      reason: "cron_timeout",
    });
    await vi.advanceTimersByTimeAsync(100);

    await expect(resultPromise).resolves.toEqual({
      aborted: true,
      drained: false,
      forceCleared: true,
    });
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(false);
    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
  });

  it("force-clears a reply-only cron timeout without recording a user abort", async () => {
    const sessionId = "session-reply-only-cron-timeout";
    const sessionKey = "agent:reply-only-cron-timeout";
    const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
    operation.setPhase("running");

    await expect(
      abortAndDrainEmbeddedAgentRun({
        sessionId,
        sessionKey,
        forceClear: true,
        reason: "cron_timeout",
      }),
    ).resolves.toEqual({
      aborted: false,
      drained: false,
      forceCleared: true,
    });

    expect(operation.result).toMatchObject({ kind: "failed", code: "run_failed" });
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(false);
  });

  it("aborts a reply-only run without force-clear as a restart", async () => {
    const sessionId = "session-reply-only-abort";
    const sessionKey = "agent:reply-only-abort";
    const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
    operation.setPhase("running");

    await expect(
      abortAndDrainEmbeddedAgentRun({
        sessionId,
        sessionKey,
        settleMs: 0,
        reason: "test_timeout",
      }),
    ).resolves.toEqual({
      aborted: true,
      drained: false,
      forceCleared: false,
    });

    expect(operation.result).toEqual({ kind: "aborted", code: "aborted_for_restart" });
  });

  it("does not force-clear a replacement reply operation", async () => {
    vi.useFakeTimers();
    const sessionId = "session-replacement-reply-operation";
    const sessionKey = "agent:replacement-reply-operation";
    const originalOperation = createReplyOperation({
      sessionId,
      sessionKey,
      resetTriggered: false,
    });
    originalOperation.setPhase("running");
    let replacementOperation: ReturnType<typeof createReplyOperation> | undefined;
    const handle = createRunHandle(() => {
      originalOperation.complete();
      replacementOperation = createReplyOperation({
        sessionId,
        sessionKey,
        resetTriggered: false,
      });
      replacementOperation.setPhase("running");
    });
    setActiveEmbeddedRun(sessionId, handle, sessionKey);

    const resultPromise = abortAndDrainEmbeddedAgentRun({
      sessionId,
      sessionKey,
      settleMs: 100,
      forceClear: true,
      reason: "cron_timeout",
    });
    await vi.advanceTimersByTimeAsync(100);

    await expect(resultPromise).resolves.toEqual({
      aborted: true,
      drained: false,
      forceCleared: true,
    });
    expect(replacementOperation?.result).toBeNull();
    expect(isReplyRunActiveForSessionId(sessionId)).toBe(true);
  });
});
