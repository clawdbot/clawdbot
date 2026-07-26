import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  abortable: vi.fn(),
  bindOwnedSessionTranscriptWrites: vi.fn(),
  createRunAbort: vi.fn(),
  flushPendingToolResultsAfterIdle: vi.fn(),
  installStreamGuards: vi.fn(),
  prepareHistory: vi.fn(),
  prepareStream: vi.fn(),
  prepareTimeout: vi.fn(),
  withOwnedSessionTranscriptWrites: vi.fn(),
}));

vi.mock("../../../config/sessions/transcript-write-context.js", () => ({
  bindOwnedSessionTranscriptWrites: mocks.bindOwnedSessionTranscriptWrites,
  withOwnedSessionTranscriptWrites: mocks.withOwnedSessionTranscriptWrites,
}));
vi.mock("../wait-for-idle-before-flush.js", () => ({
  flushPendingToolResultsAfterIdle: mocks.flushPendingToolResultsAfterIdle,
}));
vi.mock("./abortable.js", () => ({ abortable: mocks.abortable }));
vi.mock("./attempt-abort.js", () => ({
  createEmbeddedAttemptRunAbort: mocks.createRunAbort,
}));
vi.mock("./attempt-history-prepare.js", () => ({
  prepareEmbeddedAttemptHistory: mocks.prepareHistory,
}));
vi.mock("./attempt-stream-prepare.js", () => ({
  prepareEmbeddedAttemptStream: mocks.prepareStream,
}));
vi.mock("./attempt-stream.js", () => ({
  installEmbeddedAttemptStreamGuards: mocks.installStreamGuards,
}));
vi.mock("./attempt-timeout-prepare.js", () => ({
  prepareEmbeddedAttemptTimeout: mocks.prepareTimeout,
}));

import { prepareEmbeddedAttemptStreamRuntime } from "./attempt-stream-runtime-prepare.js";

type StreamRuntimeInput = Parameters<typeof prepareEmbeddedAttemptStreamRuntime>[0];

