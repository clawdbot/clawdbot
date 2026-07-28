// Tests direct runtime config overrides passed into agent runner execution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";
import type { QueueSettings } from "./queue.js";
import type { ReplyOperation } from "./reply-run-registry.js";
import { createMockTypingController } from "./test-helpers.js";

const freshCfg = { runtimeFresh: true };
const staleCfg = {
  runtimeFresh: false,
  skills: {
    entries: {
      whisper: {
        apiKey: { source: "env" as const, provider: "default", id: "OPENAI_API_KEY" },
      },
    },
  },
};
const sentinelError = new Error("stop-after-preflight");

const resolveQueuedReplyExecutionConfigMock = vi.fn();
const resolveReplyToModeMock = vi.fn();
const createReplyToModeFilterForChannelMock = vi.fn();
const createReplyMediaContextMock = vi.fn();
const createReplyMediaPathNormalizerMock = vi.fn();
const runPreflightCompactionIfNeededMock = vi.fn();
const runMemoryFlushIfNeededMock = vi.fn();
const runAgentTurnWithFallbackMock = vi.fn();
const resetReplyRunSessionMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();

vi.mock("./agent-runner-utils.js", async () => {
  const actual =
    await vi.importActual<typeof import("./agent-runner-utils.js")>("./agent-runner-utils.js");
  return {
    ...actual,
    resolveQueuedReplyExecutionConfig: (...args: unknown[]) =>
      resolveQueuedReplyExecutionConfigMock(...args),
  };
});

vi.mock("./reply-threading.js", async () => {
  const actual =
    await vi.importActual<typeof import("./reply-threading.js")>("./reply-threading.js");
  return {
    ...actual,
    resolveReplyToMode: (...args: unknown[]) => resolveReplyToModeMock(...args),
    createReplyToModeFilterForChannel: (...args: unknown[]) =>
      createReplyToModeFilterForChannelMock(...args),
  };
});

vi.mock("./reply-media-paths.js", () => ({
  createReplyMediaContext: (...args: unknown[]) => {
    createReplyMediaContextMock(...args);
    return {
      normalizePayload: createReplyMediaPathNormalizerMock(...args),
    };
  },
  createReplyMediaPathNormalizer: (...args: unknown[]) =>
    createReplyMediaPathNormalizerMock(...args),
}));

vi.mock("./agent-runner-memory.js", () => ({
  runPreflightCompactionIfNeeded: (...args: unknown[]) =>
    runPreflightCompactionIfNeededMock(...args),
  runMemoryFlushIfNeeded: (...args: unknown[]) => runMemoryFlushIfNeededMock(...args),
}));

vi.mock("./agent-runner-execution.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-runner-execution.js")>(
    "./agent-runner-execution.js",
  );
  return {
    ...actual,
    runAgentTurnWithFallback: (...args: unknown[]) => runAgentTurnWithFallbackMock(...args),
  };
});

vi.mock("./agent-runner-session-reset.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-runner-session-reset.js")>(
    "./agent-runner-session-reset.js",
  );
  return {
    ...actual,
    resetReplyRunSession: (...args: unknown[]) => resetReplyRunSessionMock(...args),
  };
});

vi.mock("./queue.js", async () => {
  const actual = await vi.importActual<typeof import("./queue.js")>("./queue.js");
  return {
    ...actual,
    enqueueFollowupRun: (...args: unknown[]) => enqueueFollowupRunMock(...args),
  };
});

const { runReplyAgent } = await import("./agent-runner.js");

function createTelegramSessionCtx(): TemplateContext {
  return {
    Provider: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "12345",
    AccountId: "default",
    ChatType: "dm",
    MessageSid: "msg-1",
  } as unknown as TemplateContext;
}

function createReplyOperation(): ReplyOperation {
  return {
    key: "test",
    sessionId: "session-1",
    abortSignal: new AbortController().signal,
    resetTriggered: false,
    phase: "queued",
    result: null,
    setPhase: vi.fn(),
    updateSessionId: vi.fn(),
    hasOwnedSessionId: vi.fn(() => false),
    attachBackend: vi.fn(),
    detachBackend: vi.fn(),
    retainFailureUntilComplete: vi.fn(),
    complete: vi.fn(),
    completeThen: vi.fn((afterClear: () => void) => {
      afterClear();
    }),
    completeWithAfterClearBarrier: vi.fn(),
    fail: vi.fn(),
    freezeAbort: vi.fn(),
    abortByUser: vi.fn(),
    abortForRestart: vi.fn(),
    terminalRecovery: false,
    acceptedSteeredInboundAudio: false,
    markTerminalRecovery: vi.fn(),
    markAcceptedSteeredInboundAudio: vi.fn(),
  };
}

