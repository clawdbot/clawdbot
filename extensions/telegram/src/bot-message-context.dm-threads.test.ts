import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetTopicNameCacheForTest } from "./topic-name-cache.js";

type SessionRuntimeModule = typeof import("./bot-message-context.session.runtime.js");
type RecordInboundSessionFn = SessionRuntimeModule["recordInboundSession"];
type ResolveStorePathFn = SessionRuntimeModule["resolveStorePath"];

const { recordInboundSessionMock, resolveStorePathMock } = vi.hoisted(() => ({
  recordInboundSessionMock: vi.fn<RecordInboundSessionFn>(async () => undefined),
  resolveStorePathMock: vi.fn<ResolveStorePathFn>(() => "/tmp/openclaw-session-store.json"),
}));

vi.mock("./bot-message-context.session.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./bot-message-context.session.runtime.js")>(
    "./bot-message-context.session.runtime.js",
  );
  return {
    ...actual,
    recordInboundSession: (...args: Parameters<typeof actual.recordInboundSession>) =>
      recordInboundSessionMock(...args),
    resolveStorePath: (...args: Parameters<typeof actual.resolveStorePath>) =>
      resolveStorePathMock(...args),
  };
});

vi.mock("./bot-message-context.body.js", () => ({
  resolveTelegramInboundBody: async () => ({
    bodyText: "hello",
    rawBody: "hello",
    historyKey: undefined,
    commandAuthorized: false,
    effectiveWasMentioned: true,
    canDetectMention: false,
    shouldBypassMention: false,
    stickerCacheHit: false,
    locationData: undefined,
  }),
}));

const { buildTelegramMessageContextForTest } =
  await import("./bot-message-context.test-harness.js");
const { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } =
  await import("openclaw/plugin-sdk/runtime-config-snapshot");

beforeEach(() => {
  clearRuntimeConfigSnapshot();
  resetTopicNameCacheForTest();
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetTopicNameCacheForTest();
  recordInboundSessionMock.mockClear();
  resolveStorePathMock.mockReset();
  resolveStorePathMock.mockReturnValue("/tmp/openclaw-session-store.json");
});

describe("buildTelegramMessageContext dm thread sessions", () => {
  const buildContext = async (
    message: Record<string, unknown>,
    params?: Pick<
      Parameters<typeof buildTelegramMessageContextForTest>[0],
      "cfg" | "resolveTelegramGroupConfig"
    >,
  ) =>
    await buildTelegramMessageContextForTest({
      message,
      ...params,
    });

  it("keeps incidental dm message_thread_id on the main session by default", async () => {
    const ctx = await buildContext({
      message_id: 1,
      chat: { id: 1234, type: "private" },
      date: 1700000000,
      text: "hello",
      message_thread_id: 42,
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctx?.ctxPayload?.MessageThreadId).toBe(42);
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main");
  });

  it("uses thread session key for configured dm topics", async () => {
    const ctx = await buildContext(
      {
        message_id: 3,
        chat: { id: 1234, type: "private" },
        date: 1700000002,
        text: "hello",
        message_thread_id: 42,
        from: { id: 42, first_name: "Alice" },
      },
      {
        resolveTelegramGroupConfig: () => ({
          groupConfig: { requireTopic: true },
          topicConfig: undefined,
        }),
      },
    );

    expect(ctx?.ctxPayload?.MessageThreadId).toBe(42);
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main:thread:1234:42");
  });

  it("uses thread session key for DM topics when dm.threadReplies is inbound", async () => {
    const ctx = await buildContext(
      {
        message_id: 1,
        chat: { id: 1234, type: "private" },
        date: 1700000000,
        text: "hello",
        message_thread_id: 42,
        from: { id: 42, first_name: "Alice" },
      },
      {
        cfg: {
          agents: {
            defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" },
          },
          channels: {
            telegram: {
              dmPolicy: "open",
              allowFrom: ["*"],
              dm: { threadReplies: "inbound" },
            },
          },
          messages: { groupChat: { mentionPatterns: [] } },
        },
      },
    );

    expect(ctx?.ctxPayload?.MessageThreadId).toBe(42);
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main:thread:1234:42");
  });

  it("lets direct chat config opt one DM back into thread session keys", async () => {
    const cfg = {
      agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          direct: {
            "1234": {
              threadReplies: "inbound",
            },
          },
        },
      },
      messages: { groupChat: { mentionPatterns: [] } },
    };
    const ctx = await buildTelegramMessageContextForTest({
      cfg,
      message: {
        message_id: 1,
        chat: { id: 1234, type: "private" },
        date: 1700000000,
        text: "hello",
        message_thread_id: 42,
        from: { id: 42, first_name: "Alice" },
      },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { threadReplies: "inbound" },
        topicConfig: undefined,
      }),
    });

    expect(ctx?.ctxPayload?.MessageThreadId).toBe(42);
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main:thread:1234:42");
  });

  it("uses the main session key when no thread id", async () => {
    const ctx = await buildContext({
      message_id: 2,
      chat: { id: 1234, type: "private" },
      date: 1700000001,
      text: "hello",
      from: { id: 42, first_name: "Alice" },
    });

    expect(ctx?.ctxPayload?.MessageThreadId).toBeUndefined();
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main");
  });
});

