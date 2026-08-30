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

import { agentSessionSetContextReplacementHook } from "../../sessions/agent-session-compaction.js";
import { runEmbeddedAttemptExecutionPhase } from "./attempt-execution-phase.js";

type ExecutionInput = Parameters<typeof runEmbeddedAttemptExecutionPhase>[0];

function createFixture(
  options: {
    aborted?: boolean;
    exerciseTerminalMerges?: boolean;
  } = {},
) {
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
  const setContextReplacementHook = vi.fn();
  const activeSession = {
    [agentSessionSetContextReplacementHook]: setContextReplacementHook,
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
  const skillInstructionDeliveryCache = new Map([["skill", Promise.resolve(true)]]);
  const sessionRuntime = {
    agentSession: {
      activeSession,
      allCustomTools: [{ name: "custom" }],
      builtinToolNames: new Set(["read"]),
      clientToolCallSlots: [],
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
      toolBase: { skillInstructionDeliveryCache, nestedToolActivities: new Map() },
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
    if (options.exerciseTerminalMerges !== false) {
      const idleError = new Error("idle timeout");
      mocks.installStreamGuards.mock.calls[0]?.[0].onIdleTimeout(idleError);
      streamInput.markExternalAbort();
    }
    return streamResult;
  });
  mocks.prepareTimeout.mockImplementation((timeoutInput) => {
    order.push("timeout");
    if (options.exerciseTerminalMerges !== false) {
      timeoutInput.markTimedOutDuringCompaction();
      timeoutInput.markTimedOutByRunBudget();
    }
    return timeoutResult;
  });
  mocks.runSettledPhase.mockImplementation(async (settledInput) => {
    order.push("settled-phase");
    expect(settledInput.getRepairedRejectedProviderReplay()).toBe(false);
    mocks.installStreamGuards.mock.calls[0]?.[0].onRejectedProviderReplayRepaired();
    expect(settledInput.getRepairedRejectedProviderReplay()).toBe(true);
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
    setContextReplacementHook,
    skillInstructionDeliveryCache,
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
    expect(fixture.setContextReplacementHook).toHaveBeenCalledOnce();
    const replacementHook = fixture.setContextReplacementHook.mock.calls[0]?.[0];
    expect(replacementHook).toEqual(expect.any(Function));
    replacementHook?.();
    expect(fixture.skillInstructionDeliveryCache.size).toBe(0);
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

  it("does not start a prompt after external cancellation", async () => {
    const fixture = createFixture();
    await runEmbeddedAttemptExecutionPhase(fixture.input);
    const reason = new Error("run cancelled");
    const abortError = new Error("run cancelled", { cause: reason });
    abortError.name = "AbortError";
    fixture.input.runAbortController.abort(reason);
    mocks.abortable.mockImplementationOnce((_signal, _promise) => Promise.reject(abortError));
    const settledInput = mocks.runSettledPhase.mock.calls[0]?.[0];

    await expect(
      settledInput.preparedStreamRuntime.promptActiveSession("must not start"),
    ).rejects.toThrow("run cancelled");

    expect(fixture.activeSession.prompt).not.toHaveBeenCalled();
  });

  it("attributes an idle timeout during authoritative compaction to compaction", async () => {
    const fixture = createFixture({ exerciseTerminalMerges: false });
    fixture.activeSession.isCompacting = true;
    await runEmbeddedAttemptExecutionPhase(fixture.input);
    const idleError = new Error("idle timeout");
    const guardInput = mocks.installStreamGuards.mock.calls[0]?.[0];

    guardInput.onIdleTimeout(idleError);

    expect(fixture.state.terminal).toEqual({
      kind: "timeout",
      phase: "compaction",
      source: "idle",
    });
    expect(fixture.runAbort).toHaveBeenCalledWith(true, idleError);
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
  });
});
