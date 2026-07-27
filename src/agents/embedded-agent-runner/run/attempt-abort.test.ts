// Coverage for external cancellation, timeout, and session-lock release paths.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedAgentQueueHandle } from "../runs.js";
import {
  createEmbeddedAttemptExternalAbortController,
  createEmbeddedAttemptRunAbort,
  type EmbeddedAttemptAbortStatePort,
} from "./attempt-abort.js";

const mocks = vi.hoisted(() => ({
  countActiveToolExecutions: vi.fn(() => 0),
  markActiveEmbeddedRunAbandoned: vi.fn(),
}));

vi.mock("../../embedded-agent-subscribe.handlers.tools.js", () => ({
  countActiveToolExecutions: mocks.countActiveToolExecutions,
}));

vi.mock("../runs.js", () => ({
  markActiveEmbeddedRunAbandoned: mocks.markActiveEmbeddedRunAbandoned,
}));

function createAbortState() {
  let timedOutDuringCompaction = false;
  const markAborted = vi.fn();
  const markExternalAbort = vi.fn();
  const markTimedOut = vi.fn();
  const markTimedOutDuringCompaction = vi.fn(() => {
    timedOutDuringCompaction = true;
  });
  const markTimedOutDuringToolExecution = vi.fn();
  const readTimedOutDuringCompaction = vi.fn(() => timedOutDuringCompaction);
  const setPromptError = vi.fn();
  const port: EmbeddedAttemptAbortStatePort = {
    markAborted,
    markExternalAbort,
    markTimedOut,
    markTimedOutDuringCompaction,
    markTimedOutDuringToolExecution,
    readTimedOutDuringCompaction,
    setPromptError,
  };
  return {
    port,
    markAborted,
    markExternalAbort,
    markTimedOut,
    markTimedOutDuringCompaction,
    markTimedOutDuringToolExecution,
    setPromptError,
  };
}

beforeEach(() => {
  mocks.countActiveToolExecutions.mockReset().mockReturnValue(0);
  mocks.markActiveEmbeddedRunAbandoned.mockReset();
});