describe("buildTelegramMessageContext group sessions without forum", () => {
  const buildContext = async (message: Record<string, unknown>) =>
    await buildTelegramMessageContextForTest({
      message,
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
    });

  it("ignores message_thread_id for regular groups (not forums)", async () => {
    // When someone replies to a message in a non-forum group, Telegram sends
    // message_thread_id but this should NOT create a separate session
    const ctx = await buildContext({
      message_id: 1,
      chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
      date: 1700000000,
      text: "@bot hello",
      message_thread_id: 42, // This is a reply thread, NOT a forum topic
      from: { id: 42, first_name: "Alice" },
    });

    if (!ctx) {
      throw new Error("expected Telegram non-forum group context");
    }
    // Session key should NOT include :topic:42
    expect(ctx.ctxPayload.SessionKey).toBe("agent:main:telegram:group:-1001234567890");
    // MessageThreadId should be undefined (not a forum)
    expect(ctx.ctxPayload.MessageThreadId).toBeUndefined();
  });

  it("keeps same session for regular group with and without message_thread_id", async () => {
    const ctxWithThread = await buildContext({
      message_id: 1,
      chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
      date: 1700000000,
      text: "@bot hello",
      message_thread_id: 42,
      from: { id: 42, first_name: "Alice" },
    });

    const ctxWithoutThread = await buildContext({
      message_id: 2,
      chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
      date: 1700000001,
      text: "@bot world",
      from: { id: 42, first_name: "Alice" },
    });

    // Both messages should use the same session key
    expect(ctxWithThread?.ctxPayload?.SessionKey).toBe(ctxWithoutThread?.ctxPayload?.SessionKey);
  });

  it("does not add a topic-cache store lookup for non-forum group reply threads", async () => {
    const resolveStorePath = vi.fn(() => "/tmp/openclaw/session-store.json");

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 9,
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
        date: 1700000008,
        text: "@bot hello",
        message_thread_id: 42,
        from: { id: 42, first_name: "Alice" },
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
      sessionRuntime: { resolveStorePath },
    });

    expect(ctx?.isForum).toBe(false);
    expect(ctx?.ctxPayload?.MessageThreadId).toBeUndefined();
    expect(resolveStorePath).toHaveBeenCalledTimes(1);
  });

  it("uses topic session for forum groups with message_thread_id", async () => {
    const ctx = await buildContext({
      message_id: 1,
      chat: { id: -1001234567890, type: "supergroup", title: "Test Forum", is_forum: true },
      date: 1700000000,
      text: "@bot hello",
      message_thread_id: 99,
      from: { id: 42, first_name: "Alice" },
    });

    // Session key SHOULD include :topic:99 for forums
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:group:-1001234567890:topic:99");
    expect(ctx?.ctxPayload?.MessageThreadId).toBe(99);
  });

  it("surfaces topic name from reply_to_message forum metadata", async () => {
    const ctx = await buildContext({
      message_id: 3,
      chat: { id: -1001234567890, type: "supergroup", title: "Test Forum", is_forum: true },
      date: 1700000002,
      text: "@bot hello",
      message_thread_id: 99,
      from: { id: 42, first_name: "Alice" },
      reply_to_message: {
        message_id: 2,
        forum_topic_created: { name: "Deployments", icon_color: 0x6fb9f0 },
      },
    });

    expect(ctx?.ctxPayload?.TopicName).toBe("Deployments");
  });

  it("handles forum messages without session runtime overrides", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        message_id: 3,
        chat: { id: -1001234567890, type: "supergroup", title: "Test Forum", is_forum: true },
        date: 1700000002,
        text: "@bot hello",
        message_thread_id: 99,
        from: { id: 42, first_name: "Alice" },
        reply_to_message: {
          message_id: 2,
          forum_topic_created: { name: "Deployments", icon_color: 0x6fb9f0 },
        },
      },
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
      sessionRuntime: null,
    });

    expect(ctx?.ctxPayload?.TopicName).toBe("Deployments");
  });

  it("reloads topic name from disk after cache reset", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-topic-name-"));
    const sessionStorePath = path.join(tempDir, "sessions.json");
    const buildPersistedContext = async (message: Record<string, unknown>) =>
      await buildTelegramMessageContextForTest({
        message,
        options: { forceWasMentioned: true },
        resolveGroupActivation: () => true,
        sessionRuntime: {
          resolveStorePath: () => sessionStorePath,
        },
      });

    try {
      await buildPersistedContext({
        message_id: 4,
        chat: { id: -1001234567890, type: "supergroup", title: "Test Forum", is_forum: true },
        date: 1700000003,
        text: "@bot hello",
        message_thread_id: 99,
        from: { id: 42, first_name: "Alice" },
        reply_to_message: {
          message_id: 3,
          forum_topic_created: { name: "Deployments", icon_color: 0x6fb9f0 },
        },
      });

      resetTopicNameCacheForTest();

      const ctx = await buildPersistedContext({
        message_id: 5,
        chat: { id: -1001234567890, type: "supergroup", title: "Test Forum", is_forum: true },
        date: 1700000004,
        text: "@bot again",
        message_thread_id: 99,
        from: { id: 42, first_name: "Alice" },
      });

      expect(ctx?.ctxPayload?.TopicName).toBe("Deployments");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      resetTopicNameCacheForTest();
    }
  });

  it("persists topic names through the default session runtime path", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-topic-name-"));
    const sessionStorePath = path.join(tempDir, "sessions.json");
    resolveStorePathMock.mockReturnValue(sessionStorePath);

    try {
      await buildTelegramMessageContextForTest({
        message: {
          message_id: 6,
          chat: { id: -1001234567890, type: "supergroup", title: "Test Forum", is_forum: true },
          date: 1700000005,
          text: "@bot hello",
          message_thread_id: 99,
          from: { id: 42, first_name: "Alice" },
          reply_to_message: {
            message_id: 5,
            forum_topic_created: { name: "Deployments", icon_color: 0x6fb9f0 },
          },
        },
        options: { forceWasMentioned: true },
        resolveGroupActivation: () => true,
        sessionRuntime: null,
      });

      resetTopicNameCacheForTest();

      const ctx = await buildTelegramMessageContextForTest({
        message: {
          message_id: 7,
          chat: { id: -1001234567890, type: "supergroup", title: "Test Forum", is_forum: true },
          date: 1700000006,
          text: "@bot again",
          message_thread_id: 99,
          from: { id: 42, first_name: "Alice" },
        },
        options: { forceWasMentioned: true },
        resolveGroupActivation: () => true,
        sessionRuntime: null,
      });

      expect(ctx?.ctxPayload?.TopicName).toBe("Deployments");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
      resetTopicNameCacheForTest();
    }
  });
});

describe("buildTelegramMessageContext direct peer routing", () => {
  it("isolates dm sessions by sender id when chat id differs", async () => {
    const runtimeCfg = {
      agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
      channels: { telegram: {} },
      messages: { groupChat: { mentionPatterns: [] } },
      session: { dmScope: "per-channel-peer" as const },
    };
    setRuntimeConfigSnapshot(runtimeCfg);

    const baseMessage = {
      chat: { id: 777777777, type: "private" as const },
      date: 1700000000,
      text: "hello",
    };

    const first = await buildTelegramMessageContextForTest({
      cfg: runtimeCfg,
      message: {
        ...baseMessage,
        message_id: 1,
        from: { id: 123456789, first_name: "Alice" },
      },
    });
    const second = await buildTelegramMessageContextForTest({
      cfg: runtimeCfg,
      message: {
        ...baseMessage,
        message_id: 2,
        from: { id: 987654321, first_name: "Bob" },
      },
    });

    expect(first?.ctxPayload?.SessionKey).toBe("agent:main:telegram:direct:123456789");
    expect(second?.ctxPayload?.SessionKey).toBe("agent:main:telegram:direct:987654321");
  });
});
