import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { persistHeartbeatOutcome } from "../../../infra/heartbeat-outcome-store.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../../state/openclaw-agent-db.js";

const mocks = vi.hoisted(() => ({
  applyPromptToolsAllow: vi.fn(),
  beforeAgentRun: vi.fn(),
  handlePromptError: vi.fn(),
  handleMidTurnPrecheck: vi.fn(),
  observePrompt: vi.fn(),
  prepareGooglePromptCache: vi.fn(),
  preparePromptAssembly: vi.fn(),
  preparePromptContext: vi.fn(),
  preparePromptExecution: vi.fn(),
  preparePromptPreflight: vi.fn(),
  releasePendingSteering: vi.fn(),
  removeTrailingPrecheckError: vi.fn(),
  resolveApiKey: vi.fn(),
  submitPrompt: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../subagents/registry/subagent-registry.js", () => ({
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
vi.mock("./attempt-prompt-build.js", () => ({
  prepareEmbeddedAttemptPromptAssembly: mocks.preparePromptAssembly,
  prepareEmbeddedAttemptPromptContext: mocks.preparePromptContext,
}));
vi.mock("./attempt-prompt-submit.js", () => ({
  handleEmbeddedAttemptPromptError: mocks.handlePromptError,
  submitEmbeddedAttemptPrompt: mocks.submitPrompt,
}));
vi.mock("./prompt-image-preparation.js", () => ({
  prepareEmbeddedAttemptPromptExecution: mocks.preparePromptExecution,
}));
vi.mock("./attempt-prompt-preflight.js", () => ({
  handleEmbeddedAttemptMidTurnPrecheck: mocks.handleMidTurnPrecheck,
  prepareEmbeddedAttemptPromptPreflight: mocks.preparePromptPreflight,
}));
vi.mock("./attempt-prompt-support.js", () => ({
  applyPromptBuildToolsAllow: mocks.applyPromptToolsAllow,
  observeEmbeddedAttemptPrompt: mocks.observePrompt,
}));
vi.mock("./attempt-transcript-helpers.js", () => ({
  removeTrailingMidTurnPrecheckAssistantError: mocks.removeTrailingPrecheckError,
}));

import { runEmbeddedAttemptPromptPhase } from "./attempt-prompt-phase.js";
import type { prepareEmbeddedAttemptPromptPreflight } from "./attempt-prompt-preflight.js";
import type { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";

type PromptPhaseInput = Parameters<typeof runEmbeddedAttemptPromptPhase>[0];
type PromptPhaseState = ReturnType<PromptPhaseInput["lifecycle"]["readState"]>;
type AssemblyCall = {
  applyPromptBuildToolsAllow: (toolsAllow: string[] | undefined) => string[];
  setLeasedSteering: (lease: { leaseId: string; runIds: string[] }) => void;
};
type PromptPreflightCall = Parameters<typeof prepareEmbeddedAttemptPromptPreflight>[0];
type PromptSubmissionCall = Parameters<typeof submitEmbeddedAttemptPrompt>[0];
type PromptErrorCall = {
  error: unknown;
  markYieldAborted: () => void;
  releaseLeasedSteering: (error?: unknown) => void;
  yieldAbortSettled: Promise<void> | null;
  yieldDetected: boolean;
  yieldMessage: string | null;
};

const tempStateDirs: string[] = [];

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
    input.applyPromptBuildToolsAllow(undefined);
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
      runtimeContextMessageForCurrentTurn: { role: "custom", content: "runtime" },
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
  mocks.preparePromptExecution.mockImplementation(async () => {
    order.push("images");
    return {
      images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      imageFactIndexes: [null],
      detectedRefs: [],
      failedMediaCount: 0,
      loadedCount: 1,
      skippedCount: 0,
    };
  });
  mocks.observePrompt.mockImplementation(() => {
    order.push("observe");
    return { skipPromptSubmission: false };
  });
  mocks.preparePromptPreflight.mockImplementation(async (preflightInput: PromptPreflightCall) => {
    order.push("preflight");
    return preflightInput.state;
  });
  mocks.submitPrompt.mockImplementation(async (submissionInput: PromptSubmissionCall) => {
    order.push("submit");
    submissionInput.onFinalPromptText("hello");
    submissionInput.onSteeringAcknowledged();
  });
  mocks.handlePromptError.mockResolvedValue({});
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
    withOwnedTranscriptWrite: async <T>(operation: () => Promise<T> | T) => await operation(),
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
      mediaOwnerAgentId: "main",
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
    toolPolicy: {
      current: {
        activeToolNames: ["read"],
        effectiveTools: [{ name: "read" }],
        uncompactedEffectiveTools: [{ name: "read" }],
        tools: [{ name: "read" }],
      },
      apply(toolsAllow: string[] | undefined) {
        Object.assign(this.current, mocks.applyPromptToolsAllow({ toolsAllow }));
        return this.current;
      },
      refresh: vi.fn(),
    },
    preflight: {
      compactionReplayEnabled: false,
      contextEngineAssemblySucceeded: false,
      contextEnginePromptAuthority: "assembled",
      includeBoundaryTimestamp: false,
      sessionAgentId: "main",
    },
    submission: {
      promptActiveSession: vi.fn(),
      toolResultPromptProjectionState: {},
      trajectoryRecorder: null,
    },
    lifecycle: {
      readState: () => state,
      writeState: (nextState: PromptPhaseState) => {
        order.push("publish");
        Object.assign(state, nextState);
      },
      getPrePromptMessageCount: () => prePromptMessageCount,
      setPrePromptMessageCount,
      setCurrentUserTimestampOverride: vi.fn(),
      setPromptCacheChangesForTurn,
      setFinalPromptText,
      markBeforeAgentRunBlocked,
      markYieldAborted,
      isRunBudgetTimeoutAbort: () => false,
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
  mocks.applyPromptToolsAllow.mockReturnValue({
    activeToolNames: ["read"],
    effectiveTools: [{ name: "read" }],
    uncompactedEffectiveTools: [{ name: "read" }],
    tools: [{ name: "read" }],
  });
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
  for (const stateDir of tempStateDirs.splice(0)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

describe("runEmbeddedAttemptPromptPhase", () => {
  it("does not claim heartbeat outcomes for detached user-triggered runs", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-prompt-phase-heartbeat-"));
    tempStateDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await upsertSessionEntryCore(
      { agentId: "main", env: process.env, sessionKey: "agent:main:main" },
      { sessionId: "prompt-phase-heartbeat-test", updatedAt: 1 },
    );
    persistHeartbeatOutcome({
      agentId: "main",
      sessionKey: "agent:main:main",
      runSessionKey: "agent:main:main:heartbeat",
      response: { outcome: "progress", notify: false, summary: "Heartbeat context" },
      occurredAt: 1,
      env: process.env,
    });
    const fixture = createFixture();
    Object.assign(fixture.input.attempt, {
      sessionKey: "agent:main:main",
      sessionPersistence: "detached",
      trigger: "user",
    });

    await runEmbeddedAttemptPromptPhase(fixture.input);

    expect(mocks.preparePromptContext.mock.calls[0]?.[0]).not.toHaveProperty(
      "heartbeatOutcomeContext",
    );
    expect(
      openOpenClawAgentDatabase({ agentId: "main", env: process.env })
        .db.prepare("SELECT context_run_id, context_claimed_at FROM heartbeat_outcomes")
        .get(),
    ).toEqual({ context_run_id: null, context_claimed_at: null });
  });

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
      "images",
      "observe",
      "publish",
      "preflight",
      "publish",
      "submit",
      "publish",
      "stop-steering",
    ]);
    expect(fixture.setPrePromptMessageCount).toHaveBeenCalledWith(2);
    expect(fixture.setPromptCacheChangesForTurn).toHaveBeenCalledWith([]);
    expect(fixture.setFinalPromptText).toHaveBeenCalledWith("hello");
    expect(mocks.preparePromptExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "hello",
        skipPromptSubmission: false,
      }),
    );
    expect(mocks.observePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        imageCount: 1,
        reserveTokens: 77,
        transcriptLeafId: "leaf-1",
      }),
    );
    expect(mocks.submitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ type: "image" })],
        leasedSteering: { leaseId: "lease-1", runIds: ["run-1"] },
        modelPrompt: "hello",
        runtimeContextMessage: expect.objectContaining({ content: "runtime" }),
        transcriptLeafId: "leaf-1",
        transcriptPrompt: "hello",
      }),
    );
    expect(mocks.releasePendingSteering).not.toHaveBeenCalled();
  });

  it("skips before_agent_run for settled-turn finalization", async () => {
    const fixture = createFixture();
    fixture.input.attempt.operation = "settled-tool-finalization";

    await runEmbeddedAttemptPromptPhase(fixture.input);

    expect(mocks.beforeAgentRun).not.toHaveBeenCalled();
    expect(fixture.order).toEqual([
      "assembly",
      "context",
      "google-cache",
      "images",
      "observe",
      "publish",
      "preflight",
      "publish",
      "submit",
      "publish",
      "stop-steering",
    ]);
  });

  it("admits the provider prompt when aggregate projection pressure is only heuristic", async () => {
    const fixture = createFixture();
    const preparePromptContext = mocks.preparePromptContext.getMockImplementation();
    mocks.preparePromptContext.mockImplementation(() => ({
      ...(preparePromptContext?.() as Record<string, unknown>),
      aggregatePressureEngaged: true,
    }));

    await runEmbeddedAttemptPromptPhase(fixture.input);

    expect(mocks.preparePromptExecution).toHaveBeenCalledWith(
      expect.objectContaining({ skipPromptSubmission: false }),
    );
    expect(mocks.submitPrompt).toHaveBeenCalledOnce();
  });

  it("reads yield state after submission fails and publishes abort state before recovery", async () => {
    const fixture = createFixture();
    const submissionError = new Error("submission failed");
    const yieldAbortSettled = Promise.resolve();
    mocks.submitPrompt.mockImplementation(async () => {
      fixture.order.push("submit");
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
      "submit",
      "prompt-error",
      "yield-aborted",
      "stop-steering",
    ]);
    expect(fixture.markYieldAborted).toHaveBeenCalledOnce();
    expect(mocks.releasePendingSteering).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-1", runIds: ["run-1"] }),
    );
  });

  it("keeps a run-budget timeout failure-free for partial-output salvage", async () => {
    const fixture = createFixture();
    const timeoutAbort = new Error("request timed out");
    mocks.submitPrompt.mockRejectedValueOnce(timeoutAbort);
    mocks.handlePromptError.mockResolvedValueOnce({
      promptFailure: { error: timeoutAbort, source: "prompt" },
    });
    fixture.input.lifecycle.isRunBudgetTimeoutAbort = (error) => error === timeoutAbort;

    await runEmbeddedAttemptPromptPhase(fixture.input);

    expect(fixture.state.promptError).toBeNull();
    expect(fixture.state.promptErrorSource).toBeNull();
  });

  it("records a provider failure that races a run-budget timeout", async () => {
    const fixture = createFixture();
    const providerError = new Error("provider failed");
    mocks.submitPrompt.mockRejectedValueOnce(providerError);
    mocks.handlePromptError.mockResolvedValueOnce({
      promptFailure: { error: providerError, source: "prompt" },
    });
    fixture.input.lifecycle.isRunBudgetTimeoutAbort = () => false;

    await runEmbeddedAttemptPromptPhase(fixture.input);

    expect(fixture.state.promptError).toBe(providerError);
    expect(fixture.state.promptErrorSource).toBe("prompt");
  });

  it("releases steering when preflight skips provider submission", async () => {
    const fixture = createFixture();
    const promptError = new Error("preflight rejected");
    mocks.preparePromptExecution.mockResolvedValueOnce({
      images: [],
      imageFactIndexes: [],
      detectedRefs: [],
      failedMediaCount: 1,
      loadedCount: 0,
      skippedCount: 1,
    });
    mocks.observePrompt.mockImplementationOnce(() => {
      fixture.order.push("observe");
      return { skipPromptSubmission: true };
    });
    mocks.preparePromptPreflight.mockImplementationOnce(
      async (preflightInput: PromptPreflightCall) => {
        fixture.order.push("preflight");
        return {
          ...preflightInput.state,
          promptError,
          promptErrorSource: "precheck",
        };
      },
    );

    await runEmbeddedAttemptPromptPhase(fixture.input);

    expect(fixture.state.promptError).toBe(promptError);
    expect(mocks.releasePendingSteering).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "preflight rejected",
        leaseId: "lease-1",
        runIds: ["run-1"],
      }),
    );
    expect(mocks.submitPrompt).not.toHaveBeenCalled();
  });

  it("publishes preflight state before a submission failure", async () => {
    const fixture = createFixture();
    const promptError = new Error("admission warning");
    const submitError = new Error("provider failed");
    mocks.preparePromptPreflight.mockImplementationOnce(
      async (preflightInput: PromptPreflightCall) => {
        fixture.order.push("preflight");
        return {
          ...preflightInput.state,
          promptError,
          promptErrorSource: "precheck",
        };
      },
    );
    mocks.submitPrompt.mockImplementationOnce(async () => {
      fixture.order.push("submit");
      expect(fixture.state.promptError).toBe(promptError);
      throw submitError;
    });
    mocks.handlePromptError.mockImplementationOnce(async (errorInput: PromptErrorCall) => {
      fixture.order.push("prompt-error");
      expect(errorInput.error).toBe(submitError);
      return {};
    });

    await runEmbeddedAttemptPromptPhase(fixture.input);

    expect(fixture.order.slice(-5)).toEqual([
      "preflight",
      "publish",
      "submit",
      "prompt-error",
      "stop-steering",
    ]);
  });
});
