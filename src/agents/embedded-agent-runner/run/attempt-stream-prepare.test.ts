import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReplyOperation,
  expireStaleReplyOperation,
  type ReplyOperation,
} from "../../../auto-reply/reply/reply-run-registry.js";
import {
  projectNestedToolActivityForHooks,
  type NestedToolActivity,
} from "../../../sessions/nested-tool-activity.js";
import {
  isAgentRunRestartAbortReason,
  isAgentRunSupersededAbortReason,
} from "../../run-termination.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { ACTIVE_EMBEDDED_RUNS } from "../run-state.js";

const mocks = vi.hoisted(() => ({
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
  projections: NestedToolActivity[],
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
    activeSession: {
      agent: {},
      isStreaming: false,
      sessionManager: SessionManager.inMemory(),
    } as never,
    hookRunner: undefined as never,
    hookAgentId: "main",
    diagnosticTrace: {} as never,
    diagnosticOwner: {} as never,
    clientToolCallSlots: [],
    nestedToolActivities: projections,
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
    ACTIVE_EMBEDDED_RUNS.clear();
    mocks.setActiveRun.mockImplementation((sessionId, handle) =>
      ACTIVE_EMBEDDED_RUNS.set(sessionId, handle),
    );
    mocks.subscribe.mockReturnValue({
      toolMetas: [],
      runToolLifecycle: vi.fn(async ({ execute }) => await execute(() => undefined)),
      isCompacting: vi.fn(() => false),
    });
    mocks.runBeforeFinalizeHook.mockResolvedValue({ action: "continue" });
  });

  it("retains exact heartbeat preemption on the embedded queue handle", () => {
    const operation = createReplyOperation({
      sessionKey: "agent:main:main",
      sessionId: "session-output-schema",
      turnKind: "heartbeat",
      resetTriggered: false,
    });
    try {
      const prepared = prepareCatalogExecutor([], { replyOperation: operation });

      expect(prepared.queueHandle.preemptByVisibleTurn?.()).toBe(true);
      expect(operation.result).toEqual({
        kind: "aborted",
        code: "aborted_for_supersession",
      });
      expect(mocks.setActiveRun).toHaveBeenCalledWith(
        "session-output-schema",
        expect.objectContaining({ preemptByVisibleTurn: expect.any(Function) }),
        "agent:main:main",
        undefined,
      );
    } finally {
      operation.complete();
    }
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
      diagnosticOwner: {} as never,
      clientToolCallSlots: [],
      nestedToolActivities: [],
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
    const subscriptionInput = mocks.subscribe.mock.calls.at(-1)?.[0] as {
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
      diagnosticOwner: {} as never,
      clientToolCallSlots: [],
      nestedToolActivities: [],
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
    const subscriptionInput = mocks.subscribe.mock.calls.at(-1)?.[0] as {
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

    expect(mocks.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:internal-session-effects:companion-run",
      }),
    );
  });

  it.each(["rejected", "accepted", "canonical failure", "thrown"] as const)(
    "records one accepted terminal fact for %s output",
    async (kind) => {
      const activities: NestedToolActivity[] = [];
      const prepared = prepareCatalogExecutor(activities);
      const rawResult = {
        content: [{ type: "text" as const, text: "tool output" }],
        details: { id: 42, status: kind === "canonical failure" ? "error" : "success" },
      };
      const failure = kind === "thrown" ? "transport disconnected" : "declared output mismatch";
      const toolName = "lookup";
      const input = { path: "original.txt" };
      const execution = prepared.toolSearchCatalogExecutor({
        tool: {
          name: toolName,
          description: "Look up a record",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
          execute: async () => {
            if (kind === "thrown") {
              throw new Error(failure);
            }
            return rawResult;
          },
        } as never,
        toolName,
        source: kind === "canonical failure" || kind === "thrown" ? "mcp" : "openclaw",
        toolCallId: "nested-lookup",
        parentToolCallId: "outer-exec",
        input,
        acceptResultBeforeProjection: async (candidate) => {
          expect(candidate).toBe(rawResult);
          expect(activities).toHaveLength(0);
          if (kind === "rejected") {
            throw new Error(failure);
          }
          const snapshot = structuredClone(candidate);
          Object.freeze(snapshot.details);
          return Object.freeze(snapshot);
        },
      });
      if (kind === "rejected" || kind === "thrown") {
        await expect(execution).rejects.toThrow(failure);
        expect(activities[0]?.details.result).toEqual({
          content: [{ type: "text", text: failure }],
          details: { status: "error", error: failure },
        });
        expect(JSON.stringify(activities)).not.toContain("tool output");
      } else {
        const returned = await execution;
        rawResult.details.id = 99;
        expect(returned).not.toBe(rawResult);
        expect(returned.details).toMatchObject({ id: 42 });
        expect(Object.isFrozen(returned)).toBe(true);
        expect(Object.isFrozen(returned.details)).toBe(true);
        expect(activities[0]?.details.result).toEqual(returned);
      }
      input.path = "changed-after-completion.txt";
      expect(activities).toHaveLength(1);
      expect(activities[0]?.details.input).toEqual({ path: "original.txt" });
      expect(activities[0]?.details).toMatchObject({
        parentToolCallId: "outer-exec",
        toolCallId: "nested-lookup",
        toolName,
        isError: kind !== "accepted",
      });
      const ordinaryMessage = { role: "assistant", content: "Final answer" };
      const hookMessages = projectNestedToolActivityForHooks([ordinaryMessage], activities);
      expect(hookMessages).toEqual([
        ordinaryMessage,
        expect.objectContaining({
          role: "custom",
          display: true,
          excludeFromContext: true,
          content: expect.any(String),
          details: activities[0]?.details,
        }),
      ]);
      expect(hookMessages[0]).toBe(ordinaryMessage);
      const activity = activities[0]!;
      const nextInvocation = {
        ...activity,
        details: { ...activity.details, scopeId: "next-scope" },
      };
      const nextHookMessage = projectNestedToolActivityForHooks([], [nextInvocation])[0];
      expect((nextHookMessage as { content: string }).content).not.toBe(
        (hookMessages[1] as { content: string }).content,
      );
      expect(mocks.notifyToolActivity).toHaveBeenCalledWith("run-output-schema");
    },
  );

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
