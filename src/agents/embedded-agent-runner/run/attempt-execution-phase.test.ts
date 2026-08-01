import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareStreamRuntime: vi.fn(),
  runSettledPhase: vi.fn(),
}));

vi.mock("./attempt-stream-runtime-prepare.js", () => ({
  prepareEmbeddedAttemptStreamRuntime: mocks.prepareStreamRuntime,
}));
vi.mock("./attempt-execution-settle.js", () => ({
  runEmbeddedAttemptSettledPhase: mocks.runSettledPhase,
}));

import { runEmbeddedAttemptExecutionPhase } from "./attempt-execution-phase.js";

type ExecutionInput = Parameters<typeof runEmbeddedAttemptExecutionPhase>[0];

function createFixture() {
  const order: string[] = [];
  const activeSession = { sessionId: "active-session" };
  const sessionManager = { kind: "session-manager" };
  const abortActiveSession = vi.fn(async () => undefined);
  const trackPromptSettlePromise = vi.fn((promise: Promise<void>) => promise);
  const toolSearchCatalogExecutor = vi.fn();
  const result = { messages: [] };
  const preparedStreamRuntime = { stream: { queueHandle: { kind: "embedded" } } };
  const state = {
    beforeAgentRunBlocked: false,
    beforeAgentRunBlockedBy: undefined,
    terminal: { kind: "ok" as const },
    trajectoryEndRecorded: false,
  };
  const prepStages = { mark: vi.fn() };
  const emitPrepStageSummary = vi.fn();
  const setToolSearchCatalogExecutor = vi.fn();
  const replaySafeTool = { name: "read" };
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
    attempt: { runId: "run-1", sessionId: "session-1" },
    activeContextEngine: { info: { id: "engine" } },
    agentDir: "/agent",
    isRawModelRun: false,
    resolveActiveContextEnginePluginId: vi.fn(),
    runAbortController: new AbortController(),
    externalAbortController: {},
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
      sessionLockController: {},
      withOwnedSessionWriteLock: vi.fn(),
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

  mocks.prepareStreamRuntime.mockImplementation(async (streamInput) => {
    order.push("stream-runtime");
    streamInput.lifecycle.markStreamReady();
    streamInput.lifecycle.markIdleTimedOut();
    streamInput.lifecycle.markExternalAbort();
    streamInput.lifecycle.markTimedOutDuringCompaction();
    streamInput.lifecycle.markTimedOutByRunBudget();
    streamInput.lifecycle.setToolSearchCatalogExecutor(toolSearchCatalogExecutor);
    return preparedStreamRuntime;
  });
  mocks.runSettledPhase.mockImplementation(async (settledInput) => {
    order.push("settled-phase");
    expect(settledInput.getRepairedRejectedThinkingReplay()).toBe(false);
    const streamInput = mocks.prepareStreamRuntime.mock.calls[0]?.[0];
    streamInput.lifecycle.markRejectedThinkingReplayRepaired();
    expect(settledInput.getRepairedRejectedThinkingReplay()).toBe(true);
    return result;
  });

  return {
    abortActiveSession,
    activeSession,
    emitPrepStageSummary,
    input,
    order,
    prepStages,
    preparedStreamRuntime,
    replaySafeTool,
    result,
    sessionManager,
    setToolSearchCatalogExecutor,
    state,
    toolSearchCatalogExecutor,
    trackPromptSettlePromise,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runEmbeddedAttemptExecutionPhase", () => {
  it("prepares the guarded stream and delegates settlement with live lifecycle state", async () => {
    const fixture = createFixture();

    const result = await runEmbeddedAttemptExecutionPhase(fixture.input);

    expect(result).toBe(fixture.result);
    expect(fixture.order).toEqual(["stream-runtime", "settled-phase"]);
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
    expect(mocks.runSettledPhase).toHaveBeenCalledWith(
      expect.objectContaining({
        getRepairedRejectedThinkingReplay: expect.any(Function),
        preparedStreamRuntime: fixture.preparedStreamRuntime,
      }),
    );
    const settledInput = mocks.runSettledPhase.mock.calls[0]?.[0];
    expect(settledInput.getRepairedRejectedThinkingReplay()).toBe(true);

    const streamInput = mocks.prepareStreamRuntime.mock.calls[0]?.[0];
    expect(streamInput).toEqual(
      expect.objectContaining({
        activeSession: fixture.activeSession,
        sessionManager: fixture.sessionManager,
        abortActiveSession: fixture.abortActiveSession,
        trackPromptSettlePromise: fixture.trackPromptSettlePromise,
      }),
    );
    expect(streamInput.lifecycle.isYieldDetected()).toBe(true);
    expect(streamInput.lifecycle.readRunState()).toEqual({
      aborted: true,
      promptError: null,
      timedOut: true,
      yieldDetected: true,
    });
    expect(streamInput.stream.isReplaySafeTool(fixture.replaySafeTool)).toBe(true);
  });

  it("does not enter settlement when stream preparation fails", async () => {
    const fixture = createFixture();
    mocks.prepareStreamRuntime.mockRejectedValueOnce(new Error("stream setup failed"));

    await expect(runEmbeddedAttemptExecutionPhase(fixture.input)).rejects.toThrow(
      "stream setup failed",
    );

    expect(mocks.runSettledPhase).not.toHaveBeenCalled();
  });
});
