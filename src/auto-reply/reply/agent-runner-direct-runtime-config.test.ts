// Tests direct runtime config overrides passed into agent runner execution.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../agents/failover-error.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "../../plugins/memory-state.test-fixtures.js";
import { prepareSessionParticipantInput } from "../../sessions/session-participant-input.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { getReplyPayloadMetadata } from "../reply-payload.js";
import type { TemplateContext } from "../templating.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { createTestFollowupRun, withTestModelContextTokens } from "./agent-runner.test-fixtures.js";
import type { QueueSettings } from "./queue.js";
import { resolveReplyOperationAgentTurn } from "./reply-operation-agent-turn-state.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "./reply-operation-run-state.js";
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
const runSessionCompactionIfNeededMock = vi.fn();
const runMemoryFlushIfNeededMock = vi.fn();
const executeAgentTurnMock = vi.fn();
const prepareGitCoauthorAttributionMock = vi.fn();
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
  runSessionCompactionIfNeeded: (...args: unknown[]) => runSessionCompactionIfNeededMock(...args),
  runMemoryFlushIfNeeded: (...args: unknown[]) => runMemoryFlushIfNeededMock(...args),
}));

vi.mock("./agent-runner-execution.js", async () => {
  const actual = await vi.importActual<typeof import("./agent-runner-execution.js")>(
    "./agent-runner-execution.js",
  );
  return {
    ...actual,
    executeAgentTurn: (...args: unknown[]) => executeAgentTurnMock(...args),
  };
});

