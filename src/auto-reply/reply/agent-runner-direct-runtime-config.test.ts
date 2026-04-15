import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const freshCfg = { runtimeFresh: true };
const staleCfg = {
  runtimeFresh: false,
  skills: {
    entries: {
      whisper: {
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
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
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session-1",
        sessionKey: "agent:main:telegram:default:direct:test",
        messageProvider: "telegram",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: staleCfg,
        skillsSnapshot: {},
        provider: "openai",
        model: "gpt-5.4",
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;

    const resolvedQueue = { mode: "interrupt" } as QueueSettings;
    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "12345",
      AccountId: "default",
      ChatType: "dm",
      MessageSid: "msg-1",
    } as unknown as TemplateContext;

    await expect(
      runReplyAgent({
        commandBody: "hello",
        followupRun,
        queueKey: "main",
        resolvedQueue,
        shouldSteer: false,
        shouldFollowup: false,
        isActive: false,
        isStreaming: false,
        typing,
        sessionCtx,
        defaultModel: "openai/gpt-5.4",
        resolvedVerboseLevel: "off",
        isNewSession: false,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: "instant",
      }),
    ).rejects.toBe(sentinelError);

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
    const followupRun = {
      prompt: "hello",
      summaryLine: "hello",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session-1",
        sessionKey: "agent:main:telegram:default:direct:test",
        messageProvider: "telegram",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: staleCfg,
        skillsSnapshot: {},
        provider: "openai",
        model: "gpt-5.4",
        thinkLevel: "low",
        verboseLevel: "off",
        elevatedLevel: "off",
        bashElevated: {
          enabled: false,
          allowed: false,
          defaultLevel: "off",
        },
        timeoutMs: 1_000,
        blockReplyBreak: "message_end",
      },
    } as unknown as FollowupRun;

    const resolvedQueue = { mode: "interrupt" } as QueueSettings;
    const typing = createMockTypingController();
    const sessionCtx = {
      Provider: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "12345",
      AccountId: "default",
      ChatType: "dm",
      MessageSid: "msg-1",
    } as unknown as TemplateContext;

    await expect(
      runReplyAgent({
        commandBody: "hello",
        followupRun,
        queueKey: "main",
        resolvedQueue,
        shouldSteer: false,
        shouldFollowup: true,
        isActive: true,
        isStreaming: false,
        typing,
        sessionCtx,
        defaultModel: "openai/gpt-5.4",
        resolvedVerboseLevel: "off",
        isNewSession: false,
        blockStreamingEnabled: false,
        resolvedBlockStreamingBreak: "message_end",
        shouldInjectGroupIntro: false,
        typingMode: "instant",
      }),
    ).resolves.toBeUndefined();

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