function createDirectRuntimeReplyParams({
  shouldFollowup,
  isActive,
}: {
  shouldFollowup: boolean;
  isActive: boolean;
}) {
  const followupRun = createTestFollowupRun({
    sessionId: "session-1",
    sessionKey: "agent:main:telegram:default:direct:test",
    messageProvider: "telegram",
    config: staleCfg,
    provider: "openai",
    model: "gpt-5.4",
  });
  const resolvedQueue = { mode: "interrupt" } as QueueSettings;
  const replyParams: Parameters<typeof runReplyAgent>[0] = {
    commandBody: "hello",
    followupRun,
    queueKey: "main",
    resolvedQueue,
    shouldSteer: false,
    shouldFollowup,
    isActive,
    isStreaming: false,
    typing: createMockTypingController(),
    sessionCtx: createTelegramSessionCtx(),
    defaultModel: "openai/gpt-5.4",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  };

  return { followupRun, resolvedQueue, replyParams };
}

function requireResolveQueuedReplyExecutionConfigCall(index = 0) {
  const call = resolveQueuedReplyExecutionConfigMock.mock.calls[index] as
    | [
        unknown,
        {
          originatingChannel?: string;
          messageProvider?: string;
        },
      ]
    | undefined;
  if (!call) {
    throw new Error(`resolveQueuedReplyExecutionConfig call ${index} missing`);
  }
  return call;
}

type MockCallSource = {
  mock: {
    calls: unknown[][];
  };
};

function requireMaintenanceCall(mock: MockCallSource, name: string, index = 0) {
  const call = mock.mock.calls[index]?.[0] as
    | {
        cfg?: unknown;
        followupRun?: unknown;
        sessionKey?: string;
        runtimePolicySessionKey?: string;
      }
    | undefined;
  if (!call) {
    throw new Error(`${name} call ${index} missing`);
  }
  return call;
}

