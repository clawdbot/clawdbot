import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";
import type { QueueSettings } from "./queue.js";
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
const createReplyMediaPathNormalizerMock = vi.fn();
const runPreflightCompactionIfNeededMock = vi.fn();
const runMemoryFlushIfNeededMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();

vi.mock("./agent-runner-utils.js", () => ({
  resolveQueuedReplyExecutionConfig: (...args: unknown[]) =>
    resolveQueuedReplyExecutionConfigMock(...args),
}));

vi.mock("./reply-threading.js", () => ({
  resolveReplyToMode: (...args: unknown[]) => resolveReplyToModeMock(...args),
  createReplyToModeFilterForChannel: (...args: unknown[]) =>
    createReplyToModeFilterForChannelMock(...args),
}));

vi.mock("./reply-media-paths.js", () => ({
  createReplyMediaPathNormalizer: (...args: unknown[]) =>
    createReplyMediaPathNormalizerMock(...args),
}));

vi.mock("./agent-runner-memory.js", () => ({
  runPreflightCompactionIfNeeded: (...args: unknown[]) =>
    runPreflightCompactionIfNeededMock(...args),
  runMemoryFlushIfNeeded: (...args: unknown[]) => runMemoryFlushIfNeededMock(...args),
}));

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

describe("runReplyAgent runtime config", () => {
  beforeEach(() => {
    resolveQueuedReplyExecutionConfigMock.mockReset();
    resolveReplyToModeMock.mockReset();
    createReplyToModeFilterForChannelMock.mockReset();
    createReplyMediaPathNormalizerMock.mockReset();
    runPreflightCompactionIfNeededMock.mockReset();
    runMemoryFlushIfNeededMock.mockReset();
    enqueueFollowupRunMock.mockReset();

    resolveQueuedReplyExecutionConfigMock.mockResolvedValue(freshCfg);
    resolveReplyToModeMock.mockReturnValue("default");
    createReplyToModeFilterForChannelMock.mockReturnValue((payload: unknown) => payload);
    createReplyMediaPathNormalizerMock.mockReturnValue((payload: unknown) => payload);
    runPreflightCompactionIfNeededMock.mockRejectedValue(sentinelError);
    runMemoryFlushIfNeededMock.mockResolvedValue(undefined);
  });

  it("resolves direct reply runs before early helpers read config", async () => {
    const { followupRun, replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: false,
      isActive: false,
    });

    await expect(runReplyAgent(replyParams)).rejects.toBe(sentinelError);

    expect(followupRun.run.config).toBe(freshCfg);
    expect(resolveQueuedReplyExecutionConfigMock).toHaveBeenCalledWith(
      staleCfg,
      expect.objectContaining({
        originatingChannel: "telegram",
        messageProvider: "telegram",
      }),
    );
    expect(resolveReplyToModeMock).toHaveBeenCalledWith(freshCfg, "telegram", "default", "dm");
    expect(createReplyMediaPathNormalizerMock).toHaveBeenCalledWith({
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
    expect(runPreflightCompactionIfNeededMock).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: freshCfg,
        followupRun,
      }),
    );
  });

  it("does not resolve secrets before the enqueue-followup queue path", async () => {
    const { followupRun, resolvedQueue, replyParams } = createDirectRuntimeReplyParams({
      shouldFollowup: true,
      isActive: true,
    });

    await expect(runReplyAgent(replyParams)).resolves.toBeUndefined();

    expect(resolveQueuedReplyExecutionConfigMock).not.toHaveBeenCalled();
    expect(enqueueFollowupRunMock).toHaveBeenCalledWith(
      "main",
      followupRun,
      resolvedQueue,
      "message-id",
      expect.any(Function),
      false,
    );
  });
});
