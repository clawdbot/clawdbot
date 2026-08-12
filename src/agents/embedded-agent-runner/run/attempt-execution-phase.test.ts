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
  runSettledPhase: vi.fn(),
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
vi.mock("./attempt-finalize.js", () => ({
  createEmbeddedAttemptRunAbort: mocks.createRunAbort,
}));
vi.mock("./attempt-history.js", () => ({
  prepareEmbeddedAttemptHistory: mocks.prepareHistory,
}));
vi.mock("./attempt-settle.js", () => ({
  runEmbeddedAttemptSettledPhase: mocks.runSettledPhase,
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

import { runEmbeddedAttemptExecutionPhase } from "./attempt-execution-phase.js";

type ExecutionInput = Parameters<typeof runEmbeddedAttemptExecutionPhase>[0];

function createFixture(options: { aborted?: boolean } = {}) {
  const order: string[] = [];
  const attemptAbortController = new AbortController();
  if (options.aborted) {
    attemptAbortController.abort(new Error("already aborted"));
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
  };
  const activeSession = {
    agent: { streamFn: vi.fn() },
    dispose: vi.fn(),
    isCompacting: false,
    messages: [],
    prompt: vi.fn(async () => undefined),
    sessionId: "active-session",
  };
  const sessionManager = {};
  const abortActiveSession = vi.fn(async () => undefined);
  const trackPromptSettlePromise = vi.fn((promise: Promise<void>) => promise);
  const externalAbortController = {
    setRunAbort: vi.fn(() => order.push("set-run-abort")),
    setCompactionState: vi.fn(() => order.push("set-compaction-state")),
  };
  const prepStages = { mark: vi.fn(() => order.push("stream-ready")) };
  const emitPrepStageSummary = vi.fn();
  const setToolSearchCatalogExecutor = vi.fn(() => order.push("set-catalog"));
  const replaySafeTool = { name: "read" };
  const result = { messages: [] };
  const state = {
    beforeAgentRunBlockedBy: undefined,
    terminal: { kind: "ok" as const },
    trajectoryEndRecorded: false,
  };
  const sessionRuntime = {
    agentSession: {
      activeSession,
      allCustomTools: [{ name: "custom" }],
      builtinToolNames: new Set(["read"]),
      clientToolCallSlots: [],
      clientToolLoopDetection: {},
      hasDeliveredSourceReply: vi.fn(() => false),
      hookRunner: {},
      markSourceReplyDelivered: vi.fn(),
      replaySafeToolNames: new Set(["read"]),
      replaySafeTools: new Set([replaySafeTool]),
      setActiveSessionSystemPrompt: vi.fn(),
      settingsManager: {},
    },
    anthropicPayloadLogger: {},
    boundary: { orphanRepair: { removeLeaf: true } },
    cacheTrace: {},
    isOpenAIResponsesApi: true,
    sessionManager,
    settleTracker: { abortActiveSession, trackPromptSettlePromise },
    state: { systemPromptText: "system prompt" },
    transcriptPolicy: { repairToolUseResultPairing: true },
    transport: {
      effectiveAgentTransport: "sse",
      providerTextTransforms: { input: [] },
    },
  };
  const input = {
    attempt: {
      abortSignal: attemptAbortController.signal,
      onBlockReply: vi.fn(),
      onBlockReplyFlush: vi.fn(),
      runId: "run-1",
      sessionId: "session-1",
      timeoutMs: 30_000,
    },
    activeContextEngine: { info: { id: "engine" } },
    agentDir: "/agent",
    isRawModelRun: false,
    resolveActiveContextEnginePluginId: vi.fn(),
    runAbortController: new AbortController(),
    externalAbortController,
    abortState: {},
    prepared: {
      bootstrap: {},
      bundleTools: {},
      sessionRuntime,
      systemPrompt: { runtimeChannel: "telegram" },
      toolBase: { toolSearchTargetTranscriptProjections: new Map() },
      toolCatalog: {
        toolSearchRunPlan: {
          capabilityToolNames: new Set(["read"]),
          liveAllowedToolNames: new Set(["read"]),
          replayAllowedToolNames: new Set(["read"]),
        },
      },
    },
    sessionLock: {
      compactionTimeoutMs: 1_000,
      ownedTranscriptWriteContext: {},
      withOwnedTranscriptWrite: vi.fn(),
    },
    setup: {
      effectiveFsWorkspaceOnly: false,
      effectiveWorkspace: "/workspace",
      emitPrepStageSummary,
      prepStages,
      sandbox: null,
      sandboxSessionKey: "sandbox-1",
      sessionAgentId: "main",
    },
    diagnostics: { diagnosticTrace: {}, runTrace: {} },
    state,
    lifecycle: {
      readYieldState: () => ({
        yieldAbortSettled: null,
        yieldDetected: true,
        yieldMessage: "yield",
      }),
      setToolSearchCatalogExecutor,
    },
  } as unknown as ExecutionInput;

  mocks.abortable.mockImplementation((_signal, promise) => promise);
  mocks.bindOwnedSessionTranscriptWrites.mockImplementation((_context, operation) => operation);
  mocks.withOwnedSessionTranscriptWrites.mockImplementation(
    async (_context, operation) => await operation(),
  );
  mocks.installStreamGuards.mockImplementation(() => {
    order.push("guards");
    return {
      cacheObservabilityEnabled: true,
      promptCacheTools: [{ name: "read" }],
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
  mocks.prepareStream.mockImplementation((streamInput) => {
    order.push("stream");
    const idleError = new Error("idle timeout");
    mocks.installStreamGuards.mock.calls[0]?.[0].onIdleTimeout(idleError);
    streamInput.markExternalAbort();
    return streamResult;
  });
  mocks.prepareTimeout.mockImplementation((timeoutInput) => {
    order.push("timeout");
    timeoutInput.markTimedOutDuringCompaction();
    timeoutInput.markTimedOutByRunBudget();
    return timeoutResult;
  });
  mocks.runSettledPhase.mockImplementation(async (settledInput) => {
    order.push("settled-phase");
    expect(settledInput.getRepairedRejectedThinkingReplay()).toBe(false);
    mocks.installStreamGuards.mock.calls[0]?.[0].onRejectedThinkingReplayRepaired();
    expect(settledInput.getRepairedRejectedThinkingReplay()).toBe(true);
    return result;
  });

  return {
    abortActiveSession,
    activeSession,
    emitPrepStageSummary,
    externalAbortController,
    input,
    order,
    prepStages,
    replaySafeTool,
    result,
    runAbort,
    sessionManager,
    setToolSearchCatalogExecutor,
    state,
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

describe("runEmbeddedAttemptExecutionPhase", () => {
  it("prepares guarded history, stream handling, deadlines, and settlement in order", async () => {
    const fixture = createFixture();

    const result = await runEmbeddedAttemptExecutionPhase(fixture.input);

    expect(result).toBe(fixture.result);
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
      "settled-phase",
    ]);
    expect(fixture.state).toEqual(
      expect.objectContaining({
        terminal: {
          aborted: true,
          kind: "timeout",
          phase: "compaction",
          source: "external",
        },
      }),
    );
    expect(fixture.prepStages.mark).toHaveBeenCalledWith("stream-setup");
    expect(fixture.emitPrepStageSummary).toHaveBeenCalledWith("stream-ready");
    expect(fixture.setToolSearchCatalogExecutor).toHaveBeenCalledWith(
      fixture.toolSearchCatalogExecutor,
    );

    const settledInput = mocks.runSettledPhase.mock.calls[0]?.[0];
    expect(settledInput).toEqual(
      expect.objectContaining({
        getRepairedRejectedThinkingReplay: expect.any(Function),
        preparedStreamRuntime: expect.objectContaining({
          cache: {
            observabilityEnabled: true,
            promptTools: [{ name: "read" }],
          },
          history: expect.objectContaining({ contextEngineAssemblySucceeded: true }),
          isProbeSession: false,
          stream: fixture.streamResult,
          timeout: fixture.timeoutResult,
        }),
      }),
    );
    expect(settledInput.getRepairedRejectedThinkingReplay()).toBe(true);

    const guardInput = mocks.installStreamGuards.mock.calls[0]?.[0];
    expect(guardInput).toEqual(
      expect.objectContaining({
        attempt: fixture.input.attempt,
        session: fixture.activeSession,
        sessionManager: fixture.sessionManager,
      }),
    );
    expect(guardInput.isYieldDetected()).toBe(true);
    expect(fixture.runAbort).toHaveBeenCalledWith(true, expect.any(Error));

    const abortInput = mocks.createRunAbort.mock.calls[0]?.[0];
    expect(abortInput.abortActiveSession).toBe(fixture.abortActiveSession);
    const streamInput = mocks.prepareStream.mock.calls[0]?.[0];
    expect(streamInput.activeSession).toBe(fixture.activeSession);
    expect(streamInput.getRunState()).toEqual({
      aborted: true,
      promptError: null,
      timedOut: true,
      yieldDetected: true,
    });
    expect(streamInput.isReplaySafeTool(fixture.replaySafeTool)).toBe(true);
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

    await settledInput.preparedStreamRuntime.promptActiveSession("hello");
    expect(fixture.activeSession.prompt).toHaveBeenCalledWith("hello", undefined);
    expect(fixture.trackPromptSettlePromise).toHaveBeenCalledOnce();
    expect(mocks.withOwnedSessionTranscriptWrites).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "external cancellation", message: "run cancelled" },
    { label: "run timeout", message: "run timed out" },
  ])("does not start a prompt after $label", async ({ message }) => {
    const fixture = createFixture();
    await runEmbeddedAttemptExecutionPhase(fixture.input);
    const reason = new Error(message);
    const abortError = new Error(message, { cause: reason });
    abortError.name = "AbortError";
    fixture.input.runAbortController.abort(reason);
    mocks.abortable.mockImplementationOnce((_signal, _promise) => Promise.reject(abortError));
    const settledInput = mocks.runSettledPhase.mock.calls[0]?.[0];

    await expect(
      settledInput.preparedStreamRuntime.promptActiveSession("must not start"),
    ).rejects.toBe(abortError);

    expect(fixture.activeSession.prompt).not.toHaveBeenCalled();
    expect(fixture.trackPromptSettlePromise).not.toHaveBeenCalled();
    expect(mocks.abortable).toHaveBeenCalledOnce();
  });

  it("flushes pending tool results and disposes the session when history preparation fails", async () => {
    const fixture = createFixture({ aborted: true });
    const failure = new Error("history failed");
    mocks.prepareHistory.mockRejectedValueOnce(failure);
    mocks.flushPendingToolResultsAfterIdle.mockResolvedValue(undefined);

    await expect(runEmbeddedAttemptExecutionPhase(fixture.input)).rejects.toBe(failure);

    expect(mocks.flushPendingToolResultsAfterIdle).toHaveBeenCalledWith({
      agent: fixture.activeSession.agent,
      sessionManager: fixture.sessionManager,
      timeoutMs: 0,
    });
    expect(fixture.activeSession.dispose).toHaveBeenCalledOnce();
    expect(mocks.createRunAbort).not.toHaveBeenCalled();
    expect(mocks.prepareStream).not.toHaveBeenCalled();
    expect(mocks.prepareTimeout).not.toHaveBeenCalled();
    expect(mocks.runSettledPhase).not.toHaveBeenCalled();
  });

  it("does not enter settlement when stream preparation fails", async () => {
    const fixture = createFixture();
    mocks.prepareStream.mockImplementationOnce(() => {
      throw new Error("stream setup failed");
    });

    await expect(runEmbeddedAttemptExecutionPhase(fixture.input)).rejects.toThrow(
      "stream setup failed",
    );

    expect(mocks.runSettledPhase).not.toHaveBeenCalled();
  });
});