describe("runReplyAgent runtime config", () => {
  beforeEach(() => {
    resolveQueuedReplyExecutionConfigMock.mockReset();
    resolveReplyToModeMock.mockReset();
    createReplyToModeFilterForChannelMock.mockReset();
    createReplyMediaContextMock.mockReset();
    createReplyMediaPathNormalizerMock.mockReset();
    runPreflightCompactionIfNeededMock.mockReset();
    runMemoryFlushIfNeededMock.mockReset();
    runAgentTurnWithFallbackMock.mockReset();
    resetReplyRunSessionMock.mockReset();
    enqueueFollowupRunMock.mockReset();

    resolveQueuedReplyExecutionConfigMock.mockResolvedValue(freshCfg);
    resolveReplyToModeMock.mockReturnValue("all");
    createReplyToModeFilterForChannelMock.mockReturnValue((payload: unknown) => payload);
    createReplyMediaPathNormalizerMock.mockReturnValue((payload: unknown) => payload);
    runPreflightCompactionIfNeededMock.mockRejectedValue(sentinelError);
    runMemoryFlushIfNeededMock.mockResolvedValue({ sessionEntry: undefined, outcome: "skipped" });
    runAgentTurnWithFallbackMock.mockResolvedValue({
      kind: "final",
      payload: { text: "main reply" },
    });
    resetReplyRunSessionMock.mockResolvedValue(false);
  });

  it("resolves direct reply runs before early helpers read config", async () => {
    const { followupRun, replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });

    await expect(runReplyAgent(replyParams)).rejects.toBe(sentinelError);

    expect(followupRun.run.config).toBe(freshCfg);
    expect(resolveQueuedReplyExecutionConfigMock).toHaveBeenCalledTimes(1);
    const [configArg, configContextArg] = requireResolveQueuedReplyExecutionConfigCall();
    expect(configArg).toBe(staleCfg);
    expect(configContextArg.originatingChannel).toBe("telegram");
    expect(configContextArg.messageProvider).toBe("telegram");
    expect(resolveReplyToModeMock).toHaveBeenCalledWith(freshCfg, "telegram", "default", "dm");
    expect(createReplyMediaContextMock).toHaveBeenCalledWith({
      cfg: freshCfg,
      sessionKey: undefined,
      workspaceDir: "/tmp",
      messageProvider: "telegram",
      accountId: undefined,
      groupId: undefined,
      groupChannel: undefined,
      groupSpace: undefined,
      requesterSenderId: undefined,
      requesterSenderName: undefined,
      requesterSenderUsername: undefined,
      requesterSenderE164: undefined,
    });
    expect(runPreflightCompactionIfNeededMock).toHaveBeenCalledTimes(1);
    expect(runMemoryFlushIfNeededMock).toHaveBeenCalledTimes(1);
    expect(runMemoryFlushIfNeededMock.mock.invocationCallOrder[0]).toBeLessThan(
      runPreflightCompactionIfNeededMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    const memoryCall = requireMaintenanceCall(runMemoryFlushIfNeededMock, "runMemoryFlushIfNeeded");
    expect(memoryCall.cfg).toBe(freshCfg);
    expect(memoryCall.followupRun).toBe(followupRun);
    const preflightCall = requireMaintenanceCall(
      runPreflightCompactionIfNeededMock,
      "runPreflightCompactionIfNeeded",
    );
    expect(preflightCall.cfg).toBe(freshCfg);
    expect(preflightCall.followupRun).toBe(followupRun);
  });

  it("passes the derived runtime-policy key to pre-run maintenance", async () => {
    const { followupRun, replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    const runtimePolicySessionKey = "agent:main:telegram:default:direct:test";
    followupRun.run.sessionKey = "agent:main:main";
    followupRun.run.runtimePolicySessionKey = runtimePolicySessionKey;
    replyParams.sessionKey = "agent:main:main";
    replyParams.runtimePolicySessionKey = runtimePolicySessionKey;

    await expect(runReplyAgent(replyParams)).rejects.toBe(sentinelError);

    const preflightCall = requireMaintenanceCall(
      runPreflightCompactionIfNeededMock,
      "runPreflightCompactionIfNeeded",
    );
    expect(preflightCall.sessionKey).toBe("agent:main:main");
    expect(preflightCall.runtimePolicySessionKey).toBe(runtimePolicySessionKey);
    const memoryCall = requireMaintenanceCall(runMemoryFlushIfNeededMock, "runMemoryFlushIfNeeded");
    expect(memoryCall.sessionKey).toBe("agent:main:main");
    expect(memoryCall.runtimePolicySessionKey).toBe(runtimePolicySessionKey);
  });

  it("continues the main reply when memory flush reports visible maintenance errors", async () => {
    const { replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    const onBlockReply = vi.fn();
    replyParams.opts = { sourceReplyDeliveryMode: "message_tool_only", onBlockReply };
    resolveQueuedReplyExecutionConfigMock.mockResolvedValue({
      ...freshCfg,
      agents: { defaults: { compaction: { notifyUser: true } } },
    });
    runPreflightCompactionIfNeededMock.mockResolvedValue(undefined);
    runMemoryFlushIfNeededMock.mockImplementation(
      async (params: {
        onVisibleErrorPayloads?: (payloads: Array<{ text?: string; isError?: boolean }>) => void;
      }) => {
        params.onVisibleErrorPayloads?.([
          {
            text: "⚠️ write failed: Memory flush writes are restricted to memory/2023-11-14.md; use that path only.",
            isError: true,
          },
        ]);
        return { sessionEntry: undefined, outcome: "failed" };
      },
    );

    const result = await runReplyAgent(replyParams);

    expect(result).toEqual({ text: "main reply" });
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(runAgentTurnWithFallbackMock).toHaveBeenCalledOnce();
  });

  it("rotates, rebinds, and optionally notifies when memory flush is exhausted", async () => {
    const { replyParams, followupRun } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    const sessionKey = "agent:main:telegram:default:direct:test";
    const sessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      compactionCount: 4,
      memoryFlushFailureCount: 2,
    };
    const sessionStore = { [sessionKey]: sessionEntry };
    replyParams.sessionKey = sessionKey;
    replyParams.storePath = "/tmp/sessions.json";
    replyParams.sessionEntry = sessionEntry;
    replyParams.sessionStore = sessionStore;
    resolveQueuedReplyExecutionConfigMock.mockResolvedValue({
      ...freshCfg,
      agents: { defaults: { compaction: { notifyUser: true } } },
    });
    const onBlockReply = vi.fn();
    replyParams.opts = { onBlockReply };
    const updateSessionIdSpy = vi.fn();
    const replyOperation = createReplyOperation();
    replyOperation.updateSessionId = updateSessionIdSpy;
    replyParams.replyOperation = replyOperation;
    runPreflightCompactionIfNeededMock.mockImplementation(
      async (params: { sessionEntry?: unknown }) => params.sessionEntry,
    );
    runMemoryFlushIfNeededMock.mockImplementation(
      async (params: {
        sessionEntry?: typeof sessionEntry;
        onVisibleErrorPayloads?: (payloads: Array<{ text?: string; isError?: boolean }>) => void;
      }) => {
        params.onVisibleErrorPayloads?.([
          {
            text: "⚠️ Memory flush failed after 3 attempts; skipping for this cycle. It will retry after the next compaction.",
            isError: true,
          },
        ]);
        return {
          sessionEntry: {
            ...params.sessionEntry,
            memoryFlushFailureCount: 3,
            memoryFlushCompactionCount: 4,
          },
          outcome: "exhausted",
        };
      },
    );
    resetReplyRunSessionMock.mockImplementation(async (params: unknown) => {
      const resetParams = params as {
        activeSessionEntry?: typeof sessionEntry;
        followupRun: typeof followupRun;
        onActiveSessionEntry: (entry: typeof sessionEntry) => void;
        onNewSession: (sessionId: string, sessionFile: string) => void;
      };
      const sessionFile = "/tmp/session-rotated.jsonl";
      const nextEntry = {
        ...resetParams.activeSessionEntry,
        sessionId: "session-rotated",
        updatedAt: 1,
        memoryFlushFailureCount: 0,
        compactionCount: 0,
      };
      resetParams.followupRun.run.sessionId = nextEntry.sessionId;
      resetParams.followupRun.run.sessionFile = sessionFile;
      resetParams.onActiveSessionEntry(nextEntry);
      resetParams.onNewSession(nextEntry.sessionId, sessionFile);
      return true;
    });

    const result = await runReplyAgent(replyParams);

    expect(result).toEqual({ text: "main reply" });
    expect(resetReplyRunSessionMock).toHaveBeenCalledOnce();
    expect(resetReplyRunSessionMock.mock.calls[0]?.[0]).toMatchObject({
      options: {
        failureLabel: "memory flush exhaustion",
        cleanupTranscripts: false,
      },
      sessionKey,
      queueKey: "main",
    });
    expect(followupRun.run.sessionId).toBe("session-rotated");
    expect(updateSessionIdSpy).toHaveBeenCalledWith("session-rotated");
    expect(onBlockReply).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "⚠️ Memory maintenance temporarily failed; continuing your reply.",
      }),
    );
    expect(runAgentTurnWithFallbackMock).toHaveBeenCalledOnce();
  });

  it("keeps the compacted session when preflight recovers an exhausted memory flush", async () => {
    const { replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    const sessionEntry = {
      sessionId: "session-1",
      updatedAt: 1,
      compactionCount: 4,
    };
    replyParams.sessionEntry = sessionEntry;
    runMemoryFlushIfNeededMock.mockResolvedValue({
      sessionEntry,
      outcome: "exhausted",
    });
    runPreflightCompactionIfNeededMock.mockImplementation(
      async (params: { sessionEntry?: typeof sessionEntry }) => {
        expect(params.sessionEntry?.sessionId).toBe("session-1");
        return { ...params.sessionEntry, compactionCount: 5 };
      },
    );

    await expect(runReplyAgent(replyParams)).resolves.toEqual({ text: "main reply" });

    expect(resetReplyRunSessionMock).not.toHaveBeenCalled();
    expect(runAgentTurnWithFallbackMock).toHaveBeenCalledOnce();
  });

  it("rotates when preflight cannot recover an exhausted memory flush", async () => {
    const { replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    runMemoryFlushIfNeededMock.mockResolvedValue({
      sessionEntry: { sessionId: "session-1", updatedAt: 1, compactionCount: 4 },
      outcome: "exhausted",
    });
    runPreflightCompactionIfNeededMock.mockRejectedValue(
      new Error("Preflight compaction required but failed: context_overflow"),
    );

    await expect(runReplyAgent(replyParams)).resolves.toEqual({ text: "main reply" });

    expect(resetReplyRunSessionMock).toHaveBeenCalledOnce();
    expect(resetReplyRunSessionMock.mock.calls[0]?.[0]).toMatchObject({
      options: {
        failureLabel: "memory flush exhaustion",
        cleanupTranscripts: false,
      },
    });
    expect(runAgentTurnWithFallbackMock).toHaveBeenCalledOnce();
  });

  it("surfaces unrelated preflight failures after an exhausted memory flush", async () => {
    const { replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    runMemoryFlushIfNeededMock.mockResolvedValue({
      sessionEntry: { sessionId: "session-1", updatedAt: 1, compactionCount: 4 },
      outcome: "exhausted",
    });
    runPreflightCompactionIfNeededMock.mockRejectedValue(
      new Error("Preflight compaction required but failed: auth profile mismatch"),
    );

    const result = await runReplyAgent(replyParams);

    if (!result || Array.isArray(result)) {
      throw new Error("expected a single preflight compaction failure reply payload");
    }
    expect(result.text).toContain("auto-compaction could not recover");
    expect(resetReplyRunSessionMock).not.toHaveBeenCalled();
    expect(runAgentTurnWithFallbackMock).not.toHaveBeenCalled();
  });

  it("does not start the main turn after cancellation during memory flush", async () => {
    const { replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    runPreflightCompactionIfNeededMock.mockResolvedValue(undefined);
    runMemoryFlushIfNeededMock.mockImplementation(
      async (params: { replyOperation: { abortByUser: () => boolean } }) => {
        expect(params.replyOperation.abortByUser()).toBe(true);
        return { sessionEntry: undefined, outcome: "failed" };
      },
    );

    const result = await runReplyAgent(replyParams);

    expect(result).toMatchObject({ text: SILENT_REPLY_TOKEN });
  });

  it("surfaces known pre-run Codex usage-limit failures instead of dropping the reply", async () => {
    const { replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    const codexMessage =
      "You've reached your Codex subscription usage limit. Codex did not return a reset time for this limit. Run /codex account for current usage details.";
    runPreflightCompactionIfNeededMock.mockRejectedValue(new Error(codexMessage));
    runMemoryFlushIfNeededMock.mockResolvedValue({ sessionEntry: undefined, outcome: "skipped" });

    const result = await runReplyAgent(replyParams);

    if (!result || Array.isArray(result)) {
      throw new Error("expected a single usage-limit reply payload");
    }
    expect(result.text).toBe(`⚠️ ${codexMessage}`);
    const metadata = getReplyPayloadMetadata(result);
    expect(metadata?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it("surfaces preflight compaction failures before the agent starts", async () => {
    const { replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    runPreflightCompactionIfNeededMock.mockRejectedValue(
      new Error("Preflight compaction required but failed: auth profile mismatch"),
    );
    runMemoryFlushIfNeededMock.mockResolvedValue({ sessionEntry: undefined, outcome: "skipped" });

    const result = await runReplyAgent(replyParams);

    if (!result || Array.isArray(result)) {
      throw new Error("expected a single preflight compaction failure reply payload");
    }
    expect(result.text).toContain("Context is too large");
    expect(result.text).toContain("auto-compaction could not recover");
    expect(result.text).toContain("/compact");
    expect(result.text).toContain("/new");
    const metadata = getReplyPayloadMetadata(result);
    expect(metadata?.deliverDespiteSourceReplySuppression).toBe(true);
  });

  it("does not resolve secrets before the enqueue-followup queue path", async () => {
    const { followupRun, resolvedQueue, replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: true,
      isActive: true,
    });

    await expect(runReplyAgent(replyParams)).resolves.toBeUndefined();

    expect(resolveQueuedReplyExecutionConfigMock).not.toHaveBeenCalled();
    expect(enqueueFollowupRunMock).toHaveBeenCalledTimes(1);
    const enqueueCall = enqueueFollowupRunMock.mock.calls.at(0);
    expect(enqueueCall?.[0]).toBe("main");
    expect(enqueueCall?.[1]).toBe(followupRun);
    expect(enqueueCall?.[2]).toBe(resolvedQueue);
    expect(enqueueCall?.[3]).toBe("message-id");
    expect(typeof enqueueCall?.[4]).toBe("function");
    expect(enqueueCall?.[5]).toBe(false);
  });
});
