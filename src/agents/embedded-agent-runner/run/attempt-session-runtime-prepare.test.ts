import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAnthropicPayloadLogger: vi.fn(),
  createCacheTrace: vi.fn(),
  createSessionSettleTracker: vi.fn(),
  getSessionPromptState: vi.fn(),
  installContextGuards: vi.fn(),
  prepareAgentSession: vi.fn(),
  prepareSessionBoundary: vi.fn(),
  prepareSessionManager: vi.fn(),
  prepareTrajectory: vi.fn(),
  prepareTransport: vi.fn(),
}));

vi.mock("../../anthropic-payload-log.js", () => ({
  createAnthropicPayloadLogger: mocks.createAnthropicPayloadLogger,
}));
vi.mock("../../cache-trace.js", () => ({ createCacheTrace: mocks.createCacheTrace }));
vi.mock("../session-prompt-state.js", () => ({
  getEmbeddedSessionPromptState: mocks.getSessionPromptState,
}));
vi.mock("./attempt-context-guards.js", () => ({
  installEmbeddedAttemptContextGuards: mocks.installContextGuards,
}));
vi.mock("./attempt-session-boundary.js", () => ({
  prepareEmbeddedAttemptSessionBoundary: mocks.prepareSessionBoundary,
}));
vi.mock("./attempt-session-manager-prepare.js", () => ({
  prepareEmbeddedAttemptSessionManager: mocks.prepareSessionManager,
}));
vi.mock("./attempt-session-settle.js", () => ({
  createEmbeddedAttemptSessionSettleTracker: mocks.createSessionSettleTracker,
}));
vi.mock("./attempt-session.js", () => ({
  prepareEmbeddedAttemptAgentSession: mocks.prepareAgentSession,
}));
vi.mock("./attempt-stream-transport.js", () => ({
  prepareEmbeddedAttemptTransport: mocks.prepareTransport,
}));
vi.mock("./attempt-trajectory.js", () => ({
  prepareEmbeddedAttemptTrajectory: mocks.prepareTrajectory,
}));

import { prepareEmbeddedAttemptSessionRuntime } from "./attempt-session-runtime-prepare.js";

type PrepareInput = Parameters<typeof prepareEmbeddedAttemptSessionRuntime>[0];