function createFixture(options: { aborted?: boolean } = {}) {
  const order: string[] = [];
  const abortController = new AbortController();
  if (options.aborted) {
    abortController.abort(new Error("already aborted"));
  }
  const runAbort = vi.fn();
  const toolSearchCatalogExecutor = vi.fn();
  const subscription = {
    isCompacting: vi.fn(() => false),
  };
  const queueHandle = { kind: "embedded", runId: "run-1" };
  const streamResult = {
    subscription,
    queueHandle,
    toolSearchCatalogExecutor,
    getBeforeAgentFinalizeRevisionReason: vi.fn(),
    stopAcceptingSteerMessages: vi.fn(),
  };
  const timeoutResult = {
    getRunAbortDeadlineAtMs: vi.fn(() => 123),
    clearTimers: vi.fn(),
    removeAbortSignalListener: vi.fn(),
  };
  const activeSession = {
    agent: { streamFn: vi.fn() },
    dispose: vi.fn(),
    isCompacting: false,
    messages: [],
    prompt: vi.fn(async () => undefined),
  };
  const sessionManager = {};
  const externalAbortController = {
    setRunAbort: vi.fn(() => order.push("set-run-abort")),
    setCompactionState: vi.fn(() => order.push("set-compaction-state")),
  };
  const markIdleTimedOut = vi.fn();
  const markStreamReady = vi.fn(() => order.push("stream-ready"));
  const setToolSearchCatalogExecutor = vi.fn(() => order.push("set-catalog"));
  const trackPromptSettlePromise = vi.fn((promise: Promise<void>) => promise);

  mocks.abortable.mockImplementation((_signal, promise) => promise);
  mocks.bindOwnedSessionTranscriptWrites.mockImplementation((_context, operation) => operation);
  mocks.withOwnedSessionTranscriptWrites.mockImplementation(
    async (_context, operation) => await operation(),
  );
  mocks.installStreamGuards.mockImplementation(() => {
    order.push("guards");
    return {
      cacheObservabilityEnabled: true,
      promptCacheToolNames: new Set(["read"]),
    };
  });
  mocks.prepareHistory.mockImplementation(async () => {
    order.push("history");
    return {
      contextEnginePromptAuthority: "assembled",
      contextEngineAssemblySucceeded: true,
    };
  });
  mocks.createRunAbort.mockImplementation(() => {
    order.push("abort");
    return runAbort;
  });
  mocks.prepareStream.mockImplementation(() => {
    order.push("stream");
    return streamResult;
  });
  mocks.prepareTimeout.mockImplementation(() => {
    order.push("timeout");
    return timeoutResult;
  });

  const input = {
    attempt: {
      abortSignal: abortController.signal,
      onBlockReply: vi.fn(),
      onBlockReplyFlush: vi.fn(),
      runId: "run-1",
      sessionId: "session-1",
      timeoutMs: 30_000,
    },
    activeSession,
    sessionManager,
    sessionLockController: {},
    ownedTranscriptWriteContext: {},
    runAbortController: new AbortController(),
    externalAbortController,
    abortActiveSession: vi.fn(async () => undefined),
    abortState: {},
    trackPromptSettlePromise,
    compactionTimeoutMs: 1_000,
    guards: {},
    history: { sandboxed: false },
    stream: {},
    lifecycle: {
      isYieldDetected: () => false,
      markRejectedThinkingReplayRepaired: vi.fn(),
      markStreamReady,
      markIdleTimedOut,
      markExternalAbort: vi.fn(),
      markTimedOutDuringCompaction: vi.fn(),
      markTimedOutByRunBudget: vi.fn(),
      readRunState: () => ({
        aborted: false,
        promptError: null,
        timedOut: false,
        yieldDetected: false,
      }),
      setToolSearchCatalogExecutor,
    },
  } as unknown as StreamRuntimeInput;

  return {
    activeSession,
    externalAbortController,
    input,
    markIdleTimedOut,
    order,
    runAbort,
    sessionManager,
    streamResult,
    subscription,
    timeoutResult,
    toolSearchCatalogExecutor,
    trackPromptSettlePromise,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("prepareEmbeddedAttemptStreamRuntime", () => {
  it("prepares guarded history, abort handling, stream subscription, and timeout in order", async () => {
    const fixture = createFixture();

    const result = await prepareEmbeddedAttemptStreamRuntime(fixture.input);

    expect(fixture.order).toEqual([
      "guards",
      "stream-ready",
      "history",
      "abort",
      "set-run-abort",
      "stream",
      "set-catalog",
      "set-compaction-state",
      "timeout",
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        cache: {
          observabilityEnabled: true,
          promptToolNames: new Set(["read"]),
        },
        history: expect.objectContaining({ contextEngineAssemblySucceeded: true }),
        isProbeSession: false,
        stream: fixture.streamResult,
        timeout: fixture.timeoutResult,
      }),
    );
    expect(fixture.input.lifecycle.setToolSearchCatalogExecutor).toHaveBeenCalledWith(
      fixture.toolSearchCatalogExecutor,
    );
    expect(fixture.externalAbortController.setCompactionState).toHaveBeenCalledWith({
      isPendingOrRetrying: fixture.subscription.isCompacting,
      isInFlight: expect.any(Function),
    });
    expect(mocks.prepareTimeout).toHaveBeenCalledWith(
      expect.objectContaining({
        abortRun: fixture.runAbort,
        compactionState: fixture.subscription,
      }),
    );

    const guardInput = mocks.installStreamGuards.mock.calls[0]?.[0];
    const idleError = new Error("idle timeout");
    guardInput.onIdleTimeout(idleError);
    expect(fixture.markIdleTimedOut).toHaveBeenCalledOnce();
    expect(fixture.runAbort).toHaveBeenCalledWith(true, idleError);

    await result.promptActiveSession("hello");
    expect(fixture.activeSession.prompt).toHaveBeenCalledWith("hello", undefined);
    expect(fixture.trackPromptSettlePromise).toHaveBeenCalledOnce();
    expect(mocks.withOwnedSessionTranscriptWrites).toHaveBeenCalledOnce();
  });

  it("flushes pending tool results and disposes the session when history preparation fails", async () => {
    const fixture = createFixture({ aborted: true });
    const failure = new Error("history failed");
    mocks.prepareHistory.mockRejectedValueOnce(failure);
    mocks.flushPendingToolResultsAfterIdle.mockResolvedValue(undefined);

    await expect(prepareEmbeddedAttemptStreamRuntime(fixture.input)).rejects.toBe(failure);

    expect(mocks.flushPendingToolResultsAfterIdle).toHaveBeenCalledWith({
      agent: fixture.activeSession.agent,
      sessionManager: fixture.sessionManager,
      timeoutMs: 0,
    });
    expect(fixture.activeSession.dispose).toHaveBeenCalledOnce();
    expect(mocks.createRunAbort).not.toHaveBeenCalled();
    expect(mocks.prepareStream).not.toHaveBeenCalled();
    expect(mocks.prepareTimeout).not.toHaveBeenCalled();
  });
});
