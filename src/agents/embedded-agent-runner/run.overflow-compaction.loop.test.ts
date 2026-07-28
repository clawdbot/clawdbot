// Coverage for the overflow compaction retry loop in runEmbeddedAgent.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "../../llm/types.js";
import {
  makeAttemptResult,
  makeCompactionSuccess,
  makeOverflowError,
  mockOverflowRetrySuccess,
  queueOverflowAttemptWithOversizedToolOutput,
} from "./run.overflow-compaction.fixture.js";
import {
  overflowBaseRunParams as baseParams,
  loadRunOverflowCompactionHarness,
  mockedCompactDirect,
  mockedClassifyFailoverReason,
  mockedContextEngine,
  mockedIsCompactionFailureError,
  mockedIsLikelyContextOverflowError,
  mockedLog,
  mockedMarkAuthProfileSuccess,
  mockedResolveModelAsync,
  mockedRunEmbeddedAttempt,
  mockedSessionLikelyHasOversizedToolResults,
  mockedTruncateOversizedToolResultsInSession,
  resetRunOverflowCompactionHarnessMocks,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

const REASONING_ONLY_RETRY_INSTRUCTION =
  "The previous assistant turn recorded reasoning but did not produce a user-visible answer. Continue from that partial turn and produce the visible answer now. Do not restate the reasoning or restart from scratch.";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label} to be an object`);
  }
  return value as Record<string, unknown>;
}

function requireMockCallArg(
  mock: { mock: { calls: unknown[][] } },
  index: number,
): Record<string, unknown> {
  // Compaction tests inspect positional mock params from the runner loop; fail
  // fast with a readable label when expected calls are missing.
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`expected mock call ${index}`);
  }
  return requireRecord(call[0], `mock call ${index} arg`);
}

function expectLogIncludes(mock: { mock: { calls: unknown[][] } }, fragment: string) {
  expect(mock.mock.calls.map((call) => String(call[0])).join("\n")).toContain(fragment);
}

function expectLogExcludes(mock: { mock: { calls: unknown[][] } }, fragment: string) {
  expect(mock.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain(fragment);
}

function expectRetryContinuesFromTranscript() {
  // Once the inbound user message was persisted, retry must continue from the
  // transcript instead of re-persisting the original prompt.
  const retryParams = requireMockCallArg(mockedRunEmbeddedAttempt, 1);
  expect(String(retryParams.prompt)).toContain("Continue from the current transcript");
  expect(retryParams.suppressNextUserMessagePersistence).toBe(true);
  expect(retryParams.prompt).not.toBe(baseParams.prompt);
}

function expectTruncationScopeSessionFile(callIndex: number, sessionFile: string) {
  const args = requireMockCallArg(mockedTruncateOversizedToolResultsInSession, callIndex);
  expect(requireRecord(args.scope, "truncation scope").sessionFile).toBe(sessionFile);
}

function makeUserMessage(content: string = baseParams.prompt) {
  return { role: "user" as const, content, timestamp: 1 };
}

describe("overflow compaction in run loop", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedIsCompactionFailureError.mockImplementation((msg?: string) => {
      if (!msg) {
        return false;
      }
      const lower = msg.toLowerCase();
      return lower.includes("request_too_large") && lower.includes("summarization failed");
    });
    mockedIsLikelyContextOverflowError.mockImplementation((msg?: string) => {
      if (!msg) {
        return false;
      }
      const lower = msg.toLowerCase();
      return (
        lower.includes("request_too_large") ||
        lower.includes("request size exceeds") ||
        lower.includes("context window exceeded") ||
        lower.includes("prompt too large")
      );
    });
  });

  it("retries after successful compaction on context overflow promptError", async () => {
    mockOverflowRetrySuccess({
      runEmbeddedAttempt: mockedRunEmbeddedAttempt,
      compactDirect: mockedCompactDirect,
    });

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    const compactArg = requireMockCallArg(mockedCompactDirect, 0);
    expect(requireRecord(compactArg.runtimeContext, "runtime context").authProfileId).toBe(
      "test-profile",
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expectLogIncludes(
      mockedLog.warn,
      "context overflow detected (attempt 1/3); attempting auto-compaction",
    );
    expectLogIncludes(mockedLog.info, "auto-compaction succeeded");
    // Should not be an error result
    expect(result.meta.error).toBeUndefined();
  });

  it("uses the canonical assistant classifier when the legacy text heuristic misses", async () => {
    mockedIsLikelyContextOverflowError.mockReturnValue(false);
    const assistantError = {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5",
      usage: {
        input: 1,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: "400 Your input exceeds the context window of this model",
      timestamp: 1,
    } satisfies AssistantMessage;
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          currentAttemptCompletedAssistant: assistantError,
          lastAssistant: assistantError,
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult());
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150_000,
      }),
    );

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledOnce();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.meta.error).toBeUndefined();
  });

  it("recovers a canonical zero-output length overflow through the caller", async () => {
    mockedIsLikelyContextOverflowError.mockReturnValue(false);
    const assistantOverflow = {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5",
      usage: {
        input: 199_000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 199_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "length",
      timestamp: 1,
    } satisfies AssistantMessage;
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          currentAttemptCompletedAssistant: assistantOverflow,
          lastAssistant: assistantOverflow,
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult());
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 199_000,
      }),
    );

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledOnce();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.meta.error).toBeUndefined();
  });

  it("keeps a whole code point at the context-overflow diagnostic boundary", async () => {
    const marker = "request_too_large: ";
    const prefix = `${marker}${"a".repeat(199 - marker.length)}`;
    mockOverflowRetrySuccess({
      runEmbeddedAttempt: mockedRunEmbeddedAttempt,
      compactDirect: mockedCompactDirect,
      overflowMessage: `${prefix}😀tail`,
    });

    await runEmbeddedAgent(baseParams);

    const diagnostic = mockedLog.warn.mock.calls
      .map(([entry]) => String(entry))
      .find((entry) => entry.startsWith("[context-overflow-diag]"));
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.endsWith(`error=${prefix}`)).toBe(true);
  });

  it("keeps fallback unsafe when an overflow retry follows a mutating attempt", async () => {
    const overflowError = makeOverflowError();
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: overflowError,
          toolMetas: [{ toolName: "exec" }],
          replayMetadata: {
            hadPotentialSideEffects: true,
            replaySafe: false,
          },
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          assistantTexts: [],
          toolMetas: [{ toolName: "web_fetch" }],
          replayMetadata: {
            hadPotentialSideEffects: false,
            replaySafe: true,
          },
          lastAssistant: {
            role: "assistant",
            stopReason: "toolUse",
            provider: "openai",
            model: "gpt-5.4",
            content: [],
          } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
        }),
      );
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        tokensBefore: 150000,
      }),
    );

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(requireMockCallArg(mockedRunEmbeddedAttempt, 1).initialReplayState).toEqual({
      replayInvalid: true,
      hadPotentialSideEffects: true,
    });
    expect(result.meta.error?.fallbackSafe).toBe(false);
  });

  it("uses provider thinking policy for configless embedded MiniMax-M3 runs", async () => {
    mockedResolveModelAsync.mockResolvedValueOnce({
      model: {
        id: "MiniMax-M3",
        provider: "minimax",
        contextWindow: 1_000_000,
        api: "anthropic-messages",
        reasoning: true,
      },
      error: null,
      authStorage: {
        setRuntimeApiKey: vi.fn(),
      },
      modelRegistry: {},
    });
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...baseParams,
      config: undefined,
      provider: "minimax",
      model: "MiniMax-M3",
      runId: "run-configless-minimax-m3-thinking-default",
    });

    expect(requireMockCallArg(mockedRunEmbeddedAttempt, 0).thinkLevel).toBe("adaptive");
  });

  it("does not wait for post-run auth-profile success bookkeeping before returning", async () => {
    let resolveSuccess!: () => void;
    const successPromise = new Promise<void>((resolve) => {
      resolveSuccess = resolve;
    });
    mockedMarkAuthProfileSuccess.mockReturnValueOnce(successPromise);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    const result = await runEmbeddedAgent(baseParams);

    expect(result.meta.error).toBeUndefined();
    expect(mockedMarkAuthProfileSuccess).toHaveBeenCalledTimes(1);
    resolveSuccess();
    await successPromise;
  });

  it("persists the canonical user turn when the embedded runtime writes its prompt file", async () => {
    const persistedMessage = makeUserMessage();
    const persistApproved = vi.fn(async () => ({
      sessionFile: "/tmp/openclaw-transcript.jsonl",
      sessionEntry: undefined,
      messageId: "msg-user-1",
      message: persistedMessage,
    }));
    const markRuntimePersistencePending = vi.fn();
    const markRuntimePersisted = vi.fn();
    const onUserMessagePersisted = vi.fn();
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      (
        attemptParams as {
          onUserMessagePersisted?: (message: { role: "user"; content: string }) => void;
        }
      ).onUserMessagePersisted?.(makeUserMessage());
      return makeAttemptResult({ promptError: null });
    });

    await runEmbeddedAgent({
      ...baseParams,
      userTurnTranscriptRecorder: {
        message: makeUserMessage(),
        resolveMessage: vi.fn(async () => makeUserMessage()),
        markRuntimePersistencePending,
        markRuntimePersisted,
        markBlocked: vi.fn(),
        hasPersisted: vi.fn(() => false),
        isBlocked: vi.fn(() => false),
        hasRuntimePersistencePending: vi.fn(() => false),
        waitForRuntimePersistence: vi.fn(async () => undefined),
        persistApproved,
        persistBlocked: vi.fn(async () => undefined),
        persistFallback: vi.fn(async () => undefined),
      },
      onUserMessagePersisted,
    });

    expect(persistApproved).toHaveBeenCalledOnce();
    expect(markRuntimePersistencePending).toHaveBeenCalledOnce();
    expect(markRuntimePersisted).not.toHaveBeenCalled();
    expect(onUserMessagePersisted).toHaveBeenCalledWith(persistedMessage);
  });

  it("suppresses retry persistence when the runtime already marked the user turn persisted", async () => {
    const overflowError = makeOverflowError();
    const runtimeMessage = makeUserMessage();
    const persistApproved = vi.fn(async () => undefined);
    const onUserMessagePersisted = vi.fn();
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (attemptParams) => {
        (
          attemptParams as {
            onUserMessagePersisted?: (message: typeof runtimeMessage) => void;
          }
        ).onUserMessagePersisted?.(runtimeMessage);
        return makeAttemptResult({ promptError: overflowError });
      })
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    await runEmbeddedAgent({
      ...baseParams,
      currentMessageId: "telegram-msg-runtime-persisted",
      onUserMessagePersisted,
      userTurnTranscriptRecorder: {
        message: runtimeMessage,
        resolveMessage: vi.fn(async () => runtimeMessage),
        markRuntimePersistencePending: vi.fn(),
        markRuntimePersisted: vi.fn(),
        markBlocked: vi.fn(),
        hasPersisted: vi.fn(() => true),
        isBlocked: vi.fn(() => false),
        hasRuntimePersistencePending: vi.fn(() => false),
        waitForRuntimePersistence: vi.fn(async () => undefined),
        persistApproved,
        persistBlocked: vi.fn(async () => undefined),
        persistFallback: vi.fn(async () => undefined),
      },
    });

    expect(persistApproved).toHaveBeenCalledOnce();
    expect(onUserMessagePersisted).toHaveBeenCalledWith(runtimeMessage);
    expectRetryContinuesFromTranscript();
  });

  it("does not persist the original embedded prompt when before_agent_run writes a block marker", async () => {
    const blockedMessage = {
      ...makeUserMessage("[blocked by before_agent_run]"),
      __openclaw: {
        beforeAgentRunBlocked: {
          blockedBy: "before_agent_run",
          blockedAt: 123,
        },
      },
    };
    const persistBlocked = vi.fn(async (message: unknown) => ({
      sessionFile: "/tmp/openclaw-transcript.jsonl",
      sessionEntry: undefined,
      messageId: "msg-user-1",
      message: message as typeof blockedMessage,
    }));
    const persistApproved = vi.fn(async () => ({
      sessionFile: "/tmp/openclaw-transcript.jsonl",
      sessionEntry: undefined,
      messageId: "msg-user-1",
      message: makeUserMessage(),
    }));
    const markBlocked = vi.fn();
    const markRuntimePersistencePending = vi.fn();
    const markRuntimePersisted = vi.fn();
    const onUserMessagePersisted = vi.fn();
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams) => {
      (
        attemptParams as {
          onUserMessagePersisted?: (message: typeof blockedMessage) => void;
        }
      ).onUserMessagePersisted?.(blockedMessage);
      return makeAttemptResult({ promptError: null });
    });

    await runEmbeddedAgent({
      ...baseParams,
      onUserMessagePersisted,
      userTurnTranscriptRecorder: {
        message: makeUserMessage(),
        resolveMessage: vi.fn(async () => makeUserMessage()),
        markRuntimePersistencePending,
        markRuntimePersisted,
        markBlocked,
        hasPersisted: vi.fn(() => false),
        isBlocked: vi.fn(() => false),
        hasRuntimePersistencePending: vi.fn(() => false),
        waitForRuntimePersistence: vi.fn(async () => undefined),
        persistApproved,
        persistBlocked,
        persistFallback: vi.fn(async () => undefined),
      },
    });

    expect(persistApproved).not.toHaveBeenCalled();
    expect(persistBlocked).toHaveBeenCalledWith(blockedMessage);
    expect(markRuntimePersistencePending).toHaveBeenCalledOnce();
    expect(markBlocked).not.toHaveBeenCalled();
    expect(markRuntimePersisted).not.toHaveBeenCalled();
    expect(onUserMessagePersisted).toHaveBeenCalledWith(blockedMessage);
  });

  it("does not suppress retry persistence when canonical embedded user turn write is blocked", async () => {
    const overflowError = makeOverflowError();
    const persistApproved = vi.fn(async () => undefined);
    const onUserMessagePersisted = vi.fn();
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (attemptParams) => {
        (
          attemptParams as {
            onUserMessagePersisted?: (message: { role: "user"; content: string }) => void;
          }
        ).onUserMessagePersisted?.(makeUserMessage());
        return makeAttemptResult({ promptError: overflowError });
      })
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    await runEmbeddedAgent({
      ...baseParams,
      currentMessageId: "telegram-msg-blocked",
      onUserMessagePersisted,
      userTurnTranscriptRecorder: {
        message: makeUserMessage(),
        resolveMessage: vi.fn(async () => makeUserMessage()),
        markRuntimePersistencePending: vi.fn(),
        markRuntimePersisted: vi.fn(),
        markBlocked: vi.fn(),
        hasPersisted: vi.fn(() => false),
        isBlocked: vi.fn(() => false),
        hasRuntimePersistencePending: vi.fn(() => false),
        waitForRuntimePersistence: vi.fn(async () => undefined),
        persistApproved,
        persistBlocked: vi.fn(async () => undefined),
        persistFallback: vi.fn(async () => undefined),
      },
    });

    expect(persistApproved).toHaveBeenCalledOnce();
    expect(onUserMessagePersisted).not.toHaveBeenCalled();
    const retryParams = requireMockCallArg(mockedRunEmbeddedAttempt, 1);
    expect(retryParams.prompt).toBe(baseParams.prompt);
    expect(retryParams.suppressNextUserMessagePersistence).toBe(false);
  });

  it("waits for pending canonical embedded user turn persistence before retry suppression", async () => {
    const overflowError = makeOverflowError();
    const persistedMessage = makeUserMessage();
    let resolvePersistApproved:
      | ((result: {
          sessionFile: string;
          sessionEntry: undefined;
          messageId: string;
          message: typeof persistedMessage;
        }) => void)
      | undefined;
    let pendingPersistence: Promise<void> | undefined;
    const persistApproved = vi.fn(
      () =>
        new Promise<{
          sessionFile: string;
          sessionEntry: undefined;
          messageId: string;
          message: typeof persistedMessage;
        }>((resolve) => {
          resolvePersistApproved = resolve;
        }),
    );
    const onUserMessagePersisted = vi.fn();
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (attemptParams) => {
        (
          attemptParams as {
            onUserMessagePersisted?: (message: { role: "user"; content: string }) => void;
          }
        ).onUserMessagePersisted?.(makeUserMessage());
        return makeAttemptResult({ promptError: overflowError });
      })
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    const runPromise = runEmbeddedAgent({
      ...baseParams,
      currentMessageId: "telegram-msg-delayed",
      onUserMessagePersisted,
      userTurnTranscriptRecorder: {
        message: persistedMessage,
        resolveMessage: vi.fn(async () => persistedMessage),
        markRuntimePersistencePending: vi.fn((pending) => {
          pendingPersistence = pending;
        }),
        markRuntimePersisted: vi.fn(),
        markBlocked: vi.fn(),
        hasPersisted: vi.fn(() => false),
        isBlocked: vi.fn(() => false),
        hasRuntimePersistencePending: vi.fn(() => pendingPersistence !== undefined),
        waitForRuntimePersistence: vi.fn(async () => {
          await pendingPersistence;
        }),
        persistApproved,
        persistBlocked: vi.fn(async () => undefined),
        persistFallback: vi.fn(async () => undefined),
      },
    });

    await vi.waitFor(() => {
      expect(persistApproved).toHaveBeenCalledOnce();
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedCompactDirect).not.toHaveBeenCalled();

    resolvePersistApproved?.({
      sessionFile: "/tmp/openclaw-transcript.jsonl",
      sessionEntry: undefined,
      messageId: "msg-user-delayed",
      message: persistedMessage,
    });
    await runPromise;

    expect(mockedCompactDirect).toHaveBeenCalledOnce();
    expect(onUserMessagePersisted).toHaveBeenCalledWith(persistedMessage);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expectRetryContinuesFromTranscript();
  });

  it("continues from transcript after compaction when the current inbound message was persisted", async () => {
    const overflowError = makeOverflowError();

    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (attemptParams) => {
        (
          attemptParams as {
            onUserMessagePersisted?: (message: { role: "user"; content: string }) => void;
          }
        ).onUserMessagePersisted?.(makeUserMessage());
        return makeAttemptResult({ promptError: overflowError });
      })
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    const result = await runEmbeddedAgent({
      ...baseParams,
      currentMessageId: "telegram-msg-51024",
    });

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expectRetryContinuesFromTranscript();
    expect(result.meta.error).toBeUndefined();
  });

  it("does not suppress the next user turn when precheck overflow never persisted it", async () => {
    // Precheck overflow happens before the inbound message enters the transcript,
    // so the retry should still persist the original prompt.
    const overflowError = makeOverflowError(
      "Context overflow: prompt too large for the model (precheck).",
    );

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: overflowError,
          promptErrorSource: "precheck",
          preflightRecovery: { route: "compact_only" },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted before prompt submission",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    const result = await runEmbeddedAgent({
      ...baseParams,
      currentMessageId: "telegram-msg-51025",
    });

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    const retryParams = requireMockCallArg(mockedRunEmbeddedAttempt, 1);
    expect(retryParams.prompt).toBe(baseParams.prompt);
    expect(retryParams.suppressNextUserMessagePersistence).toBe(false);
    expect(result.meta.error).toBeUndefined();
  });

  it("does not suppress an unpersisted reasoning continuation after precheck compaction", async () => {
    mockedClassifyFailoverReason.mockReturnValue(null);
    mockedResolveModelAsync.mockResolvedValue({
      model: {
        id: "kimi-for-coding",
        provider: "kimi",
        contextWindow: 262144,
        api: "anthropic-messages",
      },
      error: null,
      authStorage: { setRuntimeApiKey: vi.fn() },
      modelRegistry: {},
    });
    const overflowError = makeOverflowError(
      "Context overflow: prompt too large for the model (precheck).",
    );
    mockedRunEmbeddedAttempt
      .mockImplementationOnce(async (attemptParams) => {
        (
          attemptParams as {
            onUserMessagePersisted?: (message: ReturnType<typeof makeUserMessage>) => void;
          }
        ).onUserMessagePersisted?.(makeUserMessage());
        return makeAttemptResult({
          assistantTexts: [],
          lastAssistant: {
            role: "assistant",
            stopReason: "end_turn",
            provider: "kimi",
            model: "kimi-for-coding",
            api: "anthropic-messages",
            content: [
              {
                type: "thinking",
                thinking: "internal reasoning",
                thinkingSignature: JSON.stringify({ id: "rs_precheck", type: "reasoning" }),
              },
            ],
          } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
        });
      })
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: overflowError,
          promptErrorSource: "precheck",
          preflightRecovery: { route: "compact_only" },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted before continuation submission",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    await runEmbeddedAgent({
      ...baseParams,
      currentMessageId: "telegram-msg-continuation-precheck",
      provider: "kimi",
      model: "kimi-for-coding",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    for (const index of [1, 2]) {
      const retryParams = requireMockCallArg(mockedRunEmbeddedAttempt, index);
      expect(retryParams.prompt).toBe(REASONING_ONLY_RETRY_INSTRUCTION);
      expect(retryParams.suppressNextUserMessagePersistence).toBe(false);
    }
  });

  it("retries after successful compaction on likely-overflow promptError variants", async () => {
    const overflowHintError = new Error("Context window exceeded: requested 12000 tokens");

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowHintError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-6",
        tokensBefore: 140000,
      }),
    );

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expectLogIncludes(mockedLog.warn, "source=promptError");
    expect(result.meta.error).toBeUndefined();
  });

  it("returns error if compaction fails", async () => {
    const overflowError = makeOverflowError();

    mockedRunEmbeddedAttempt.mockResolvedValue(makeAttemptResult({ promptError: overflowError }));

    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(result.payloads?.[0]?.isError).toBe(true);
    expectLogIncludes(mockedLog.warn, "auto-compaction failed");
  });

  it("falls back to tool-result truncation and retries when oversized results are detected", async () => {
    queueOverflowAttemptWithOversizedToolOutput(mockedRunEmbeddedAttempt, makeOverflowError());
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });
    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(true);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValueOnce({
      truncated: true,
      truncatedCount: 1,
    });

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(
      requireMockCallArg(mockedSessionLikelyHasOversizedToolResults, 0).contextWindowTokens,
    ).toBe(200000);
    expectTruncationScopeSessionFile(0, "/tmp/session.json");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expectLogIncludes(mockedLog.info, "Truncated 1 tool result(s)");
    expect(result.meta.error).toBeUndefined();
  });

  it("retries after fallback truncation for a mixed oversized-plus-aggregate tool tail", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: makeOverflowError(),
          messagesSnapshot: [
            {
              role: "toolResult",
              content: [{ type: "text", text: "x".repeat(80_000) }],
            } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
            {
              role: "toolResult",
              content: [{ type: "text", text: "alpha beta gamma delta ".repeat(800) }],
            } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
            {
              role: "toolResult",
              content: [{ type: "text", text: "alpha beta gamma delta ".repeat(800) }],
            } as unknown as EmbeddedRunAttemptResult["messagesSnapshot"][number],
          ],
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });
    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(true);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValueOnce({
      truncated: true,
      truncatedCount: 2,
    });

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    const oversizedArgs = requireMockCallArg(mockedSessionLikelyHasOversizedToolResults, 0);
    const messages = oversizedArgs.messages as Array<{ role?: string }>;
    expect(messages.filter((message) => message.role === "toolResult")).toHaveLength(3);
    expectTruncationScopeSessionFile(0, "/tmp/session.json");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expectLogIncludes(mockedLog.info, "Truncated 2 tool result(s)");
    expect(result.meta.error).toBeUndefined();
  });

  it("retries without hitting compaction when attempt-level preflight truncation already handled the overflow", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          preflightRecovery: {
            route: "truncate_tool_results_only",
            handled: true,
            truncatedCount: 2,
          },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedTruncateOversizedToolResultsInSession).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expectLogIncludes(mockedLog.info, "early recovery route=truncate_tool_results_only");
    expect(result.meta.error).toBeUndefined();
  });

  it("continues from the transcript after mid-turn precheck truncation handled the overflow", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          preflightRecovery: {
            route: "truncate_tool_results_only",
            source: "mid-turn",
            handled: true,
            truncatedCount: 2,
          },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expectRetryContinuesFromTranscript();
    expectLogIncludes(mockedLog.info, "retrying from current transcript");
    expect(result.meta.error).toBeUndefined();
  });

  it("falls back to compaction when early truncate-only recovery does not help", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: makeOverflowError(
            "Context overflow: prompt too large for the model (precheck).",
          ),
          preflightRecovery: { route: "compact_only" },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted after failed early truncation",
        firstKeptEntryId: "entry-7",
        tokensBefore: 155000,
      }),
    );

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedTruncateOversizedToolResultsInSession).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expectLogIncludes(
      mockedLog.warn,
      "context overflow detected (attempt 1/3); attempting auto-compaction",
    );
    expect(result.meta.error).toBeUndefined();
  });

  it("continues from the transcript after mid-turn precheck compaction", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: makeOverflowError(
            "Context overflow: prompt too large for the model (mid-turn precheck).",
          ),
          promptErrorSource: "precheck",
          preflightRecovery: { route: "compact_only", source: "mid-turn" },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted after mid-turn precheck",
        firstKeptEntryId: "entry-8",
        tokensBefore: 155000,
      }),
    );

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expectRetryContinuesFromTranscript();
    expect(result.meta.error).toBeUndefined();
  });

  it("runs post-compaction tool-result truncation before retry for mixed precheck routes", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: makeOverflowError(
            "Context overflow: prompt too large for the model (precheck).",
          ),
          preflightRecovery: { route: "compact_then_truncate" },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );
    mockedTruncateOversizedToolResultsInSession.mockResolvedValueOnce({
      truncated: true,
      truncatedCount: 2,
    });

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expectTruncationScopeSessionFile(0, "/tmp/session.json");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expectLogIncludes(mockedLog.info, "post-compaction tool-result truncation succeeded");
    expect(result.meta.error).toBeUndefined();
  });

  it("retries compaction up to 3 times before giving up", async () => {
    const overflowError = makeOverflowError();

    // 4 overflow errors: 3 compaction retries + final failure
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }));

    mockedCompactDirect
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 1",
          firstKeptEntryId: "entry-3",
          tokensBefore: 180000,
        }),
      )
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 2",
          firstKeptEntryId: "entry-5",
          tokensBefore: 160000,
        }),
      )
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 3",
          firstKeptEntryId: "entry-7",
          tokensBefore: 140000,
        }),
      );

    const result = await runEmbeddedAgent(baseParams);

    // Compaction attempted 3 times (max)
    expect(mockedCompactDirect).toHaveBeenCalledTimes(3);
    // 4 attempts: 3 overflow+compact+retry cycles + final overflow → error
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(4);
    expect(result.meta.error?.kind).toBe("context_overflow");
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("succeeds after second compaction attempt", async () => {
    const overflowError = makeOverflowError();

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: overflowError }))
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 1",
          firstKeptEntryId: "entry-3",
          tokensBefore: 180000,
        }),
      )
      .mockResolvedValueOnce(
        makeCompactionSuccess({
          summary: "Compacted 2",
          firstKeptEntryId: "entry-5",
          tokensBefore: 160000,
        }),
      );

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    expect(result.meta.error).toBeUndefined();
  });

  it("does not attempt compaction for compaction_failure errors", async () => {
    const compactionFailureError = new Error(
      "request_too_large: summarization failed - Request size exceeds model context window",
    );

    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({ promptError: compactionFailureError }),
    );

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta.error?.kind).toBe("compaction_failure");
  });

  it("retries after successful compaction on assistant context overflow errors", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: null,
          lastAssistant: {
            stopReason: "error",
            errorMessage: "request_too_large: Request size exceeds model context window",
          } as EmbeddedRunAttemptResult["lastAssistant"],
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expectLogIncludes(mockedLog.warn, "source=assistantError");
    expect(result.meta.error).toBeUndefined();
  });

  it("does not treat stale assistant overflow as current-attempt overflow when promptError is non-overflow", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        promptError: new Error("transport disconnected"),
        lastAssistant: {
          stopReason: "error",
          errorMessage: "request_too_large: Request size exceeds model context window",
        } as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    await expect(runEmbeddedAgent(baseParams)).rejects.toThrow("transport disconnected");

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expectLogExcludes(mockedLog.warn, "source=assistantError");
  });

  it("returns an explicit timeout payload when the run times out before producing any reply", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        aborted: true,
        timedOut: true,
        timedOutDuringCompaction: false,
        assistantTexts: [],
      }),
    );

    const result = await runEmbeddedAgent(baseParams);

    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });

  it("uses harness-provided prompt timeout outcome metadata", async () => {
    const setTerminalLifecycleMeta = vi.fn();
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        aborted: true,
        timedOut: true,
        timedOutDuringCompaction: false,
        assistantTexts: [],
        promptTimeoutOutcome: {
          message: "Harness stopped after completed work without terminal confirmation.",
          replayInvalid: true,
          livenessState: "abandoned",
        },
        setTerminalLifecycleMeta,
      }),
    );

    const result = await runEmbeddedAgent(baseParams);

    expect(result.payloads).toEqual([
      {
        text: "Harness stopped after completed work without terminal confirmation.",
        isError: true,
      },
    ]);
    expect(result.meta?.replayInvalid).toBe(true);
    expect(result.meta?.livenessState).toBe("abandoned");
    expect(result.meta?.timeoutPhase).toBe("provider");
    expect(result.meta?.providerStarted).toBe(true);
    expect(setTerminalLifecycleMeta).toHaveBeenCalledWith({
      replayInvalid: true,
      livenessState: "abandoned",
      timeoutPhase: "provider",
      providerStarted: true,
      aborted: false,
    });
  });

  it("does not emit a generic timeout payload after messaging-tool delivery", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        aborted: true,
        timedOut: true,
        timedOutDuringCompaction: false,
        assistantTexts: [],
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["already delivered"],
      }),
    );

    const result = await runEmbeddedAgent(baseParams);

    expect(result.payloads).toBeUndefined();
    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.messagingToolSentTexts).toEqual(["already delivered"]);
  });

  it("propagates deterministic approval prompt delivery from attempts", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        assistantTexts: [],
        didSendDeterministicApprovalPrompt: true,
      }),
    );

    const result = await runEmbeddedAgent(baseParams);

    expect(result.payloads).toBeUndefined();
    expect(result.didSendDeterministicApprovalPrompt).toBe(true);
  });

  it("returns a timeout payload instead of a partial assistant fragment after stream timeout", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        aborted: true,
        timedOut: true,
        timedOutDuringCompaction: false,
        assistantTexts: ["# Current Tasks\n\nLast updated:"],
        lastAssistant: undefined,
      }),
    );

    const result = await runEmbeddedAgent(baseParams);

    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("timed out");
    expect(
      result.payloads?.some((payload) => (payload.text ?? "").includes("# Current Tasks")),
    ).toBe(false);
  });

  it("preserves tool media payloads and appends an explicit timeout error", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        aborted: true,
        timedOut: true,
        timedOutDuringCompaction: false,
        assistantTexts: [],
        toolMediaUrls: ["https://example.test/tool-output.png"],
      }),
    );

    const result = await runEmbeddedAgent(baseParams);

    expect(
      result.payloads?.map((payload) => ({
        isError: payload.isError,
        textIncludesTimedOut: payload.text?.includes("timed out") ?? false,
        mediaUrl: payload.mediaUrl,
        mediaUrls: payload.mediaUrls,
      })),
    ).toEqual([
      {
        isError: undefined,
        textIncludesTimedOut: false,
        mediaUrl: "https://example.test/tool-output.png",
        mediaUrls: ["https://example.test/tool-output.png"],
      },
      {
        isError: true,
        textIncludesTimedOut: true,
        mediaUrl: undefined,
        mediaUrls: undefined,
      },
    ]);
  });

  it("sets promptTokens from the latest model call usage, not accumulated attempt usage", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValue(
      makeAttemptResult({
        attemptUsage: {
          input: 4_000,
          cacheRead: 120_000,
          cacheWrite: 0,
          total: 124_000,
        },
        lastAssistant: {
          stopReason: "end_turn",
          usage: {
            input: 900,
            cacheRead: 1_100,
            cacheWrite: 0,
            total: 2_000,
          },
        } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
      }),
    );

    const result = await runEmbeddedAgent(baseParams);

    expect(result.meta.agentMeta?.usage?.input).toBe(4_000);
    expect(result.meta.agentMeta?.promptTokens).toBe(2_000);
  });

  it("recovers from real model overflow when ownsCompaction context engine skips precheck", async () => {
    mockedContextEngine.info.ownsCompaction = true;
    mockOverflowRetrySuccess({
      runEmbeddedAttempt: mockedRunEmbeddedAttempt,
      compactDirect: mockedCompactDirect,
    });

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.meta.error).toBeUndefined();
  });

  it("still handles precheck overflow when ownsCompaction engine uses preassembly_may_overflow", async () => {
    mockedContextEngine.info.ownsCompaction = true;

    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: makeOverflowError(
            "Context overflow: prompt too large for the model (precheck).",
          ),
          promptErrorSource: "precheck",
          preflightRecovery: { route: "compact_only" },
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted via preassembly overflow guard",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    const result = await runEmbeddedAgent(baseParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.meta.error).toBeUndefined();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
