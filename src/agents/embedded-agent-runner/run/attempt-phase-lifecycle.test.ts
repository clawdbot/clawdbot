import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  readActiveTranscriptEntryAnchor,
  upsertSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { closeOpenClawAgentDatabasesForTest } from "../../../state/openclaw-agent-db.js";
import { SessionManager } from "../../sessions/session-manager.js";

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
vi.mock("./attempt-async-tasks.js", () => ({
  shouldWaitForCompletionRequiredAsyncTasks: hoisted.shouldWaitForCompletionRequiredAsyncTasks,
  waitForCompletionRequiredAsyncTasks: hoisted.waitForCompletionRequiredAsyncTasks,
}));

import { completeEmbeddedAttemptAfterTurn } from "./attempt-finalize.js";
import { settleEmbeddedAttemptStream } from "./attempt-stream-settle.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("embedded attempt phase lifecycle state", () => {
  beforeEach(() => {
    hoisted.runAgentEndSideEffects.mockReset();
    hoisted.shouldWaitForCompletionRequiredAsyncTasks.mockReset().mockReturnValue(false);
    hoisted.waitForCompletionRequiredAsyncTasks.mockReset();
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
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
      withOwnedTranscriptWrite: async (operation) => await operation(),
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
      withOwnedTranscriptWrite: async (operation) => await operation(),
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
      withOwnedTranscriptWrite: async (operation) => await operation(),
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

  it("emits the persisted terminal boundary to the outer fallback owner", async () => {
    const dir = tempDirs.make("openclaw-attempt-terminal-anchor-");
    const target = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath: path.join(dir, "sessions.json"),
    };
    await upsertSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const userMessage = { role: "user" as const, content: "hello", timestamp: 1 };
    const persistedUser = await appendTranscriptMessage(target, {
      cwd: dir,
      eventId: "user-1",
      message: userMessage,
      now: 1,
    });
    if (!persistedUser?.anchor) {
      throw new Error("expected persisted user anchor");
    }
    const recorder = createUserTurnTranscriptRecorder({
      message: userMessage,
      target: async () => undefined,
    });
    recorder.markRuntimePersisted(userMessage, persistedUser.anchor);
    const sessionManager = SessionManager.open(target, dir);
    const terminalEntryId = sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    });
    const expectedTerminalAnchor = readActiveTranscriptEntryAnchor({
      agentId: persistedUser.anchor.agentId,
      sessionId: persistedUser.anchor.sessionId,
      sessionKey: persistedUser.anchor.sessionKey,
      storePath: persistedUser.anchor.storePath,
      entryId: terminalEntryId,
    });
    if (!expectedTerminalAnchor) {
      throw new Error("expected persisted terminal anchor");
    }
    const afterTurn = vi.fn(async () => {});
    const maintain = vi.fn(async () => ({
      changed: false,
      bytesFreed: 0,
      rewrittenEntries: 0,
    }));
    const onContextEngineTurnCandidate = vi.fn();
    await completeEmbeddedAttemptAfterTurn({
      attempt: {
        runId: "run-1",
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionTarget: target,
        sessionFile: target.sessionKey,
        provider: "test",
        modelId: "model",
        model: { api: "openai-responses" },
        userTurnTranscriptRecorder: recorder,
        onContextEngineTurnCandidate,
      } as never,
      activeContextEngine: {
        info: { id: "test", name: "Test" },
        assemble: vi.fn(),
        compact: vi.fn(),
        ingest: vi.fn(),
        afterTurn,
        maintain,
      } as never,
      activeSession: {} as never,
      sessionManager,
      withOwnedTranscriptWrite: async (operation) => await operation(),
      state: {
        promptError: null,
        yieldAborted: false,
        sessionIdUsed: target.sessionId,
        messagesSnapshot: [{ role: "assistant", content: "done" }] as never,
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
        resolveActiveContextEnginePluginId: () => "test",
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

    expect(onContextEngineTurnCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        boundary: {
          admission: recorder.getAdmissionReceipt(),
          terminal: expectedTerminalAnchor,
        },
      }),
    );
    expect(afterTurn).not.toHaveBeenCalled();
    expect(maintain).not.toHaveBeenCalled();
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
      withOwnedTranscriptWrite: async (operation) => await operation(),
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
      withOwnedTranscriptWrite: async (operation) => {
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
      withOwnedTranscriptWrite: async (operation) => await operation(),
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
