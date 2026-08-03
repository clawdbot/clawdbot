import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  runAgentEndSideEffects: vi.fn(),
  shouldWaitForCompletionRequiredAsyncTasks: vi.fn((): boolean => false),
  waitForCompletionRequiredAsyncTasks: vi.fn(),
}));

vi.mock("../../harness/agent-end-side-effects.js", () => ({
  runAgentEndSideEffects: hoisted.runAgentEndSideEffects,
}));
vi.mock("./agent-end-context.js", () => ({
  buildEmbeddedAgentEndContext: () => ({}),
}));
vi.mock("./attempt.async-tasks.js", () => ({
  shouldWaitForCompletionRequiredAsyncTasks: hoisted.shouldWaitForCompletionRequiredAsyncTasks,
  waitForCompletionRequiredAsyncTasks: hoisted.waitForCompletionRequiredAsyncTasks,
}));

import { completeEmbeddedAttemptAfterTurn } from "./attempt-after-turn.js";
import { settleEmbeddedAttemptStream } from "./attempt-stream-settle.js";

describe("embedded attempt phase lifecycle state", () => {
  beforeEach(() => {
    hoisted.runAgentEndSideEffects.mockReset();
    hoisted.shouldWaitForCompletionRequiredAsyncTasks.mockReset().mockReturnValue(false);
    hoisted.waitForCompletionRequiredAsyncTasks.mockReset();
  });

  it("re-reads compaction timeout state after the retry wait", async () => {
    let timedOut = false;
    let timedOutDuringCompaction = false;
    const messages: never[] = [];
    const removeTrailingEntries = vi.fn(() => 0);
    const sessionManager = {
      appendCustomEntry: vi.fn(),
      buildSessionContext: () => ({ messages }),
      getEntries: () => [],
      removeTrailingEntries,
    };
    const activeSession = {
      agent: { state: { messages } },
      isCompacting: false,
      isStreaming: false,
      messages,
      sessionId: "session-1",
    };

    const result = await settleEmbeddedAttemptStream({
      attempt: {
        runId: "run-1",
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        provider: "test",
        modelId: "model",
        model: { api: "openai-responses" },
      } as never,
      activeSession: activeSession as never,
      sessionManager: sessionManager as never,
      sessionLockController: {} as never,
      withOwnedSessionWriteLock: async (operation) => await operation(),
      subscription: {
        toolMetas: [],
        waitForCompactionRetry: async () => {
          timedOut = true;
          timedOutDuringCompaction = true;
        },
        isCompactionInFlight: () => false,
        getCompactionCount: () => 0,
        getCurrentAttemptAssistant: () => undefined,
        getUsageTotals: () => undefined,
        getLastAssistantUsage: () => undefined,
      } as never,
      state: {
        promptError: null,
        promptErrorSource: null,
        yieldAborted: false,
        sessionIdUsed: "session-1",
      },
      readLifecycleState: () => ({
        aborted: timedOut,
        timedOut,
        timedOutDuringCompaction,
      }),
      markTimedOutDuringCompaction: () => {
        timedOutDuringCompaction = true;
      },
      runAbortDeadlineAtMs: Date.now() + 60_000,
      runAbortSignal: new AbortController().signal,
      isProbeSession: true,
      abortable: async (promise) => await promise,
      prePromptMessageCount: 0,
      toolSearchTargetTranscriptProjections: [],
      cache: {
        observabilityEnabled: false,
        changesForTurn: null,
        retention: undefined,
      },
      shouldFlushForContextEngine: false,
    });

    expect(result.timedOutDuringCompaction).toBe(true);
    expect(removeTrailingEntries).toHaveBeenCalledOnce();
  });

  it("settles a user-aborted run whose async-task wait throws AbortError", async () => {
    const abortError = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    hoisted.shouldWaitForCompletionRequiredAsyncTasks.mockReturnValue(true);
    hoisted.waitForCompletionRequiredAsyncTasks
      .mockRejectedValueOnce(abortError)
      .mockResolvedValueOnce({ timedOutRunIds: ["exec-run-1"] });
    const messages: never[] = [];
    const sessionManager = {
      appendCustomEntry: vi.fn(),
      buildSessionContext: () => ({ messages }),
      getEntries: () => [],
      removeTrailingEntries: vi.fn(() => 0),
    };
    const activeSession = {
      agent: { state: { messages } },
      isCompacting: false,
      isStreaming: false,
      messages,
      sessionId: "session-1",
    };

    const result = await settleEmbeddedAttemptStream({
      attempt: {
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        provider: "test",
        modelId: "model",
        model: { api: "openai-responses" },
      } as never,
      activeSession: activeSession as never,
      sessionManager: sessionManager as never,
      sessionLockController: {} as never,
      withOwnedSessionWriteLock: async (operation) => await operation(),
      subscription: {
        toolMetas: [{ toolName: "exec", asyncStarted: true }],
        waitForCompactionRetry: async () => {},
        isCompactionInFlight: () => false,
        getCompactionCount: () => 0,
        getCurrentAttemptAssistant: () => undefined,
        getUsageTotals: () => undefined,
        getLastAssistantUsage: () => undefined,
      } as never,
      state: {
        promptError: null,
        promptErrorSource: null,
        yieldAborted: false,
        sessionIdUsed: "session-1",
      },
      readLifecycleState: () => ({
        aborted: true,
        timedOut: false,
        timedOutDuringCompaction: false,
      }),
      markTimedOutDuringCompaction: () => {},
      runAbortDeadlineAtMs: Date.now() + 60_000,
      runAbortSignal: AbortSignal.abort(),
      isProbeSession: true,
      abortable: async (promise) => await promise,
      prePromptMessageCount: 0,
      toolSearchTargetTranscriptProjections: [],
      cache: {
        observabilityEnabled: false,
        changesForTurn: null,
        retention: undefined,
      },
      shouldFlushForContextEngine: false,
    });

    // The aborted run settles instead of unwinding the lane task, and its
    // unfinished async tasks are not reclassified as a timeout failure.
    expect(result.promptError).toBeNull();
    expect(hoisted.waitForCompletionRequiredAsyncTasks).toHaveBeenCalledTimes(2);
  });

  it("keeps projected nested tool evidence from owning the model terminal (#118274)", async () => {
    const modelAssistant = {
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "outer-exec", name: "exec", arguments: {} }],
    };
    const messages = [
      { role: "user", content: "Read a missing file." },
      modelAssistant,
      {
        role: "toolResult",
        toolCallId: "outer-exec",
        toolName: "exec",
        isError: true,
        content: [{ type: "text", text: "ENOENT" }],
      },
    ];
    const activeSession = {
      agent: { state: { messages } },
      isCompacting: false,
      isStreaming: false,
      messages,
      sessionId: "session-1",
    };
    const sessionManager = {
      appendCustomEntry: vi.fn(),
      buildSessionContext: () => ({ messages }),
      getEntries: () => [],
      removeTrailingEntries: vi.fn(() => 0),
    };

    const result = await settleEmbeddedAttemptStream({
      attempt: {
        runId: "run-1",
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        sessionFile: "/tmp/session.jsonl",
        provider: "mock-openai",
        modelId: "gpt-5.6-luna",
        model: { api: "openai-responses" },
      } as never,
      activeSession: activeSession as never,
      sessionManager: sessionManager as never,
      sessionLockController: {} as never,
      withOwnedSessionWriteLock: async (operation) => await operation(),
      subscription: {
        toolMetas: [
          { toolName: "read", isError: true },
          { toolName: "exec", isError: true },
        ],
        waitForCompactionRetry: async () => {},
        isCompactionInFlight: () => false,
        getCompactionCount: () => 0,
        getCurrentAttemptAssistant: () => structuredClone(modelAssistant),
        getUsageTotals: () => undefined,
        getLastAssistantUsage: () => undefined,
      } as never,
      state: {
        promptError: null,
        promptErrorSource: null,
        yieldAborted: false,
        sessionIdUsed: "session-1",
      },
      readLifecycleState: () => ({
        aborted: false,
        timedOut: false,
        timedOutDuringCompaction: false,
      }),
      markTimedOutDuringCompaction: () => {},
      runAbortDeadlineAtMs: Date.now() + 60_000,
      runAbortSignal: new AbortController().signal,
      isProbeSession: true,
      abortable: async (promise) => await promise,
      prePromptMessageCount: 1,
      toolSearchTargetTranscriptProjections: [
        {
          parentToolCallId: "outer-exec",
          toolCallId: "tool_search_code:outer-exec:read:1",
          toolName: "read",
          input: { path: "missing.txt" },
          result: {
            content: [{ type: "text", text: "ENOENT" }],
            details: { status: "error", error: "ENOENT" },
          },
          isError: true,
        },
      ],
      cache: {
        observabilityEnabled: false,
        changesForTurn: null,
        retention: undefined,
      },
      shouldFlushForContextEngine: false,
    });

    expect(result.lastAssistant).toBe(modelAssistant);
    expect(result.currentAttemptAssistant).toBe(modelAssistant);
    expect(result.currentAttemptCompletedAssistant).toEqual(modelAssistant);
    expect(result.messagesSnapshot).toHaveLength(5);
    expect(result.messagesSnapshot.at(-2)).toMatchObject({
      role: "assistant",
      stopReason: "toolUse",
      content: [{ name: "read" }],
    });
    expect(result.messagesSnapshot.at(-1)).toMatchObject({
      role: "toolResult",
      toolName: "read",
      isError: true,
    });
  });

  it("emits an abort-classified agent_end event when a teardown error races the abort", async () => {
    const abortError = Object.assign(new Error("This operation was aborted"), {
      name: "AbortError",
    });
    await completeEmbeddedAttemptAfterTurn({
      attempt: {
        runId: "run-1",
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
      } as never,
      activeSession: {} as never,
      sessionManager: { appendCustomEntry: vi.fn() } as never,
      sessionLockController: {} as never,
      withOwnedSessionWriteLock: async (operation) => await operation(),
      state: {
        promptError: abortError,
        yieldAborted: false,
        sessionIdUsed: "session-1",
        messagesSnapshot: [],
        prePromptMessageCount: 0,
        contextEngineAfterTurnCheckpoint: null,
        compactionOccurredThisAttempt: false,
      },
      readLifecycleState: () => ({
        aborted: true,
        timedOut: false,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
      }),
      runtime: {
        effectiveWorkspace: "/tmp/workspace",
        agentDir: "/tmp/agent",
        sessionAgentId: "main",
        resolveActiveContextEnginePluginId: () => undefined,
        shouldRecordCompletedBootstrapTurn: false,
        cacheTrace: null,
        anthropicPayloadLogger: null,
        hookAgentId: "main",
        diagnosticTrace: { traceId: "trace-1", spanId: "span-1" } as never,
        skillWorkshopAvailable: true,
        hookRunner: null,
        promptStartedAt: Date.now(),
      },
    });

    expect(hoisted.runAgentEndSideEffects).toHaveBeenCalledTimes(1);
    const event = hoisted.runAgentEndSideEffects.mock.calls[0]?.[0]?.event;
    expect(event).toMatchObject({ success: false });
    expect(event?.error).toBeUndefined();
  });

  it("re-reads abort state inside the post-turn session write", async () => {
    let aborted = false;
    await completeEmbeddedAttemptAfterTurn({
      attempt: {
        runId: "run-1",
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
      } as never,
      activeSession: {} as never,
      sessionManager: { appendCustomEntry: vi.fn() } as never,
      sessionLockController: {} as never,
      withOwnedSessionWriteLock: async (operation) => {
        aborted = true;
        return await operation();
      },
      state: {
        promptError: null,
        yieldAborted: false,
        sessionIdUsed: "session-1",
        messagesSnapshot: [],
        prePromptMessageCount: 0,
        contextEngineAfterTurnCheckpoint: null,
        compactionOccurredThisAttempt: false,
      },
      readLifecycleState: () => ({
        aborted,
        timedOut: aborted,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
      }),
      runtime: {
        effectiveWorkspace: "/tmp/workspace",
        agentDir: "/tmp/agent",
        sessionAgentId: "main",
        resolveActiveContextEnginePluginId: () => undefined,
        shouldRecordCompletedBootstrapTurn: false,
        cacheTrace: null,
        anthropicPayloadLogger: null,
        hookAgentId: "main",
        diagnosticTrace: { traceId: "trace-1", spanId: "span-1" } as never,
        skillWorkshopAvailable: false,
        hookRunner: null,
        promptStartedAt: Date.now(),
      },
    });

    expect(hoisted.runAgentEndSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({ success: false }),
      }),
    );
  });

  it("skips agent_end side effects for settled-turn finalization", async () => {
    await completeEmbeddedAttemptAfterTurn({
      attempt: {
        operation: "settled-tool-finalization",
        runId: "run-1",
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
      } as never,
      activeSession: {} as never,
      sessionManager: { appendCustomEntry: vi.fn() } as never,
      sessionLockController: {} as never,
      withOwnedSessionWriteLock: async (operation) => await operation(),
      state: {
        promptError: null,
        yieldAborted: false,
        sessionIdUsed: "session-1",
        messagesSnapshot: [],
        prePromptMessageCount: 0,
        contextEngineAfterTurnCheckpoint: null,
        compactionOccurredThisAttempt: false,
      },
      readLifecycleState: () => ({
        aborted: false,
        timedOut: false,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
      }),
      runtime: {
        effectiveWorkspace: "/tmp/workspace",
        agentDir: "/tmp/agent",
        sessionAgentId: "main",
        resolveActiveContextEnginePluginId: () => undefined,
        shouldRecordCompletedBootstrapTurn: false,
        cacheTrace: null,
        anthropicPayloadLogger: null,
        hookAgentId: "main",
        diagnosticTrace: { traceId: "trace-1", spanId: "span-1" } as never,
        skillWorkshopAvailable: false,
        hookRunner: null,
        promptStartedAt: Date.now(),
      },
    });

    expect(hoisted.runAgentEndSideEffects).not.toHaveBeenCalled();
  });
});
