import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  beforeAgentRun: vi.fn(),
  dispatchPrompt: vi.fn(),
  handlePromptError: vi.fn(),
  handleMidTurnPrecheck: vi.fn(),
  prepareGooglePromptCache: vi.fn(),
  preparePromptAssembly: vi.fn(),
  preparePromptContext: vi.fn(),
  releasePendingSteering: vi.fn(),
  removeTrailingPrecheckError: vi.fn(),
  resolveApiKey: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../subagent-registry.js", () => ({
  releasePendingAgentSteeringItems: mocks.releasePendingSteering,
}));
vi.mock("../google-prompt-cache.js", () => ({
  prepareGooglePromptCacheStreamFn: mocks.prepareGooglePromptCache,
}));
vi.mock("../logger.js", () => ({
  log: { debug: mocks.debug, warn: mocks.warn },
}));
vi.mock("../stream-resolution.js", () => ({
  resolveEmbeddedAgentApiKey() {
    return mocks.resolveApiKey();
  },
}));
vi.mock("./attempt-before-agent-run.js", () => ({
  runEmbeddedAttemptBeforeAgentRun: mocks.beforeAgentRun,
}));
vi.mock("./attempt-prompt-assembly.js", () => ({
  prepareEmbeddedAttemptPromptAssembly: mocks.preparePromptAssembly,
}));
vi.mock("./attempt-prompt-context.js", () => ({
  prepareEmbeddedAttemptPromptContext: mocks.preparePromptContext,
}));
vi.mock("./attempt-prompt-dispatch.js", () => ({
  dispatchEmbeddedAttemptPrompt: mocks.dispatchPrompt,
}));
vi.mock("./attempt-prompt-error.js", () => ({
  handleEmbeddedAttemptPromptError: mocks.handlePromptError,
}));
vi.mock("./attempt-prompt-preflight.js", () => ({
  handleEmbeddedAttemptMidTurnPrecheck: mocks.handleMidTurnPrecheck,
}));
vi.mock("./attempt-transcript-helpers.js", () => ({
  removeTrailingMidTurnPrecheckAssistantError: mocks.removeTrailingPrecheckError,
}));

import { runEmbeddedAttemptPromptPhase } from "./attempt-prompt-phase.js";

type PromptPhaseInput = Parameters<typeof runEmbeddedAttemptPromptPhase>[0];
type PromptPhaseState = ReturnType<PromptPhaseInput["lifecycle"]["readState"]>;
type AssemblyCall = {
  setLeasedSteering: (lease: { leaseId: string; runIds: string[] }) => void;
};
type DispatchCall = {
  getCompactionReserveTokens: () => number;
  publishState: (state: PromptPhaseState & { skipPromptSubmission: boolean }) => void;
  state: PromptPhaseState & { skipPromptSubmission: boolean };
  submission: {
    onFinalPromptText: (prompt: string) => void;
    onSteeringAcknowledged: () => void;
  };
};
type PromptErrorCall = {
  error: unknown;
  markYieldAborted: () => void;
  releaseLeasedSteering: (error?: unknown) => void;
  yieldAbortSettled: Promise<void> | null;
  yieldDetected: boolean;
  yieldMessage: string | null;
};

