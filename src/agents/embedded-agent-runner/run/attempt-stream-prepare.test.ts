import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReplyOperation,
  expireStaleReplyOperation,
  type ReplyOperation,
} from "../../../auto-reply/reply/reply-run-registry.js";
import {
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
} from "../../run-termination.js";
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
vi.mock("./attempt-subscription-cleanup.js", () => ({
  buildEmbeddedSubscriptionParams: mocks.buildSubscriptionParams,
}));
vi.mock("./tool-activity-heartbeat.js", () => ({
  notifyToolActivity: mocks.notifyToolActivity,
}));
vi.mock("../../harness/lifecycle-hook-helpers.js", () => ({
  runAgentHarnessBeforeAgentFinalizeHook: mocks.runBeforeFinalizeHook,
}));

import {
  createEmbeddedAttemptExternalAbortController,
  createEmbeddedAttemptRunAbort,
} from "./attempt-finalize.js";
import { SESSIONS_YIELD_ABORT_REASON } from "./attempt-sessions-yield.js";
import { prepareEmbeddedAttemptStream } from "./attempt-stream-prepare.js";

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
    replyOperation?: ReplyOperation;
    onAttemptAbort?: () => void;
    abortRun?: (isTimeout?: boolean, reason?: unknown) => void;
    markExternalAbort?: () => void;
  },
) {
  const runAbortController = options?.runAbortController ?? new AbortController();
  return prepareEmbeddedAttemptStream({
    attempt: {
      runId: "run-output-schema",
      sessionId: "session-output-schema",
      sessionKey: options?.sessionKey ?? "agent:main:main",
      replyOperation: options?.replyOperation,
      onAttemptAbort: options?.onAttemptAbort,
    } as never,
    activeSession: { agent: {}, isStreaming: false } as never,
    hookRunner: undefined as never,
    hookAgentId: "main",
    diagnosticTrace: {} as never,
    clientToolCallSlots: [],
    toolSearchTargetTranscriptProjections: projections,
    isReplaySafeTool: () => false,
    runAbortController,
    abortRun: options?.abortRun ?? vi.fn(),
    markExternalAbort: options?.markExternalAbort ?? vi.fn(),
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

  it("processes aliased cancel and abort through one external-abort sequence", () => {
    const markExternalAbort = vi.fn();
    const onAttemptAbort = vi.fn();
    const abortRun = vi.fn();
    const prepared = prepareCatalogExecutor([], {
      markExternalAbort,
      onAttemptAbort,
      abortRun,
    });

    prepared.queueHandle.abort("restart");
    prepared.queueHandle.cancel("user_abort");

    expect(markExternalAbort).toHaveBeenCalledOnce();
    expect(onAttemptAbort).toHaveBeenCalledOnce();
    expect(abortRun).toHaveBeenCalledOnce();
    expect(abortRun.mock.calls[0]?.[0]).toBe(false);
    expect(isAgentRunRestartAbortReason(abortRun.mock.calls[0]?.[1])).toBe(true);
  });

  it("runs attempt cleanup once when reply cancellation re-enters through its abort signal", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-output-schema",
      resetTriggered: false,
    });
    const attemptAbortController = new AbortController();
    const runAbortController = new AbortController();
    const markExternalAbort = vi.fn();
    const markAborted = vi.fn();
    const abortActiveSession = vi.fn(async () => {});
    const abortState = {
      markAborted,
      markExternalAbort,
      markTimedOut: vi.fn(),
      markTimedOutDuringCompaction: vi.fn(),
      markTimedOutDuringToolExecution: vi.fn(),
      readTimedOutDuringCompaction: vi.fn(() => false),
      setPromptError: vi.fn(),
    };
    const externalAbortController = createEmbeddedAttemptExternalAbortController({
      abortSignal: attemptAbortController.signal,
      cleanupAfterEarlyAbort: vi.fn(async () => {}),
      runAbortController,
      runId: "run-output-schema",
      state: abortState,
    });
    let queueHandle: ReturnType<typeof prepareCatalogExecutor>["queueHandle"] | undefined;
    const abortRun = createEmbeddedAttemptRunAbort({
      abortActiveSession,
      activeSession: { abortCompaction: vi.fn(), isCompacting: false },
      attempt: {
        runId: "run-output-schema",
        sessionFile: "agent:main:main",
        sessionId: "session-output-schema",
        sessionKey: "agent:main:main",
      },
      getQueueHandle: () => queueHandle,
      isProbeSession: true,
      log: { warn: vi.fn() },
      runAbortController,
      state: abortState,
    });
    externalAbortController.setRunAbort(abortRun);
    externalAbortController.arm();
    const relayReplyAbort = () => {
      attemptAbortController.abort(operation.abortSignal.reason);
    };
    operation.abortSignal.addEventListener("abort", relayReplyAbort, { once: true });
    const onAttemptAbort = vi.fn(() => {
      if (!operation.abortSignal.aborted) {
        operation.abortByUser();
      }
    });

    try {
      operation.setPhase("running");
      const prepared = prepareCatalogExecutor([], {
        replyOperation: operation,
        markExternalAbort,
        onAttemptAbort,
        abortRun,
      });
      queueHandle = prepared.queueHandle;

      expect(expireStaleReplyOperation(operation, "stuck_recovery")).toBe(false);

      expect(markExternalAbort).toHaveBeenCalledTimes(2);
      expect(onAttemptAbort).toHaveBeenCalledOnce();
      expect(markAborted).toHaveBeenCalledOnce();
      expect(abortActiveSession).toHaveBeenCalledOnce();
      expect(isAgentRunSupersededAbortReason(runAbortController.signal.reason)).toBe(true);
      expect(operation.result).toEqual({ kind: "failed", code: "run_stalled" });
      expect(operation.abortSignal.aborted).toBe(true);
    } finally {
      externalAbortController.dispose();
      operation.abortSignal.removeEventListener("abort", relayReplyAbort);
      operation.complete();
    }
  });
});
