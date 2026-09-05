import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { prepareSystemAgentRunAdmission } from "../../admitted-run-context.js";
import {
  applyAgentAutoCompactionGuard,
  applyAgentCompactionSettingsFromConfig,
} from "../../agent-settings.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createAutoCompactionSettings,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import type { AgentSessionEvent } from "../../sessions/agent-session-types.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { resolveEmbeddedAgentStream } from "../stream-resolution.js";

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
vi.mock("./attempt-finalize.js", async (importOriginal) => {
  const { resolveEmbeddedAbortSettleTimeoutMs } =
    await importOriginal<typeof import("./attempt-finalize.js")>();
  return {
    createEmbeddedAttemptRunAbort: mocks.createRunAbort,
    resolveEmbeddedAbortSettleTimeoutMs,
  };
});
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
import type { EmbeddedContextAccountingEvent } from "./internal-params.js";

type ExecutionInput = Parameters<typeof runEmbeddedAttemptExecutionPhase>[0];

registerAgentSessionLoopTestLifecycle();
afterEach(() => vi.restoreAllMocks());

async function createFixture(
  options: {
    aborted?: boolean;
    exerciseTerminalMerges?: boolean;
  } = {},
) {
  const admission = prepareSystemAgentRunAdmission({}, "run-1", "main", "execution-phase-test");
  onTestFinished(admission.close);
  const admittedRunContext = await admission.admit("embedded");
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
      admittedRunContext,
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
    admission,
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
  it.each([
    { owner: "active", phase: "during summarization" },
    { owner: "replaced", phase: "during summarization" },
    { owner: "closed", phase: "during summarization" },
    { owner: "replaced", phase: "before installation" },
    { owner: "closed", phase: "before installation" },
    { owner: "cancelled", phase: "before installation" },
  ] as const)(
    "fences automatic memory compaction with admission $owner $phase",
    async ({ owner, phase }) => {
      const fixture = await createFixture({ exerciseTerminalMerges: false });
      const { admission } = fixture;
      const replacement = prepareSystemAgentRunAdmission({}, "run-1", "main", "compaction-test");
      const admittedRunContext = await admission.admit("embedded");
      const model = { ...testModel, api: "compaction-test-api", contextWindow: 4_096 };
      const settingsManager = createAutoCompactionSettings();
      applyAgentCompactionSettingsFromConfig({ settingsManager, contextTokenBudget: 4_096 });
      applyAgentAutoCompactionGuard({ settingsManager, compactionMode: "default" });
      const sessionManager = guardSessionManager(SessionManager.inMemory(), { runId: "run-1" });
      sessionManager.appendMessage({ role: "user", content: "Remember Blue Heron", timestamp: 1 });
      sessionManager.appendMessage({
        ...createAssistant(model, [{ type: "text", text: "Blue Heron is the project." }]),
        timestamp: 2,
      });
      const { session } = await createTestSession({
        model,
        sessionManager,
        settingsManager,
        contextOverflowRecoveryOwner: "caller",
      });
      session.agent.streamFn = resolveEmbeddedAgentStream({
        currentStreamFn: session.agent.streamFn,
        model,
        sessionId: session.sessionId,
        signal: fixture.input.runAbortController.signal,
      }).streamFn;
      const summaryStarted = createDeferred();
      const releaseSummary = createDeferred();
      const events: EmbeddedContextAccountingEvent[] = [];
      const ends: AgentSessionEvent[] = [];
      session.subscribe((event) => {
        if (event.type === "compaction_end") {
          ends.push(event);
          if (event.outcome.status === "completed") {
            expect(events).toHaveLength(1);
            expect(fixture.skillInstructionDeliveryCache.size).toBe(0);
          }
        }
      });
      let requests = 0;
      streamMocks.streamSimple.mockImplementation(async (activeModel, _context, options) => {
        if (++requests === 1) {
          return createAssistantResultStream(
            createAssistant(
              activeModel,
              [{ type: "text", text: "Blue Heron answer" }],
              "stop",
              4_090,
            ),
          );
        }
        summaryStarted.resolve();
        await releaseSummary.promise;
        expect(options?.signal?.aborted).toBe(false);
        return createAssistantResultStream(
          createAssistant(activeModel, [{ type: "text", text: "Blue Heron summary" }]),
        );
      });
      const network = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("Unexpected network request"));
      Object.assign(fixture.input.attempt, {
        admittedRunContext,
        model,
        modelId: model.id,
        provider: model.provider,
        sessionManager,
        onContextAccountingEvent: (event: EmbeddedContextAccountingEvent) => events.push(event),
      });
      Object.assign(fixture.input.prepared.sessionRuntime, {
        sessionManager,
        cacheTrace: undefined,
        anthropicPayloadLogger: undefined,
        isOpenAIResponsesApi: false,
      });
      Object.assign(fixture.input.prepared.sessionRuntime.agentSession, {
        activeSession: session,
        settingsManager,
      });
      const { installEmbeddedAttemptStreamGuards } =
        await vi.importActual<typeof import("./attempt-stream.js")>("./attempt-stream.js");
      mocks.installStreamGuards.mockImplementation(installEmbeddedAttemptStreamGuards);
      mocks.runSettledPhase.mockImplementation(async ({ preparedStreamRuntime }) => {
        await preparedStreamRuntime.promptActiveSession("Continue Blue Heron");
        return fixture.result;
      });
      const retireAdmission = async () => {
        if (owner === "replaced") {
          await replacement.admit("embedded");
        } else if (owner === "closed" || owner === "cancelled") {
          admission.close();
          if (owner === "cancelled") {
            fixture.input.runAbortController.abort(cancelled);
          }
        }
      };
      const cancelled = new Error("caller stopped during preparation");
      let entriesBefore = structuredClone(sessionManager.getEntries());
      let messagesBefore = structuredClone(session.messages);
      if (phase === "before installation") {
        await retireAdmission();
      }
      const work = runEmbeddedAttemptExecutionPhase(fixture.input);
      const outcome = work.then(
        () => undefined,
        (error: unknown) => error,
      );
      try {
        expect(session.autoCompactionEnabled).toBe(true);
        if (phase === "during summarization") {
          await Promise.race([summaryStarted.promise, work]);
          expect(session.isCompacting).toBe(true);
          entriesBefore = structuredClone(sessionManager.getEntries());
          messagesBefore = structuredClone(session.messages);
          await retireAdmission();
        }
        releaseSummary.resolve();
        const error = await outcome;
        const compacted = sessionManager
          .getEntries()
          .filter((entry) => entry.type === "compaction");
        expect(compacted).toHaveLength(owner === "active" ? 1 : 0);
        if (phase === "before installation") {
          if (owner === "cancelled") {
            expect(error).toBe(cancelled);
          } else {
            expect(error).toMatchObject({
              message: expect.stringContaining("active admitted run"),
            });
          }
          expect(requests).toBe(0);
          expect(ends).toEqual([]);
        } else {
          expect(error).toBeUndefined();
          expect(ends).toMatchObject([
            {
              type: "compaction_end",
              reason: "threshold",
              outcome: { status: owner === "active" ? "completed" : "failed" },
            },
          ]);
        }
        expect(events).toHaveLength(owner === "active" ? 1 : 0);
        expect(fixture.skillInstructionDeliveryCache.size).toBe(owner === "active" ? 0 : 1);
        if (owner !== "active") {
          expect(sessionManager.getEntries()).toEqual(entriesBefore);
          expect(session.messages).toEqual(messagesBefore);
        }
        expect(network).not.toHaveBeenCalled();
      } finally {
        releaseSummary.resolve();
        await Promise.allSettled([work]);
        admission.close();
        replacement.close();
      }
    },
  );

  it("prepares guarded history, stream handling, deadlines, and settlement in order", async () => {
    const fixture = await createFixture();

    const result = await runEmbeddedAttemptExecutionPhase(fixture.input);

    expect(result).toBe(fixture.result);
    expect(fixture.setContextReplacementHook).toHaveBeenCalledOnce();
    const replacementHook = fixture.setContextReplacementHook.mock.calls[0]?.[0];
    expect(replacementHook).toEqual(expect.any(Function));
    replacementHook?.(40);
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

  it("publishes the replacement fact and invalidates the skill cache before attempt cleanup throws", async () => {
    const fixture = await createFixture({ exerciseTerminalMerges: false });
    const events: EmbeddedContextAccountingEvent[] = [];
    Object.assign(fixture.input.attempt, {
      onContextAccountingEvent: (event: EmbeddedContextAccountingEvent) => {
        events.push(event);
      },
    });
    const cleanupError = new Error("attempt cleanup failed after compaction committed");
    let eventsBeforeCleanup: EmbeddedContextAccountingEvent[] | undefined;
    let cacheSizeBeforeCleanup: number | undefined;
    mocks.runSettledPhase.mockImplementationOnce(async () => {
      const replacementHook = fixture.setContextReplacementHook.mock.calls[0]?.[0];
      if (typeof replacementHook !== "function") {
        throw new Error("expected the attempt-owned context replacement hook");
      }
      replacementHook(40);
      eventsBeforeCleanup = [...events];
      cacheSizeBeforeCleanup = fixture.skillInstructionDeliveryCache.size;
      throw cleanupError;
    });

    await expect(runEmbeddedAttemptExecutionPhase(fixture.input)).rejects.toBe(cleanupError);

    expect(eventsBeforeCleanup).toEqual([{ kind: "compaction", tokensAfter: 40 }]);
    expect(cacheSizeBeforeCleanup).toBe(0);
  });

  it("does not start a prompt after external cancellation", async () => {
    const fixture = await createFixture();
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

  it("closes the real execution deadline when the provider idle owner aborts locally", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fixture = await createFixture({ exerciseTerminalMerges: false });
    fixture.input.attempt.timeoutMs = 100;
    const onAttemptDeadlineChanged = vi.fn();
    fixture.input.attempt.onAttemptDeadlineChanged = onAttemptDeadlineChanged;
    const idleError = new Error("provider idle timeout");
    fixture.runAbort.mockImplementation(() => fixture.input.runAbortController.abort(idleError));
    const { prepareEmbeddedAttemptTimeout } = await vi.importActual<
      typeof import("./attempt-timeout-prepare.js")
    >("./attempt-timeout-prepare.js");
    mocks.prepareTimeout.mockImplementationOnce(prepareEmbeddedAttemptTimeout);
    mocks.runSettledPhase.mockImplementationOnce(async (settledInput) => {
      try {
        expect(onAttemptDeadlineChanged.mock.calls).toEqual([
          [{ kind: "bounded", deadlineAtMs: 100 }],
        ]);
        mocks.installStreamGuards.mock.calls[0]?.[0].onIdleTimeout(idleError);
        await vi.advanceTimersByTimeAsync(200);

        expect(fixture.runAbort).toHaveBeenCalledExactlyOnceWith(true, idleError);
        expect(fixture.state.terminal).toEqual({
          kind: "timeout",
          phase: "prompt",
          source: "idle",
        });
        expect(onAttemptDeadlineChanged).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
        return fixture.result;
      } finally {
        settledInput.preparedStreamRuntime.timeout.clearTimers();
      }
    });
    try {
      await expect(runEmbeddedAttemptExecutionPhase(fixture.input)).resolves.toBe(fixture.result);
    } finally {
      vi.useRealTimers();
    }
  });

  it("attributes an idle timeout during authoritative compaction to compaction", async () => {
    const fixture = await createFixture({ exerciseTerminalMerges: false });
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
    const fixture = await createFixture({ aborted: true });
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