function createFixture() {
  const order: string[] = [];
  const state: PromptPhaseState = {
    contextBudgetStatus: undefined,
    preflightRecovery: undefined,
    promptError: null,
    promptErrorSource: null,
  };
  const yieldState = {
    yieldAbortSettled: null as Promise<void> | null,
    yieldDetected: false,
    yieldMessage: null as string | null,
  };
  let prePromptMessageCount = 1;

  const setPrePromptMessageCount = vi.fn((count: number) => {
    prePromptMessageCount = count;
  });
  const setPromptCacheChangesForTurn = vi.fn();
  const setFinalPromptText = vi.fn();
  const markBeforeAgentRunBlocked = vi.fn();
  const markYieldAborted = vi.fn(() => {
    order.push("yield-aborted");
  });
  const stopAcceptingSteerMessages = vi.fn(() => {
    order.push("stop-steering");
  });

  mocks.preparePromptAssembly.mockImplementation(async (input: AssemblyCall) => {
    order.push("assembly");
    const lease = { leaseId: "lease-1", runIds: ["run-1"] };
    input.setLeasedSteering(lease);
    return {
      hookCtx: {},
      promptCacheChangesForTurn: [],
      leasedSteering: lease,
      transcriptLeafId: "leaf-1",
    };
  });
  mocks.preparePromptContext.mockImplementation(() => {
    order.push("context");
    return {
      aggregatePressureEngaged: false,
      contextTokenBudget: 32_000,
      currentUserTimestampOverride: { timestamp: 123, text: "hello" },
      effectivePrompt: "hello",
      hookMessagesForCurrentPrompt: [],
      llmBoundaryPromptForPrecheck: "hello",
      prePromptMessageCount: 2,
      promptForModel: "hello",
      promptForSession: "hello",
      promptSubmission: { prompt: "hello", runtimeOnly: false },
      promptToolResultAggregateMaxChars: 2_000,
      promptToolResultMaxChars: 1_000,
      runtimeContextMessageForCurrentTurn: undefined,
      systemPromptForHook: "system",
    };
  });
  mocks.beforeAgentRun.mockImplementation(async () => {
    order.push("before-agent-run");
    return undefined;
  });
  mocks.resolveApiKey.mockResolvedValue("test-key");
  mocks.prepareGooglePromptCache.mockImplementation(async () => {
    order.push("google-cache");
    return undefined;
  });
  mocks.dispatchPrompt.mockImplementation(async (input: DispatchCall) => {
    order.push("dispatch");
    expect(input.getCompactionReserveTokens()).toBe(77);
    input.submission.onFinalPromptText("hello");
    input.submission.onSteeringAcknowledged();
    const nextState = { ...input.state, skipPromptSubmission: false };
    input.publishState(nextState);
    return nextState;
  });

  const activeSession = {
    messages: [],
    agent: {
      state: { messages: [] },
      streamFn: vi.fn(),
    },
  };
  const sessionManager = {
    appendCustomEntry: vi.fn(),
    getEntries: vi.fn(() => []),
  };
  const sessionLockController = {
    waitForSessionEvents: vi.fn(async () => undefined),
  };
  const input = {
    attempt: {
      model: { id: "model-1", provider: "test" },
      modelId: "model-1",
      provider: "test",
      runId: "run-1",
      sessionId: "session-1",
    },
    activeSession,
    sessionManager,
    sessionLockController,
    withOwnedSessionWriteLock: async <T>(operation: () => Promise<T> | T) => await operation(),
    getCompactionReserveTokens: () => 77,
    assembly: {
      hookRunner: null,
      hookAgentId: "main",
      diagnosticTrace: {},
      isRawModelRun: false,
      sessionAgentId: "main",
      runtimeModel: "model-1",
      systemPromptText: "system",
      setActiveSessionSystemPrompt: vi.fn(),
      cache: {},
    },
    context: {
      includeBoundaryTimestamp: false,
      isRawModelRun: false,
      sessionAgentId: "main",
      setActiveSessionSystemPrompt: vi.fn(),
      systemPromptText: "system",
      toolResultPromptProjectionState: {},
    },
    execution: {
      effectiveFsWorkspaceOnly: false,
      effectiveWorkspace: "/tmp/workspace",
      sandbox: null,
    },
    googlePromptCache: {
      extraParams: {},
      signal: new AbortController().signal,
    },
    observation: {
      cacheTrace: null,
      diagnosticTrace: {},
      effectiveTools: [],
      hookAgentId: "main",
      hookRunner: null,
      isRawModelRun: false,
      runTrace: {},
      streamStrategy: "default",
      systemPromptText: "system",
      toolSearchCompacted: false,
      tools: [],
      trajectoryRecorder: null,
      transport: "sse",
      uncompactedEffectiveTools: [],
    },
    preflight: {
      contextEngineAssemblySucceeded: false,
      contextEnginePromptAuthority: "assembled",
      includeBoundaryTimestamp: false,
      sessionAgentId: "main",
    },
    submission: {
      promptActiveSession: vi.fn(),
      sessionPromptState: {},
      toolResultPromptProjectionState: {},
      trajectoryRecorder: null,
    },
    lifecycle: {
      readState: () => state,
      writeState: (nextState: PromptPhaseState) => Object.assign(state, nextState),
      getPrePromptMessageCount: () => prePromptMessageCount,
      setPrePromptMessageCount,
      setCurrentUserTimestampOverride: vi.fn(),
      setPromptCacheChangesForTurn,
      setFinalPromptText,
      markBeforeAgentRunBlocked,
      markYieldAborted,
      readYieldState: () => yieldState,
      stopAcceptingSteerMessages,
      takePendingMidTurnPrecheckRequest: () => undefined,
    },
  } as unknown as PromptPhaseInput;

  return {
    input,
    markYieldAborted,
    order,
    setFinalPromptText,
    setPrePromptMessageCount,
    setPromptCacheChangesForTurn,
    state,
    yieldState,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runEmbeddedAttemptPromptPhase", () => {
  it("runs prompt work in phase order and publishes prompt outputs", async () => {
    const fixture = createFixture();

    await expect(runEmbeddedAttemptPromptPhase(fixture.input)).resolves.toEqual({
      promptStartedAt: expect.any(Number),
    });

    expect(fixture.order).toEqual([
      "assembly",
      "context",
      "before-agent-run",
      "google-cache",
      "dispatch",
      "stop-steering",
    ]);
    expect(fixture.setPrePromptMessageCount).toHaveBeenCalledWith(2);
    expect(fixture.setPromptCacheChangesForTurn).toHaveBeenCalledWith([]);
    expect(fixture.setFinalPromptText).toHaveBeenCalledWith("hello");
    expect(mocks.dispatchPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({ transcriptLeafId: "leaf-1" }),
        submission: expect.objectContaining({
          leasedSteering: { leaseId: "lease-1", runIds: ["run-1"] },
          transcriptLeafId: "leaf-1",
        }),
      }),
    );
    expect(mocks.releasePendingSteering).not.toHaveBeenCalled();
  });

  it("reads yield state after submission fails and publishes abort state before recovery", async () => {
    const fixture = createFixture();
    const submissionError = new Error("submission failed");
    const yieldAbortSettled = Promise.resolve();
    mocks.dispatchPrompt.mockImplementation(async () => {
      fixture.order.push("dispatch");
      fixture.yieldState.yieldDetected = true;
      fixture.yieldState.yieldAbortSettled = yieldAbortSettled;
      fixture.yieldState.yieldMessage = "yield context";
      throw submissionError;
    });
    mocks.handlePromptError.mockImplementation(async (input: PromptErrorCall) => {
      fixture.order.push("prompt-error");
      expect(input.yieldDetected).toBe(true);
      expect(input.yieldAbortSettled).toBe(yieldAbortSettled);
      expect(input.yieldMessage).toBe("yield context");
      input.releaseLeasedSteering(input.error);
      input.markYieldAborted();
      return {};
    });

    await expect(runEmbeddedAttemptPromptPhase(fixture.input)).resolves.toEqual({
      promptStartedAt: expect.any(Number),
    });

    expect(fixture.order.slice(-4)).toEqual([
      "dispatch",
      "prompt-error",
      "yield-aborted",
      "stop-steering",
    ]);
    expect(fixture.markYieldAborted).toHaveBeenCalledOnce();
    expect(mocks.releasePendingSteering).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-1", runIds: ["run-1"] }),
    );
  });
});