describe("createEmbeddedAttemptExternalAbortController", () => {
  it("aborts setup state before the live run handler is installed", () => {
    const source = new AbortController();
    const runAbortController = new AbortController();
    const state = createAbortState();
    const abortActiveSession = vi.fn(async () => {});
    const controller = createEmbeddedAttemptExternalAbortController({
      abortSignal: source.signal,
      cleanupAfterEarlyAbort: vi.fn(async () => {}),
      runAbortController,
      runId: "run-external",
      state: state.port,
    });
    controller.setActiveSessionAbort(abortActiveSession);
    controller.arm();
    const reason = new Error("cancelled");

    source.abort(reason);

    expect(state.markExternalAbort).toHaveBeenCalledTimes(1);
    expect(state.markAborted).toHaveBeenCalledTimes(1);
    expect(state.setPromptError).toHaveBeenCalledWith(reason);
    expect(runAbortController.signal.reason).toBe(reason);
    expect(abortActiveSession).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("classifies timeout during compaction without also blaming a tool", () => {
    const source = new AbortController();
    const runAbortController = new AbortController();
    const state = createAbortState();
    mocks.countActiveToolExecutions.mockReturnValue(1);
    const controller = createEmbeddedAttemptExternalAbortController({
      abortSignal: source.signal,
      cleanupAfterEarlyAbort: vi.fn(async () => {}),
      runAbortController,
      runId: "run-compaction-timeout",
      state: state.port,
    });
    controller.setCompactionState({
      isPendingOrRetrying: () => true,
      isInFlight: () => false,
    });
    controller.arm();
    const reason = new Error("deadline");
    reason.name = "TimeoutError";

    source.abort(reason);

    expect(state.markTimedOutDuringCompaction).toHaveBeenCalledTimes(1);
    expect(state.markTimedOut).toHaveBeenCalledTimes(1);
    expect(state.markTimedOutDuringToolExecution).not.toHaveBeenCalled();
    expect(runAbortController.signal.reason).toBe(reason);
    controller.dispose();
  });

  it("hands cancellation to the live run handler once installed", () => {
    const source = new AbortController();
    const state = createAbortState();
    const abortRun = vi.fn();
    const controller = createEmbeddedAttemptExternalAbortController({
      abortSignal: source.signal,
      cleanupAfterEarlyAbort: vi.fn(async () => {}),
      runAbortController: new AbortController(),
      runId: "run-live",
      state: state.port,
    });
    controller.setRunAbort(abortRun);
    controller.arm();
    const reason = new Error("cancelled live run");

    source.abort(reason);

    expect(state.markExternalAbort).toHaveBeenCalledTimes(1);
    expect(abortRun).toHaveBeenCalledWith(false, reason);
    expect(state.markAborted).not.toHaveBeenCalled();
    expect(state.setPromptError).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("cleans prepared resources before rejecting a pre-fired signal", async () => {
    const source = new AbortController();
    const reason = new Error("cancelled during setup");
    source.abort(reason);
    const cleanupAfterEarlyAbort = vi.fn(async () => {});
    const state = createAbortState();
    const controller = createEmbeddedAttemptExternalAbortController({
      abortSignal: source.signal,
      cleanupAfterEarlyAbort,
      runAbortController: new AbortController(),
      runId: "run-setup",
      state: state.port,
    });

    await expect(controller.throwIfFiredAfterPrepCleanup()).rejects.toBe(reason);

    expect(cleanupAfterEarlyAbort).toHaveBeenCalledTimes(1);
    expect(state.markAborted).toHaveBeenCalledTimes(1);
    expect(state.markExternalAbort).toHaveBeenCalledTimes(1);
    expect(state.setPromptError).toHaveBeenCalledWith(reason);
  });
});

describe("createEmbeddedAttemptRunAbort", () => {
  it("settles timeout state, session work, queue ownership, and the lock", async () => {
    const state = createAbortState();
    const timeoutReason = new Error("attempt deadline");
    timeoutReason.name = "TimeoutError";
    const abortCompaction = vi.fn();
    const abortActiveSession = vi.fn(async () => {});
    const onAttemptTimeout = vi.fn();
    const releaseHeldLockForAbort = vi.fn(async () => {});
    const queueHandle = {} as EmbeddedAgentQueueHandle;
    const runAbortController = new AbortController();
    mocks.countActiveToolExecutions.mockReturnValue(1);
    const abortRun = createEmbeddedAttemptRunAbort({
      abortActiveSession,
      activeSession: { abortCompaction, isCompacting: true },
      attempt: {
        onAttemptTimeout,
        runId: "run-timeout",
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-timeout",
        sessionKey: "agent:main",
      },
      getQueueHandle: () => queueHandle,
      isProbeSession: false,
      log: { warn: vi.fn() },
      runAbortController,
      sessionLockController: { releaseHeldLockForAbort },
      state: state.port,
    });

    abortRun(true, timeoutReason);
    await Promise.resolve();

    expect(state.markAborted).toHaveBeenCalledTimes(1);
    expect(state.markTimedOut).toHaveBeenCalledTimes(1);
    expect(state.markTimedOutDuringToolExecution).toHaveBeenCalledTimes(1);
    expect(onAttemptTimeout).toHaveBeenCalledWith(timeoutReason);
    expect(runAbortController.signal.reason).toBe(timeoutReason);
    expect(abortCompaction).toHaveBeenCalledTimes(1);
    expect(abortActiveSession).toHaveBeenCalledTimes(1);
    expect(mocks.markActiveEmbeddedRunAbandoned).toHaveBeenCalledWith({
      sessionId: "session-timeout",
      handle: queueHandle,
      sessionKey: "agent:main",
      sessionFile: "/tmp/session.jsonl",
      reason: "timeout",
    });
    expect(releaseHeldLockForAbort).toHaveBeenCalledTimes(1);
  });

  it("logs lock release failures without replacing the manual abort reason", async () => {
    // Abort cleanup must not replace the original timeout/manual-abort reason
    // with a secondary lock-release failure.
    const state = createAbortState();
    const abortReason = new Error("manual abort");
    const releaseError = new Error("locked");
    const releaseHeldLockForAbort = vi.fn(async () => {
      throw releaseError;
    });
    const warn = vi.fn();
    const runAbortController = new AbortController();
    const abortRun = createEmbeddedAttemptRunAbort({
      abortActiveSession: vi.fn(async () => {}),
      activeSession: { abortCompaction: vi.fn(), isCompacting: false },
      attempt: {
        onAttemptTimeout: vi.fn(),
        runId: "run-manual",
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-manual",
        sessionKey: "agent:main",
      },
      getQueueHandle: () => undefined,
      isProbeSession: false,
      log: { warn },
      runAbortController,
      sessionLockController: { releaseHeldLockForAbort },
      state: state.port,
    });

    abortRun(false, abortReason);

    await Promise.resolve();
    await Promise.resolve();

    expect(runAbortController.signal.reason).toBe(abortReason);
    expect(releaseHeldLockForAbort).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "failed to release session lock on abort: runId=run-manual Error: locked",
    );
  });
});
