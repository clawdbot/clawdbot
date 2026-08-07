import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerPendingAgentQuestion } from "../../harness/gateway-question.js";
import {
  projectToolSearchTargetTranscriptMessages,
  type ToolSearchTargetTranscriptProjection,
} from "../../tool-search.js";

const mocks = vi.hoisted(() => ({
  buildSubscriptionParams: vi.fn(),
  clearActiveRun: vi.fn(),
  notifyToolActivity: vi.fn(),
  runBeforeFinalizeHook: vi.fn(),
  setActiveRun: vi.fn(),
  subscribe: vi.fn(),
}));

vi.mock("../../embedded-agent-subscribe.js", () => ({
  subscribeEmbeddedAgentSession: mocks.subscribe,
}));
vi.mock("../runs.js", () => ({
  clearActiveEmbeddedRun: mocks.clearActiveRun,
  setActiveEmbeddedRun: mocks.setActiveRun,
}));
vi.mock("./attempt.subscription-cleanup.js", () => ({
  buildEmbeddedSubscriptionParams: mocks.buildSubscriptionParams,
}));
vi.mock("./tool-activity-heartbeat.js", () => ({
  notifyToolActivity: mocks.notifyToolActivity,
}));
vi.mock("../../harness/lifecycle-hook-helpers.js", () => ({
  runAgentHarnessBeforeAgentFinalizeHook: mocks.runBeforeFinalizeHook,
}));

import { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";
import { SESSIONS_YIELD_ABORT_REASON } from "./attempt.sessions-yield.js";

type AgentSessionSteerReceipt = {
  committed: Promise<void>;
  cancel(): boolean;
};

function createDeferredReceipt(cancel: () => boolean = () => false): {
  receipt: AgentSessionSteerReceipt;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const committed = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  void committed.catch(() => {});
  return {
    receipt: { committed, cancel },
    resolve,
    reject,
  };
}

function prepareCatalogExecutor(
  projections: ToolSearchTargetTranscriptProjection[],
  options?: {
    getRunState?: () => {
      aborted: boolean;
      promptError: unknown;
      timedOut: boolean;
      yieldDetected: boolean;
    };
    runAbortController?: AbortController;
    sandboxSessionKey?: string;
    sessionKey?: string;
    activeSession?: Parameters<typeof prepareEmbeddedAttemptStream>[0]["activeSession"];
    trajectoryRecorder?: Parameters<typeof prepareEmbeddedAttemptStream>[0]["trajectoryRecorder"];
  },
) {
  const runAbortController = options?.runAbortController ?? new AbortController();
  return prepareEmbeddedAttemptStream({
    attempt: {
      runId: "run-output-schema",
      sessionId: "session-output-schema",
      sessionKey: options?.sessionKey ?? "agent:main:main",
    } as never,
    activeSession: options?.activeSession ?? ({ agent: {}, isStreaming: false } as never),
    hookRunner: undefined as never,
    hookAgentId: "main",
    diagnosticTrace: {} as never,
    clientToolCallSlots: [],
    toolSearchTargetTranscriptProjections: projections,
    isReplaySafeTool: () => false,
    runAbortController,
    abortRun: vi.fn(),
    markExternalAbort: vi.fn(),
    getRunState:
      options?.getRunState ??
      (() => ({
        aborted: false,
        promptError: undefined,
        timedOut: false,
        yieldDetected: false,
      })),
    hasDeliveredSourceReply: () => false,
    markSourceReplyDelivered: vi.fn(),
    onBlockReply: vi.fn(),
    onBlockReplyFlush: vi.fn(),
    sandboxSessionKey: options?.sandboxSessionKey ?? "agent:main:main",
    builtinToolNames: new Set(),
    replaySafeToolNames: new Set(),
    trajectoryRecorder: options?.trajectoryRecorder,
  });
}

describe("prepareEmbeddedAttemptStream", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.buildSubscriptionParams.mockImplementation((params) => params);
    mocks.subscribe.mockReturnValue({
      toolMetas: [],
      runToolLifecycle: vi.fn(async ({ execute }) => await execute()),
      isCompacting: vi.fn(() => false),
    });
    mocks.runBeforeFinalizeHook.mockResolvedValue({ action: "continue" });
  });

  it("uses the persisted assistant entry id and closes steering during revision settlement", async () => {
    let resolveHook: ((value: { action: "revise"; reason: string }) => void) | undefined;
    mocks.runBeforeFinalizeHook.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveHook = resolve;
        }),
    );
    const prepared = prepareEmbeddedAttemptStream({
      attempt: {
        runId: "run-finalize-id",
        sessionId: "session-finalize-id",
        sessionKey: "agent:main:main",
        maxBeforeAgentFinalizeRevisions: 3,
        beforeAgentFinalizeRevisionAttempts: 0,
      } as never,
      activeSession: {
        agent: { hasQueuedMessages: () => false },
        isStreaming: false,
        messages: [],
        pendingMessageCount: 0,
      } as never,
      hookRunner: { hasHooks: (name: string) => name === "before_agent_finalize" } as never,
      hookAgentId: "main",
      diagnosticTrace: {} as never,
      clientToolCallSlots: [],
      toolSearchTargetTranscriptProjections: [],
      isReplaySafeTool: () => false,
      runAbortController: new AbortController(),
      abortRun: vi.fn(),
      markExternalAbort: vi.fn(),
      getRunState: () => ({
        aborted: false,
        promptError: undefined,
        timedOut: false,
        yieldDetected: false,
      }),
      hasDeliveredSourceReply: () => false,
      markSourceReplyDelivered: vi.fn(),
      onBlockReply: vi.fn(),
      onBlockReplyFlush: vi.fn(),
      sandboxSessionKey: "agent:main:main",
      builtinToolNames: new Set(),
      replaySafeToolNames: new Set(),
    });
    const subscriptionInput = mocks.buildSubscriptionParams.mock.calls.at(-1)?.[0] as {
      onBeforeTerminalDelivery?: (event: unknown) => Promise<unknown>;
    };
    const decision = subscriptionInput.onBeforeTerminalDelivery?.({
      messages: [],
      willRetry: false,
      assistantEntryId: "canonical-entry-id",
      lastAssistant: {
        role: "assistant",
        content: [{ type: "text", text: "Draft answer" }],
        stopReason: "stop",
      },
      assistantTexts: ["Draft answer"],
      hasAssistantVisibleText: true,
      isError: false,
      incompleteTerminalAssistant: false,
      hadDeterministicSideEffect: false,
    });

    await vi.waitFor(() => expect(mocks.runBeforeFinalizeHook).toHaveBeenCalledOnce());
    expect(prepared.queueHandle.isStopped?.()).toBe(true);
    await expect(prepared.queueHandle.queueMessage("too late")).rejects.toThrow(
      "active session is finalizing",
    );

    resolveHook?.({ action: "revise", reason: "Tighten the answer" });
    await expect(decision).resolves.toEqual({ suppressTerminalDelivery: true });
    expect(prepared.getBeforeAgentFinalizeRevisionEntryId()).toBe("canonical-entry-id");
    expect(prepared.queueHandle.isStopped?.()).toBe(true);
  });

  it("keeps already-started steering authoritative over finalization", async () => {
    let resolveSteer: (() => void) | undefined;
    const activeSession = {
      agent: { hasQueuedMessages: () => false },
      isStreaming: false,
      messages: [],
      pendingMessageCount: 0,
      steer: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveSteer = resolve;
          }),
      ),
      subscribe: vi.fn(() => () => {}),
    };
    const prepared = prepareEmbeddedAttemptStream({
      attempt: {
        runId: "run-finalize-steer",
        sessionId: "session-finalize-steer",
        sessionKey: "agent:main:main",
        maxBeforeAgentFinalizeRevisions: 3,
        beforeAgentFinalizeRevisionAttempts: 0,
      } as never,
      activeSession: activeSession as never,
      hookRunner: { hasHooks: (name: string) => name === "before_agent_finalize" } as never,
      hookAgentId: "main",
      diagnosticTrace: {} as never,
      clientToolCallSlots: [],
      toolSearchTargetTranscriptProjections: [],
      isReplaySafeTool: () => false,
      runAbortController: new AbortController(),
      abortRun: vi.fn(),
      markExternalAbort: vi.fn(),
      getRunState: () => ({
        aborted: false,
        promptError: undefined,
        timedOut: false,
        yieldDetected: false,
      }),
      hasDeliveredSourceReply: () => false,
      markSourceReplyDelivered: vi.fn(),
      onBlockReply: vi.fn(),
      onBlockReplyFlush: vi.fn(),
      sandboxSessionKey: "agent:main:main",
      builtinToolNames: new Set(),
      replaySafeToolNames: new Set(),
    });
    const queued = prepared.queueHandle.queueMessage("new user input");
    const subscriptionInput = mocks.buildSubscriptionParams.mock.calls.at(-1)?.[0] as {
      onBeforeTerminalDelivery?: (event: unknown) => Promise<unknown>;
    };

    await expect(
      subscriptionInput.onBeforeTerminalDelivery?.({
        messages: [],
        willRetry: false,
        assistantEntryId: "canonical-entry-id",
        lastAssistant: {
          role: "assistant",
          content: [{ type: "text", text: "Draft answer" }],
          stopReason: "stop",
        },
        assistantTexts: ["Draft answer"],
        hasAssistantVisibleText: true,
        isError: false,
        incompleteTerminalAssistant: false,
        hadDeterministicSideEffect: false,
      }),
    ).resolves.toBeUndefined();

    expect(mocks.runBeforeFinalizeHook).not.toHaveBeenCalled();
    expect(prepared.queueHandle.isStopped?.()).toBe(false);
    resolveSteer?.();
    await queued;
  });

  it("records queued prompt provenance only after transcript commitment", async () => {
    const origin = {
      kind: "inter_session" as const,
      sourceSessionKey: "agent:sender:main",
      sourceChannel: "internal",
      sourceTool: "sessions_send",
    };
    const deferred = createDeferredReceipt();
    const message = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "delegated work" }],
      timestamp: 1,
      provenance: origin,
    };
    const activeSession = {
      agent: {
        hasQueuedMessages: () => true,
        steeringQueue: { messages: [message] },
      },
      isStreaming: true,
      messages: [message],
      pendingMessageCount: 1,
      steer: vi.fn(async () => undefined),
      steerWithReceipt: vi.fn(async () => deferred.receipt),
      subscribe: vi.fn(() => () => undefined),
    };
    const recordEvent = vi.fn();
    const prepared = prepareEmbeddedAttemptStream({
      attempt: {
        runId: "run-active-delegation",
        sessionId: "session-active-delegation",
        sessionKey: "agent:receiver:main",
      } as never,
      activeSession: activeSession as never,
      hookRunner: undefined as never,
      hookAgentId: "receiver",
      diagnosticTrace: {} as never,
      clientToolCallSlots: [],
      toolSearchTargetTranscriptProjections: [],
      isReplaySafeTool: () => false,
      runAbortController: new AbortController(),
      abortRun: vi.fn(),
      markExternalAbort: vi.fn(),
      getRunState: () => ({
        aborted: false,
        promptError: undefined,
        timedOut: false,
        yieldDetected: false,
      }),
      hasDeliveredSourceReply: () => false,
      markSourceReplyDelivered: vi.fn(),
      onBlockReply: vi.fn(),
      onBlockReplyFlush: vi.fn(),
      sandboxSessionKey: "agent:receiver:main",
      builtinToolNames: new Set(),
      replaySafeToolNames: new Set(),
      trajectoryRecorder: { recordEvent } as never,
    });

    const queued = prepared.queueHandle.queueMessage("delegated work", {
      deliveryTimeoutMs: 10_000,
      waitForTranscriptCommit: true,
      inputProvenance: origin,
    });
    await vi.waitFor(() => expect(activeSession.steerWithReceipt).toHaveBeenCalledOnce());
    expect(recordEvent).not.toHaveBeenCalled();

    deferred.resolve();
    await queued;

    expect(recordEvent).toHaveBeenCalledOnce();
    expect(recordEvent).toHaveBeenCalledWith("prompt.submitted", {
      prompt: "delegated work",
      messages: [message],
      imagesCount: 0,
      origin,
    });
  });

  it("does not record a pending-input answer as a queued prompt", async () => {
    const sessionKey = "agent:receiver:pending-answer";
    const origin = {
      kind: "inter_session" as const,
      sourceSessionKey: "agent:sender:main",
      sourceTool: "sessions_send",
    };
    const answers = { answers: { answer: ["Continue"] } };
    const pending = registerPendingAgentQuestion({
      questionId: "ask_pending_answer",
      sessionKey,
      questions: [
        {
          id: "answer",
          header: "Answer",
          question: "What should happen?",
          isOther: true,
          options: [],
        },
      ],
      gatewayCall: vi.fn(async () => ({ status: "answered", answers })),
      answer: Promise.resolve({ status: "answered", answers }),
    });
    const steer = vi.fn(async () => undefined);
    const recordEvent = vi.fn();
    const prepared = prepareCatalogExecutor([], {
      sessionKey,
      activeSession: {
        agent: {},
        isStreaming: true,
        messages: [],
        steer,
        subscribe: vi.fn(() => () => undefined),
      } as never,
      trajectoryRecorder: { recordEvent } as never,
    });

    try {
      await expect(
        prepared.queueHandle.queueMessage("Continue", {
          isInboundUserMessage: true,
          waitForTranscriptCommit: true,
          inputProvenance: origin,
        }),
      ).resolves.toBeUndefined();
      expect(steer).not.toHaveBeenCalled();
      expect(recordEvent).not.toHaveBeenCalled();
    } finally {
      pending.dispose();
    }
  });

  it("does not record steering when transcript confirmation was not requested", async () => {
    const origin = {
      kind: "inter_session" as const,
      sourceSessionKey: "agent:sender:main",
      sourceTool: "sessions_send",
    };
    const steer = vi.fn(async () => undefined);
    const recordEvent = vi.fn();
    const prepared = prepareCatalogExecutor([], {
      activeSession: {
        agent: {},
        isStreaming: true,
        messages: [],
        steer,
        subscribe: vi.fn(() => () => undefined),
      } as never,
      trajectoryRecorder: { recordEvent } as never,
    });

    await expect(
      prepared.queueHandle.queueMessage("fire and continue", {
        inputProvenance: origin,
      }),
    ).resolves.toBeUndefined();
    expect(steer).toHaveBeenCalledOnce();
    expect(recordEvent).not.toHaveBeenCalled();
  });

  it("records each identical queued prompt from only its exact committed receipt", async () => {
    const firstOrigin = {
      kind: "inter_session" as const,
      sourceSessionKey: "agent:first:main",
      sourceTool: "sessions_send",
    };
    const secondOrigin = {
      kind: "inter_session" as const,
      sourceSessionKey: "agent:second:main",
      sourceTool: "sessions_send",
    };
    const firstMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "same delegated work" }],
      timestamp: 1,
      provenance: firstOrigin,
    };
    const secondMessage = {
      role: "user" as const,
      content: [{ type: "text" as const, text: "same delegated work" }],
      timestamp: 2,
      provenance: secondOrigin,
    };
    const firstReceipt = createDeferredReceipt();
    const secondReceipt = createDeferredReceipt();
    const receipts = [firstReceipt.receipt, secondReceipt.receipt];
    const activeSession = {
      agent: { hasQueuedMessages: () => true },
      isStreaming: true,
      messages: [firstMessage, secondMessage],
      pendingMessageCount: 2,
      steer: vi.fn(async () => undefined),
      steerWithReceipt: vi.fn(async () => receipts.shift()!),
      subscribe: vi.fn(() => () => undefined),
    };
    const recordEvent = vi.fn();
    const prepared = prepareEmbeddedAttemptStream({
      attempt: {
        runId: "run-identical-delegation",
        sessionId: "session-identical-delegation",
        sessionKey: "agent:receiver:main",
      } as never,
      activeSession: activeSession as never,
      hookRunner: undefined as never,
      hookAgentId: "receiver",
      diagnosticTrace: {} as never,
      clientToolCallSlots: [],
      toolSearchTargetTranscriptProjections: [],
      isReplaySafeTool: () => false,
      runAbortController: new AbortController(),
      abortRun: vi.fn(),
      markExternalAbort: vi.fn(),
      getRunState: () => ({
        aborted: false,
        promptError: undefined,
        timedOut: false,
        yieldDetected: false,
      }),
      hasDeliveredSourceReply: () => false,
      markSourceReplyDelivered: vi.fn(),
      onBlockReply: vi.fn(),
      onBlockReplyFlush: vi.fn(),
      sandboxSessionKey: "agent:receiver:main",
      builtinToolNames: new Set(),
      replaySafeToolNames: new Set(),
      trajectoryRecorder: { recordEvent } as never,
    });

    const firstQueued = prepared.queueHandle.queueMessage("same delegated work", {
      waitForTranscriptCommit: true,
      inputProvenance: firstOrigin,
    });
    const secondQueued = prepared.queueHandle.queueMessage("same delegated work", {
      waitForTranscriptCommit: true,
      inputProvenance: secondOrigin,
    });
    await vi.waitFor(() => expect(activeSession.steerWithReceipt).toHaveBeenCalledTimes(2));

    firstReceipt.resolve();
    await firstQueued;
    expect(recordEvent).toHaveBeenCalledTimes(1);
    expect(recordEvent).toHaveBeenLastCalledWith(
      "prompt.submitted",
      expect.objectContaining({ origin: firstOrigin }),
    );

    secondReceipt.resolve();
    await secondQueued;
    expect(recordEvent).toHaveBeenCalledTimes(2);
    expect(recordEvent).toHaveBeenLastCalledWith(
      "prompt.submitted",
      expect.objectContaining({ origin: secondOrigin }),
    );
  });

  it.each([
    {
      name: "runtime rejection",
      runtimeReject: true,
      persistenceReject: false,
      cancelResult: false,
      timeoutMs: 10_000,
      expectedError: "steering rejected",
    },
    {
      name: "transcript timeout",
      runtimeReject: false,
      persistenceReject: false,
      cancelResult: true,
      timeoutMs: 1,
      expectedError: "before timeout",
    },
    {
      name: "accepted without transcript confirmation",
      runtimeReject: false,
      persistenceReject: false,
      cancelResult: false,
      timeoutMs: 1,
      expectedError: undefined,
    },
    {
      name: "transcript persistence failure",
      runtimeReject: false,
      persistenceReject: true,
      cancelResult: false,
      timeoutMs: 10_000,
      expectedError: "transcript write failed",
    },
  ])("does not record queued prompt provenance after $name", async (testCase) => {
    vi.useFakeTimers();
    try {
      const origin = {
        kind: "inter_session" as const,
        sourceSessionKey: "agent:sender:main",
        sourceTool: "sessions_send",
      };
      const deferred = createDeferredReceipt(() => testCase.cancelResult);
      const steerWithReceipt = testCase.runtimeReject
        ? vi.fn(async () => {
            throw new Error("steering rejected");
          })
        : vi.fn(async () => deferred.receipt);
      const recordEvent = vi.fn();
      const prepared = prepareEmbeddedAttemptStream({
        attempt: {
          runId: `run-${testCase.name}`,
          sessionId: `session-${testCase.name}`,
          sessionKey: "agent:receiver:main",
        } as never,
        activeSession: {
          agent: {
            hasQueuedMessages: () => true,
          },
          isStreaming: true,
          messages: [],
          pendingMessageCount: 1,
          steer: vi.fn(async () => undefined),
          steerWithReceipt,
          subscribe: vi.fn(() => () => undefined),
        } as never,
        hookRunner: undefined as never,
        hookAgentId: "receiver",
        diagnosticTrace: {} as never,
        clientToolCallSlots: [],
        toolSearchTargetTranscriptProjections: [],
        isReplaySafeTool: () => false,
        runAbortController: new AbortController(),
        abortRun: vi.fn(),
        markExternalAbort: vi.fn(),
        getRunState: () => ({
          aborted: false,
          promptError: undefined,
          timedOut: false,
          yieldDetected: false,
        }),
        hasDeliveredSourceReply: () => false,
        markSourceReplyDelivered: vi.fn(),
        onBlockReply: vi.fn(),
        onBlockReplyFlush: vi.fn(),
        sandboxSessionKey: "agent:receiver:main",
        builtinToolNames: new Set(),
        replaySafeToolNames: new Set(),
        trajectoryRecorder: { recordEvent } as never,
      });

      const queued = prepared.queueHandle.queueMessage("delegated work", {
        deliveryTimeoutMs: testCase.timeoutMs,
        waitForTranscriptCommit: true,
        inputProvenance: origin,
      });
      const outcome = testCase.expectedError
        ? expect(queued).rejects.toThrow(testCase.expectedError)
        : expect(queued).resolves.toMatchObject({ transcriptCommit: "unconfirmed" });
      if (testCase.persistenceReject) {
        await vi.waitFor(() => expect(steerWithReceipt).toHaveBeenCalledOnce());
        deferred.reject(new Error("transcript write failed"));
      }
      await vi.advanceTimersByTimeAsync(testCase.timeoutMs + 1);

      await outcome;
      expect(recordEvent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes live events to the transcript session instead of the sandbox authority session", () => {
    prepareCatalogExecutor([], {
      sessionKey: "agent:main:internal-session-effects:companion-run",
      sandboxSessionKey: "agent:main:main",
    });

    expect(mocks.buildSubscriptionParams).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:internal-session-effects:companion-run",
      }),
    );
  });

  it("validates hidden tool results before queuing transcript projections", async () => {
    const projections: ToolSearchTargetTranscriptProjection[] = [];
    const rawResult = {
      content: [{ type: "text" as const, text: "rejected raw result" }],
      details: { id: 42, unexpected: "must-not-enter-transcript" },
    };
    const prepared = prepareCatalogExecutor(projections);

    await expect(
      prepared.toolSearchCatalogExecutor({
        tool: {
          name: "orchard_bad_output",
          description: "Return a rejected orchard result",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: vi.fn(async () => rawResult),
        } as never,
        toolName: "orchard_bad_output",
        source: "openclaw",
        sourceName: "fixture-plugin",
        toolCallId: "call-output-schema",
        parentToolCallId: "call-code-mode",
        input: {},
        acceptResultBeforeProjection: async (candidate) => {
          expect(candidate).toBe(rawResult);
          expect(projections).toHaveLength(0);
          throw new Error("declared output mismatch");
        },
      }),
    ).rejects.toThrow("declared output mismatch");

    expect(projections).toEqual([
      expect.objectContaining({
        toolCallId: "call-output-schema",
        toolName: "orchard_bad_output",
        isError: true,
      }),
    ]);
    expect(JSON.stringify(projections)).not.toContain("must-not-enter-transcript");
    expect(mocks.notifyToolActivity).toHaveBeenCalledWith("run-output-schema");
  });

  it("snapshots accepted results before delayed transcript settlement", async () => {
    const projections: ToolSearchTargetTranscriptProjection[] = [];
    const rawResult = {
      content: [{ type: "text" as const, text: "accepted result" }],
      details: { id: 42 },
    };
    const prepared = prepareCatalogExecutor(projections);

    const returned = await prepared.toolSearchCatalogExecutor({
      tool: {
        name: "orchard_output",
        description: "Return an orchard result",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: vi.fn(async () => rawResult),
      } as never,
      toolName: "orchard_output",
      source: "openclaw",
      sourceName: "fixture-plugin",
      toolCallId: "call-output-schema",
      parentToolCallId: "call-code-mode",
      input: {},
      acceptResultBeforeProjection: async (candidate) => {
        expect(candidate).toBe(rawResult);
        expect(projections).toHaveLength(0);
        const snapshot = structuredClone(candidate);
        if (snapshot.details && typeof snapshot.details === "object") {
          Object.freeze(snapshot.details);
        }
        return Object.freeze(snapshot);
      },
    });

    rawResult.details.id = 99;
    expect(returned).not.toBe(rawResult);
    expect(projections[0]?.result).toBe(returned);
    expect(returned).toMatchObject({ details: { id: 42 } });
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned.details)).toBe(true);
  });

  it("marks accepted canonical failures in hidden tool transcript projections", async () => {
    const projections: ToolSearchTargetTranscriptProjection[] = [];
    const failedResult = {
      content: [{ type: "text" as const, text: "Backend request failed" }],
      details: { status: "error" },
    };
    const prepared = prepareCatalogExecutor(projections);

    const returned = await prepared.toolSearchCatalogExecutor({
      tool: {
        name: "search_query",
        description: "Query a search backend",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: vi.fn(async () => failedResult),
      } as never,
      toolName: "search_query",
      source: "mcp",
      sourceName: "searchServer",
      toolCallId: "call-search-query",
      parentToolCallId: "call-tool-call",
      input: {},
      acceptResultBeforeProjection: async (candidate) => candidate,
    });

    expect(returned).toBe(failedResult);
    expect(projections).toEqual([
      expect.objectContaining({
        toolCallId: "call-search-query",
        result: failedResult,
        isError: true,
      }),
    ]);
    expect(
      projectToolSearchTargetTranscriptMessages([], projections).find(
        (message) => message.role === "toolResult",
      ),
    ).toMatchObject({
      toolCallId: "call-search-query",
      toolName: "search_query",
      isError: true,
    });
  });

  it("records thrown hidden tool failures and rethrows them", async () => {
    const projections: ToolSearchTargetTranscriptProjection[] = [];
    const prepared = prepareCatalogExecutor(projections);

    await expect(
      prepared.toolSearchCatalogExecutor({
        tool: {
          name: "search_query",
          description: "Query a search backend",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          execute: vi.fn(async () => {
            throw new Error("transport disconnected");
          }),
        } as never,
        toolName: "search_query",
        source: "mcp",
        sourceName: "searchServer",
        toolCallId: "call-search-query",
        parentToolCallId: "call-tool-call",
        input: {},
        acceptResultBeforeProjection: async (candidate) => candidate,
      }),
    ).rejects.toThrow("transport disconnected");

    expect(projections).toEqual([
      expect.objectContaining({
        toolCallId: "call-search-query",
        isError: true,
        result: {
          content: [{ type: "text", text: "transport disconnected" }],
          details: { status: "error", error: "transport disconnected" },
        },
      }),
    ]);
  });

  it("distinguishes an accepted abort from normal steering closure and sessions_yield", () => {
    const runAbortController = new AbortController();
    let aborted = false;
    const prepared = prepareCatalogExecutor([], {
      runAbortController,
      getRunState: () => ({
        aborted,
        promptError: undefined,
        timedOut: false,
        yieldDetected: false,
      }),
    });

    expect(prepared.queueHandle.isAborted?.()).toBe(false);
    prepared.stopAcceptingSteerMessages();
    expect(prepared.queueHandle.isStopped?.()).toBe(true);
    expect(prepared.queueHandle.isAborted?.()).toBe(false);

    runAbortController.abort(SESSIONS_YIELD_ABORT_REASON);
    expect(prepared.queueHandle.isAborted?.()).toBe(false);

    aborted = true;
    expect(prepared.queueHandle.isAborted?.()).toBe(true);
  });
});