function createFixture() {
  const order: string[] = [];
  const sessionManager = { kind: "manager" };
  const activeSession = {
    messages: [{ role: "user" }, { role: "assistant" }],
    sessionId: "active-session",
  };
  const settingsManager = { kind: "settings" };
  const setActiveSessionSystemPrompt = vi.fn();
  const agentSession = {
    activeSession,
    clientToolDefs: [{ name: "read" }, { name: "write" }],
    setActiveSessionSystemPrompt,
    settingsManager,
  };
  const boundary = { setCurrentUserTimestampOverride: vi.fn() };
  const promptState = { toolResults: { projected: true } };
  const abortActiveSession = vi.fn(async () => undefined);
  const buildAbortSettlePromise = vi.fn(() => null);
  const trackPromptSettlePromise = vi.fn((promise: Promise<void>) => promise);
  const settleTracker = {
    abortActiveSession,
    buildAbortSettlePromise,
    trackPromptSettlePromise,
  };
  const contextGuards = {
    getAfterTurnCheckpoint: vi.fn(() => null),
    remove: vi.fn(),
    takePendingMidTurnPrecheckRequest: vi.fn(() => null),
  };
  const cacheTrace = { kind: "cache-trace" };
  const anthropicPayloadLogger = { kind: "payload-logger" };
  const trajectoryRecorder = { kind: "trajectory" };
  const transport = {
    effectiveAgentTransport: "sse",
    effectiveExtraParams: { cacheRetention: "long" },
    effectivePromptCacheRetention: "long",
    providerTextTransforms: undefined,
    streamStrategy: "provider",
  };
  const transcriptPolicy = { repairToolUseResultPairing: true };
  const getUserTranscriptContexts = vi.fn(() => []);

  mocks.prepareSessionManager.mockImplementation(async (input) => {
    order.push("manager");
    input.onSessionManagerCreated(sessionManager);
    return {
      isOpenAIResponsesApi: true,
      preparedUserTurnMessage: { role: "user", content: "hello" },
      sessionManager,
      transcriptPolicy,
      userMessageBoundary: {
        getUserTranscriptContexts,
        preparedUserTurnMessage: { role: "user", content: "hello" },
      },
    };
  });
  mocks.prepareAgentSession.mockImplementation(async (input) => {
    order.push("agent-session");
    input.onSessionCreated(activeSession);
    input.onSystemPromptChanged("runtime prompt");
    return agentSession;
  });
  mocks.prepareSessionBoundary.mockImplementation(() => {
    order.push("boundary");
    return boundary;
  });
  mocks.getSessionPromptState.mockImplementation(() => {
    order.push("prompt-state");
    return promptState;
  });
  mocks.createSessionSettleTracker.mockImplementation(() => {
    order.push("settle-tracker");
    return settleTracker;
  });
  mocks.installContextGuards.mockImplementation(() => {
    order.push("context-guards");
    return contextGuards;
  });
  mocks.createCacheTrace.mockImplementation(() => {
    order.push("cache-trace");
    return cacheTrace;
  });
  mocks.createAnthropicPayloadLogger.mockImplementation(() => {
    order.push("payload-logger");
    return anthropicPayloadLogger;
  });
  mocks.prepareTrajectory.mockImplementation(async () => {
    order.push("trajectory");
    return trajectoryRecorder;
  });
  mocks.prepareTransport.mockImplementation(async () => {
    order.push("transport");
    return transport;
  });

  const lifecycle = {
    onContextGuardsInstalled: vi.fn(() => order.push("own-context-guards")),
    onSessionCreated: vi.fn(() => order.push("own-session")),
    onSessionManagerCreated: vi.fn(() => order.push("own-manager")),
    onSessionSettleTrackerReady: vi.fn(() => order.push("own-settle-tracker")),
    onSessionYieldReady: vi.fn(() => order.push("own-yield")),
    onTrajectoryRecorderCreated: vi.fn(() => order.push("own-trajectory")),
  };
  const externalAbortController = {
    setActiveSessionAbort: vi.fn(() => order.push("arm-session-abort")),
  };
  const input = {
    attempt: {
      model: { api: "openai-responses", contextWindow: 128_000 },
      modelId: "gpt-5",
      provider: "openai",
      runId: "run-1",
      sessionId: "session-1",
      workspaceDir: "/workspace",
    },
    agentDir: "/agent",
    effectiveCwd: "/workspace",
    effectiveWorkspace: "/workspace",
    initialSystemPrompt: "initial prompt",
    isRawModelRun: false,
    sessionManager: {
      replayAllowedToolNames: new Set(["read"]),
      resolveActiveContextEnginePluginId: vi.fn(),
      sessionAgentId: "main",
      sessionLockController: {},
      withOwnedSessionWriteLock: vi.fn(),
    },
    agentSession: {
      agentCoreThinkingLevel: "medium",
      clientToolPreparation: {},
      getCurrentAttemptPluginMetadataSnapshot: vi.fn(),
      markStage: vi.fn(),
      runAbortSignal: new AbortController().signal,
    },
    contextGuards: { computerContextEpoch: { value: 0 } },
    trajectory: { effectiveToolCount: 4, localModelLeanEnabled: false },
    transport: {
      abortSignal: new AbortController().signal,
      codeModeControlsEnabled: false,
      getProviderRuntimeHandle: vi.fn(),
      providerThinkingLevel: "medium",
      sandboxSessionKey: "sandbox-1",
    },
    externalAbortController,
    lifecycle,
  } as unknown as PrepareInput;

  return {
    abortActiveSession,
    activeSession,
    anthropicPayloadLogger,
    boundary,
    buildAbortSettlePromise,
    cacheTrace,
    contextGuards,
    externalAbortController,
    getUserTranscriptContexts,
    input,
    lifecycle,
    order,
    promptState,
    sessionManager,
    settingsManager,
    trajectoryRecorder,
    transport,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("prepareEmbeddedAttemptSessionRuntime", () => {
  it("prepares the session runtime in ownership-safe order and keeps prompt state live", async () => {
    const fixture = createFixture();

    const result = await prepareEmbeddedAttemptSessionRuntime(fixture.input);

    expect(fixture.order).toEqual([
      "manager",
      "own-manager",
      "agent-session",
      "own-session",
      "boundary",
      "prompt-state",
      "settle-tracker",
      "arm-session-abort",
      "own-settle-tracker",
      "own-yield",
      "context-guards",
      "own-context-guards",
      "cache-trace",
      "payload-logger",
      "trajectory",
      "own-trajectory",
      "transport",
    ]);
    expect(result).toEqual(
      expect.objectContaining({
        anthropicPayloadLogger: fixture.anthropicPayloadLogger,
        boundary: fixture.boundary,
        cacheTrace: fixture.cacheTrace,
        contextGuards: fixture.contextGuards,
        sessionManager: fixture.sessionManager,
        sessionPromptState: fixture.promptState,
        toolResultPromptProjectionState: fixture.promptState.toolResults,
        trajectoryRecorder: fixture.trajectoryRecorder,
        transport: fixture.transport,
      }),
    );
    expect(result.state).toEqual({
      prePromptMessageCount: 2,
      promptCache: undefined,
      systemPromptText: "runtime prompt",
    });
    expect(mocks.prepareSessionBoundary).toHaveBeenCalledWith(
      expect.objectContaining({
        getUserTranscriptContexts: fixture.getUserTranscriptContexts,
        preparedUserTurnMessage: { role: "user", content: "hello" },
      }),
    );
    expect(fixture.externalAbortController.setActiveSessionAbort).toHaveBeenCalledWith(
      fixture.abortActiveSession,
    );
    expect(fixture.lifecycle.onSessionSettleTrackerReady).toHaveBeenCalledWith(
      fixture.buildAbortSettlePromise,
    );
    expect(fixture.lifecycle.onSessionYieldReady).toHaveBeenCalledWith({
      abortActiveSession: fixture.abortActiveSession,
      activeSession: fixture.activeSession,
    });

    result.state.prePromptMessageCount = 7;
    result.state.promptCache = { cacheRead: 3 } as never;
    result.state.systemPromptText = "updated prompt";
    const guardInput = mocks.installContextGuards.mock.calls[0]?.[0];
    expect(guardInput.getPrePromptMessageCount()).toBe(7);
    expect(guardInput.getPromptCache()).toEqual({ cacheRead: 3 });
    expect(guardInput.getPromptCacheRetention()).toBe("long");
    expect(guardInput.getSystemPrompt()).toBe("updated prompt");
  });

  it("publishes every cleanup owner before a later transport failure", async () => {
    const fixture = createFixture();
    mocks.prepareTransport.mockRejectedValueOnce(new Error("transport failed"));

    await expect(prepareEmbeddedAttemptSessionRuntime(fixture.input)).rejects.toThrow(
      "transport failed",
    );

    expect(fixture.lifecycle.onSessionManagerCreated).toHaveBeenCalledWith(fixture.sessionManager);
    expect(fixture.lifecycle.onSessionCreated).toHaveBeenCalledWith(fixture.activeSession);
    expect(fixture.lifecycle.onContextGuardsInstalled).toHaveBeenCalledWith(
      fixture.contextGuards.remove,
    );
    expect(fixture.lifecycle.onSessionSettleTrackerReady).toHaveBeenCalledWith(
      fixture.buildAbortSettlePromise,
    );
    expect(fixture.lifecycle.onTrajectoryRecorderCreated).toHaveBeenCalledWith(
      fixture.trajectoryRecorder,
    );
  });
});
