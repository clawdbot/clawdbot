// Coverage for external cancellation and timeout paths.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddedAgentQueueHandle } from "../runs.js";
import {
  createEmbeddedAttemptExternalAbortController,
  createEmbeddedAttemptRunAbort,
  type EmbeddedAttemptAbortStatePort,
} from "./attempt-finalize.js";
import { createEmbeddedAttemptSessionSettleTracker } from "./attempt-session-settle.js";
import { prepareEmbeddedAttemptTimeout } from "./attempt-timeout-prepare.js";

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

function createTrackedSessionAbort() {
  const abort = vi.fn(async (_reason?: unknown) => {});
  const tracker = createEmbeddedAttemptSessionSettleTracker({ abort });
  return { abort, tracker };
}

beforeEach(() => {
  mocks.countActiveToolExecutions.mockReset().mockReturnValue(0);
  mocks.markActiveEmbeddedRunAbandoned.mockReset();
});

describe("createEmbeddedAttemptExternalAbortController", () => {
  it("preserves external cancellation through active session settlement", async () => {
    const source = new AbortController();
    const runAbortController = new AbortController();
    const state = createAbortState();
    const session = createTrackedSessionAbort();
    const controller = createEmbeddedAttemptExternalAbortController({
      abortSignal: source.signal,
      cleanupAfterEarlyAbort: vi.fn(async () => {}),
      runAbortController,
      runId: "run-external",
      state: state.port,
    });
    controller.setActiveSessionAbort(session.tracker.abortActiveSession);
    controller.arm();
    const reason = new Error("cancelled");

    source.abort(reason);

    expect(state.markExternalAbort).toHaveBeenCalledTimes(1);
    expect(state.markAborted).toHaveBeenCalledTimes(1);
    expect(state.setPromptError).toHaveBeenCalledWith(reason);
    expect(runAbortController.signal.reason).toBe(reason);
    expect(session.abort).toHaveBeenCalledExactlyOnceWith(reason);
    await session.tracker.buildAbortSettlePromise();
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

  it("hands an external timeout to the live attempt exactly once", async () => {
    const source = new AbortController();
    const runAbortController = new AbortController();
    const state = createAbortState();
    const session = createTrackedSessionAbort();
    const onAttemptTimeout = vi.fn();
    const attempt = {
      abortSignal: source.signal,
      onAttemptTimeout,
      runId: "run-external-timeout",
      sessionFile: "agent:main:main",
      sessionId: "session-external-timeout",
      sessionKey: "agent:main:main",
      timeoutMs: 60_000,
    };
    const controller = createEmbeddedAttemptExternalAbortController({
      abortSignal: source.signal,
      cleanupAfterEarlyAbort: vi.fn(async () => {}),
      runAbortController,
      runId: attempt.runId,
      state: state.port,
    });
    const abortRun = createEmbeddedAttemptRunAbort({
      abortActiveSession: session.tracker.abortActiveSession,
      activeSession: { abortCompaction: vi.fn(), isCompacting: false },
      attempt,
      getQueueHandle: () => ({}) as EmbeddedAgentQueueHandle,
      isProbeSession: true,
      log: { warn: vi.fn() },
      runAbortController,
      state: state.port,
    });
    controller.setRunAbort(abortRun);
    controller.setCompactionState({
      isPendingOrRetrying: () => false,
      isInFlight: () => false,
    });
    controller.arm();
    const timeout = prepareEmbeddedAttemptTimeout({
      attempt,
      activeSession: { isCompacting: false, isStreaming: false },
      compactionState: { isCompacting: () => false },
      compactionTimeoutMs: 1_000,
      isProbeSession: true,
      abortRun,
      markTimedOutDuringCompaction: state.markTimedOutDuringCompaction,
      markTimedOutByRunBudget: vi.fn(),
    });

    try {
      const reason = new Error("upstream request timed out");
      reason.name = "TimeoutError";
      source.abort(reason);
      await session.tracker.buildAbortSettlePromise();

      expect(state.markExternalAbort).toHaveBeenCalledOnce();
      expect(state.markAborted).toHaveBeenCalledOnce();
      expect(state.markTimedOut).toHaveBeenCalledOnce();
      expect(onAttemptTimeout).toHaveBeenCalledOnce();
      expect(session.abort).toHaveBeenCalledExactlyOnceWith(reason);
      expect(mocks.markActiveEmbeddedRunAbandoned).toHaveBeenCalledOnce();
    } finally {
      timeout.clearTimers();
      controller.dispose();
    }
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
  it("settles timeout state, session work, and queue ownership", async () => {
    const state = createAbortState();
    const timeoutReason = new Error("attempt deadline");
    timeoutReason.name = "TimeoutError";
    const abortCompaction = vi.fn();
    const abortActiveSession = vi.fn(async () => {});
    const onAttemptTimeout = vi.fn();
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
  });

  it("preserves a manual abort reason", () => {
    const abortReason = new Error("manual abort");
    const runAbortController = new AbortController();
    const abortRun = createEmbeddedAttemptRunAbort({
      abortActiveSession: vi.fn(async () => {}),
      activeSession: { abortCompaction: vi.fn(), isCompacting: false },
      attempt: {
        runId: "run-manual",
        sessionFile: "/tmp/session.jsonl",
        sessionId: "session-manual",
        sessionKey: "agent:main",
      },
      getQueueHandle: () => undefined,
      isProbeSession: false,
      log: { warn: vi.fn() },
      runAbortController,
      state: createAbortState().port,
    });

    abortRun(false, abortReason);

    expect(runAbortController.signal.reason).toBe(abortReason);
  });
});