vi.mock("../../agents/git-coauthor-attribution.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/git-coauthor-attribution.js")>(
    "../../agents/git-coauthor-attribution.js",
  );
  return {
    ...actual,
    prepareGitCoauthorAttribution: (...args: unknown[]) =>
      prepareGitCoauthorAttributionMock(...args),
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

type TestReplyOperation = ReplyOperation & {
  setPhase: ReturnType<typeof vi.fn<ReplyOperation["setPhase"]>>;
};

function createReplyOperation(): TestReplyOperation {
  let sessionId = "session-1";
  return {
    key: "test",
    get sessionId() {
      return sessionId;
    },
    turnKind: "visible",
    abortSignal: new AbortController().signal,
    resetTriggered: false,
    phase: "queued",
    result: null,
    startedAtMs: Date.now(),
    lastActivityAtMs: Date.now(),
    recordActivity: vi.fn(),
    setPhase: vi.fn(),
    markWaitingForDeferredMaintenance: vi.fn(),
    markDeferredMaintenanceWaitEnded: vi.fn(),
    markWaitingForGlobalLane: vi.fn(),
    markGlobalLaneWaitEnded: vi.fn(),
    updateSessionId: vi.fn((nextSessionId: string) => {
      sessionId = nextSessionId;
    }),
    updateSessionKey: vi.fn(),
    hasOwnedSessionId: vi.fn(() => false),
    bindToolAuthorityFingerprint: vi.fn(),
    bindToolAuthorityProjector: vi.fn(),
    projectToolAuthorityFingerprint: vi.fn(),
    bindToolAuthorityRoute: vi.fn(),
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
    supersede: vi.fn(),
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
    runSessionCompactionIfNeededMock.mockReset();
    runMemoryFlushIfNeededMock.mockReset();
    executeAgentTurnMock.mockReset();
    prepareGitCoauthorAttributionMock.mockReset();
    resetReplyRunSessionMock.mockReset();
    enqueueFollowupRunMock.mockReset();

    resolveQueuedReplyExecutionConfigMock.mockResolvedValue(freshCfg);
    resolveReplyToModeMock.mockReturnValue("all");
    createReplyToModeFilterForChannelMock.mockReturnValue((payload: unknown) => payload);
    createReplyMediaPathNormalizerMock.mockReturnValue((payload: unknown) => payload);
    runSessionCompactionIfNeededMock.mockRejectedValue(sentinelError);
    runMemoryFlushIfNeededMock.mockResolvedValue({ sessionEntry: undefined, outcome: "skipped" });
    executeAgentTurnMock.mockResolvedValue({
      runId: "runtime-config-test",
      outcome: { kind: "rejected", payload: { text: "main reply" } },
    });
    prepareGitCoauthorAttributionMock.mockReturnValue(undefined);
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
    expect(runSessionCompactionIfNeededMock).toHaveBeenCalledTimes(1);
    expect(runMemoryFlushIfNeededMock).toHaveBeenCalledTimes(1);
    expect(runMemoryFlushIfNeededMock.mock.invocationCallOrder[0]).toBeLessThan(
      runSessionCompactionIfNeededMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    const memoryCall = requireMaintenanceCall(runMemoryFlushIfNeededMock, "runMemoryFlushIfNeeded");
    expect(memoryCall.cfg).toBe(freshCfg);
    expect(memoryCall.followupRun).toBe(followupRun);
    const preflightCall = requireMaintenanceCall(
      runSessionCompactionIfNeededMock,
      "runSessionCompactionIfNeeded",
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
      runSessionCompactionIfNeededMock,
      "runSessionCompactionIfNeeded",
    );
    expect(preflightCall.sessionKey).toBe("agent:main:main");
    expect(preflightCall.runtimePolicySessionKey).toBe(runtimePolicySessionKey);
    const memoryCall = requireMaintenanceCall(runMemoryFlushIfNeededMock, "runMemoryFlushIfNeeded");
    expect(memoryCall.sessionKey).toBe("agent:main:main");
    expect(memoryCall.runtimePolicySessionKey).toBe(runtimePolicySessionKey);
  });

  it.each([
    { identity: { type: "profile", id: "profile-ada" }, expectedProfileId: "profile-ada" },
    {
      identity: {
        type: "remote",
        pluginId: "slack",
        domain: "workspace",
        idKind: "user",
        id: "profile-ada",
      },
      expectedProfileId: undefined,
    },
    { identity: undefined, expectedProfileId: undefined },
  ] satisfies Array<{
    identity: SessionParticipantIdentity | undefined;
    expectedProfileId: string | undefined;
  }>)(
    "takes co-author context from accepted input $identity, not the session creator",
    async ({ identity, expectedProfileId }) => {
      const attribution =
        "Git commit attribution for this turn:\nCo-authored-by: octocat <583231+octocat@users.noreply.github.com>";
      prepareGitCoauthorAttributionMock.mockImplementation(
        (params: { currentProfileId?: string }) =>
          params.currentProfileId === "profile-ada" ? attribution : undefined,
      );
      runSessionCompactionIfNeededMock.mockResolvedValue(undefined);
      await withTestDir({ prefix: "openclaw-coauthor-input-" }, async (tempDir) => {
        const storePath = join(tempDir, "sessions.json");
        const sessionKey = "agent:main:chat:attribution";
        const sessionEntry: SessionEntry = { sessionId: "session-1", updatedAt: 1 };
        const { replyParams } = createDirectRuntimeReplyParams({
          shouldFollowup: false,
          isActive: false,
        });
        replyParams.sessionKey = sessionKey;
        replyParams.storePath = storePath;
        replyParams.sessionEntry = sessionEntry;
        replyParams.sessionStore = { [sessionKey]: sessionEntry };
        replyParams.sessionCtx.SessionCreation = {
          via: "operator",
          actor: { type: "human", id: "profile-creator" },
        };
        if (identity) {
          prepareSessionParticipantInput(replyParams.sessionCtx, identity, 1);
        }
        await replaceSessionEntry({ storePath, sessionKey }, sessionEntry);
        await runReplyAgent(replyParams);
        expect(prepareGitCoauthorAttributionMock).toHaveBeenLastCalledWith({
          agentId: "main",
          config: freshCfg,
          currentProfileId: expectedProfileId,
          sessionKey,
          storePath,
        });
        const call = executeAgentTurnMock.mock.calls.at(-1)?.[0];
        if (expectedProfileId) {
          expect(call).toMatchObject({ opts: { gitCoauthorAttribution: attribution } });
        } else {
          expect(call).not.toHaveProperty("opts.gitCoauthorAttribution");
        }
      });
    },
  );

  it("continues the main reply after a recorded memory-flush failure", async () => {
    const { replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    const onBlockReply = vi.fn();
    const replyOperation = createReplyOperation();
    replyParams.opts = { sourceReplyDeliveryMode: "message_tool_only", onBlockReply };
    replyParams.replyOperation = replyOperation;
    resolveQueuedReplyExecutionConfigMock.mockResolvedValue({
      ...freshCfg,
      agents: { defaults: { compaction: { notifyUser: true } } },
    });
    runSessionCompactionIfNeededMock.mockResolvedValue(undefined);
    runMemoryFlushIfNeededMock.mockImplementation(
      async (params: {
        replyOperation: ReplyOperation;
        onVisibleErrorPayloads?: (payloads: Array<{ text?: string; isError?: boolean }>) => void;
      }) => {
        params.replyOperation.setPhase("memory_flushing");
        params.onVisibleErrorPayloads?.([
          { text: "⚠️ memory flush preparation failed", isError: true },
        ]);
        return { sessionEntry: undefined, outcome: "failed" };
      },
    );

    const result = await runReplyAgent(replyParams);

    expect(result).toEqual({ text: "main reply" });
    expect(onBlockReply).not.toHaveBeenCalled();
    expect(executeAgentTurnMock).toHaveBeenCalledOnce();
    expect(replyOperation.setPhase).toHaveBeenLastCalledWith("running");
  });

  it("preserves conversation after byte-forced memory exhaustion and unnecessary preflight", async () => {
    const memory = await vi.importActual<typeof import("./agent-runner-memory.js")>(
      "./agent-runner-memory.js",
    );
    const reset = await vi.importActual<typeof import("./agent-runner-session-reset.js")>(
      "./agent-runner-session-reset.js",
    );
    runMemoryFlushIfNeededMock.mockImplementation(memory.runMemoryFlushIfNeeded);
    runSessionCompactionIfNeededMock.mockImplementation(memory.runSessionCompactionIfNeeded);
    resetReplyRunSessionMock.mockImplementation(reset.resetReplyRunSession);
    registerMemoryCapability("memory-core", {
      flushPlanResolver: () => ({
        softThresholdTokens: 4_000,
        forceFlushTranscriptBytes: 1,
        reserveTokensFloor: 20_000,
        prompt: "Save durable notes. NO_REPLY",
        systemPrompt: "Write memory to memory/notes.md.",
        relativePath: "memory/notes.md",
      }),
    });
    try {
      await withTestDir({ prefix: "openclaw-direct-runtime-" }, async (tempDir) => {
        const { replyParams, followupRun } = createDirectRuntimeReplyParams({
          shouldFollowup: false,
          isActive: false,
        });
        const sessionKey = "agent:main:telegram:default:direct:test";
        const sessionEntry: SessionEntry = {
          sessionId: "session-1",
          lifecycleRevision: "before-maintenance",
          updatedAt: 1,
          totalTokens: 100,
          totalTokensFresh: true,
          totalTokensVersion: 1,
          compactionCount: 4,
          memoryFlush: { kind: "failed", failureCount: 2 },
        };
        const sessionStore = { [sessionKey]: sessionEntry };
        const storePath = join(tempDir, "sessions.json");
        const scope = { agentId: "main", sessionId: sessionEntry.sessionId, sessionKey, storePath };
        await replaceSessionEntry(scope, sessionEntry);
        const olderMessage = { role: "user", content: "Remember the older marker: amber-orchid" };
        const messages = [
          olderMessage,
          { role: "assistant", content: "Noted." },
          ...Array.from({ length: 3 }, (_, index) => [
            { role: "user", content: `Recent question ${index}` },
            { role: "assistant", content: `Recent answer ${index}` },
          ]).flat(),
        ];
        for (const message of messages) {
          await appendTranscriptMessage(scope, { message });
        }
        // A file blocks the memory directory: optional maintenance fails without token pressure.
        await writeFile(join(tempDir, "memory"), "not a directory");
        followupRun.run.workspaceDir = tempDir;
        followupRun.run.provider = "anthropic";
        followupRun.run.model = "claude-sonnet-4-6";
        replyParams.sessionKey = sessionKey;
        replyParams.storePath = storePath;
        replyParams.sessionEntry = sessionEntry;
        replyParams.sessionStore = sessionStore;
        resolveQueuedReplyExecutionConfigMock.mockResolvedValue(
          withTestModelContextTokens({
            cfg: { agents: { defaults: { compaction: { notifyUser: true } } } },
            followupRun,
            defaultModel: replyParams.defaultModel,
            contextTokens: 100_000,
          }),
        );
        const onBlockReply = vi.fn();
        replyParams.opts = { onBlockReply };
        const replyOperation = createReplyOperation();
        replyParams.replyOperation = replyOperation;
        executeAgentTurnMock.mockImplementation(async () => {
          expect(SessionManager.open(scope).buildSessionContext().messages).toEqual(
            messages.map((message) => expect.objectContaining(message)),
          );
          return {
            runId: "runtime-config-test",
            outcome: { kind: "rejected", payload: { text: "main reply" } },
          };
        });

        const result = await runReplyAgent(replyParams);

        expect(result).toEqual({ text: "main reply" });
        expect(resetReplyRunSessionMock).not.toHaveBeenCalled();
        expect(followupRun.run.sessionId).toBe(sessionEntry.sessionId);
        expect(replyOperation.sessionId).toBe(sessionEntry.sessionId);
        expect(loadSessionEntry(scope)).toMatchObject({
          sessionId: sessionEntry.sessionId,
          lifecycleRevision: sessionEntry.lifecycleRevision,
          compactionCount: 4,
          totalTokens: 100,
          totalTokensFresh: true,
          memoryFlush: { kind: "succeeded", compactionCount: 4 },
        });
        expect(sessionStore[sessionKey]).toMatchObject({
          lifecycleRevision: sessionEntry.lifecycleRevision,
          compactionCount: 4,
          totalTokens: 100,
        });
        expect(runMemoryFlushIfNeededMock).toHaveBeenCalledOnce();
        await expect(runMemoryFlushIfNeededMock.mock.results[0]?.value).resolves.toMatchObject({
          outcome: "exhausted",
        });
        expect(runSessionCompactionIfNeededMock).toHaveBeenCalledOnce();
        expect(runMemoryFlushIfNeededMock.mock.invocationCallOrder[0]).toBeLessThan(
          runSessionCompactionIfNeededMock.mock.invocationCallOrder[0]!,
        );
        expect(onBlockReply).toHaveBeenCalledWith(
          expect.objectContaining({
            text: "⚠️ Memory maintenance temporarily failed; continuing your reply.",
          }),
        );
        expect(executeAgentTurnMock).toHaveBeenCalledOnce();
      });
    } finally {
      clearMemoryPluginState();
    }
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
    runSessionCompactionIfNeededMock.mockImplementation(
      async (params: { sessionEntry?: typeof sessionEntry }) => {
        expect(params.sessionEntry?.sessionId).toBe("session-1");
        return { ...params.sessionEntry, compactionCount: 5 };
      },
    );

    await expect(runReplyAgent(replyParams)).resolves.toEqual({ text: "main reply" });

    expect(resetReplyRunSessionMock).not.toHaveBeenCalled();
    expect(executeAgentTurnMock).toHaveBeenCalledOnce();
  });

  it.each(["context_overflow", "auth profile mismatch"])(
    "surfaces required preflight failure (%s) after memory exhaustion without resetting",
    async (reason) => {
      const { replyParams } = createDirectRuntimeReplyParams({
        shouldFollowup: false,
        isActive: false,
      });
      runMemoryFlushIfNeededMock.mockResolvedValue({
        sessionEntry: { sessionId: "session-1", updatedAt: 1, compactionCount: 4 },
        outcome: "exhausted",
      });
      runSessionCompactionIfNeededMock.mockRejectedValue(
        new Error(`Preflight compaction required but failed: ${reason}`),
      );

      const result = await runReplyAgent(replyParams);

      if (!result || Array.isArray(result)) {
        throw new Error("expected a single preflight compaction failure reply payload");
      }
      expect(result.text).toContain("auto-compaction could not recover");
      expect(getReplyPayloadMetadata(result)?.deliverDespiteSourceReplySuppression).toBe(true);
      expect(resetReplyRunSessionMock).not.toHaveBeenCalled();
      expect(executeAgentTurnMock).not.toHaveBeenCalled();
    },
  );

  it.each(["abortByUser", "abortForRestart"] as const)(
    "records %s during memory flush as cancellation without starting the main turn",
    async (abortMethod) => {
      const { replyParams } = createDirectRuntimeReplyParams({
        shouldFollowup: false,
        isActive: false,
      });
      const runState: ReplyOperationRunState = {};
      replyParams.opts = { [REPLY_OPERATION_RUN_STATE]: runState };
      runSessionCompactionIfNeededMock.mockResolvedValue(undefined);
      runMemoryFlushIfNeededMock.mockImplementation(
        async (params: { replyOperation: ReplyOperation }) => {
          expect(params.replyOperation[abortMethod]()).toBe(true);
          return { sessionEntry: undefined, outcome: "failed" };
        },
      );

      const result = await runReplyAgent(replyParams);

      expect(result).toMatchObject({
        text:
          abortMethod === "abortByUser"
            ? SILENT_REPLY_TOKEN
            : "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
      });
      expect(resolveReplyOperationAgentTurn(runState)).toBe("cancelled");
      expect(executeAgentTurnMock).not.toHaveBeenCalled();
    },
  );

  it.each(["user", "restart"] as const)(
    "records an aborted %s agent turn as cancellation",
    async (reason) => {
      const { replyParams } = createDirectRuntimeReplyParams({
        shouldFollowup: false,
        isActive: false,
      });
      const runState: ReplyOperationRunState = {};
      replyParams.opts = { [REPLY_OPERATION_RUN_STATE]: runState };
      runSessionCompactionIfNeededMock.mockResolvedValue(undefined);
      executeAgentTurnMock.mockResolvedValue({
        runId: "cancelled-runtime-config-test",
        outcome: { kind: "aborted", reason },
      });

      await runReplyAgent(replyParams);

      expect(resolveReplyOperationAgentTurn(runState)).toBe("cancelled");
    },
  );

  it("surfaces known pre-run Codex usage-limit failures instead of dropping the reply", async () => {
    const { replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });
    const codexMessage =
      "You've reached your Codex subscription usage limit. Codex did not return a reset time for this limit. Run /codex account for current usage details.";
    runSessionCompactionIfNeededMock.mockRejectedValue(
      new FailoverError(codexMessage, {
        reason: "rate_limit",
        provider: "openai",
        model: "gpt-5.5",
      }),
    );
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
    runSessionCompactionIfNeededMock.mockRejectedValue(
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
    const runState: ReplyOperationRunState = {};
    replyParams.opts = { [REPLY_OPERATION_RUN_STATE]: runState };
    enqueueFollowupRunMock.mockReturnValueOnce(true);

    await expect(runReplyAgent(replyParams)).resolves.toBeUndefined();

    expect(runState.admission).toEqual({ status: "accepted", mode: "followup" });
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
