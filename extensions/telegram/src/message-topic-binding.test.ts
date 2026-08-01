// Telegram tests cover provider-observed forum-topic message bindings.
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTelegramMessageCache, resolveTelegramMessageCacheScope } from "./message-cache.js";
import { resolveTelegramMessageMutationChatId } from "./message-topic-binding.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest,
  resetTelegramMessageCacheForTest,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

const cfg = {
  agents: { entries: { main: { default: true } } },
  channels: { telegram: { botToken: "tok" } },
  session: { store: "/tmp/openclaw-telegram-topic-binding-test.json" },
} as OpenClawConfig;

function installRuntimeStore() {
  setTelegramRuntime({
    state: {
      openKeyedStore: ((options) =>
        createPluginStateKeyedStoreForTests(
          "telegram",
          options,
        )) as TelegramRuntime["state"]["openKeyedStore"],
    },
    channel: {},
  } as TelegramRuntime);
}

function delegatedContext(overrides?: Record<string, unknown>) {
  return {
    conversationReadOrigin: "delegated" as const,
    requesterAccountId: "default",
    toolContext: {
      currentChannelProvider: "telegram" as const,
      currentChannelId: "telegram:-1001:topic:77",
      currentMessageId: "901",
    },
    ...overrides,
  };
}

function topicMessage(messageId: number, threadId: number): Message {
  return {
    chat: { id: -1001, type: "supergroup", title: "QA", is_forum: true },
    message_id: messageId,
    message_thread_id: threadId,
    is_topic_message: true,
    date: 1_736_380_700,
    text: `message-${messageId}`,
    from: { id: 1, is_bot: false, first_name: "QA" },
  } as Message;
}

async function recordMessage(params: {
  messageId: number;
  threadId: number;
  providerObserved: boolean;
  accountId?: string;
}) {
  const cache = createTelegramMessageCache({
    scope: resolveTelegramMessageCacheScope(
      resolveStorePath(cfg.session?.store, { agentId: "main" }),
    ),
  });
  await cache.record({
    accountId: params.accountId ?? "default",
    chatId: -1001,
    msg: topicMessage(params.messageId, params.threadId),
    threadId: params.threadId,
    ...(params.providerObserved ? { providerObservedThreadId: params.threadId } : {}),
  });
}

describe("Telegram message topic binding", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    resetTelegramMessageCacheForTest();
    installRuntimeStore();
  });

  afterEach(() => {
    clearTelegramRuntimeForTest();
    resetTelegramMessageCacheForTest();
    resetPluginStateStoreForTests();
  });

  it("allows the trusted current message without a cache lookup", async () => {
    await expect(
      resolveTelegramMessageMutationChatId({
        chatId: "telegram:-1001:topic:77",
        messageId: 901,
        cfg,
        accountId: "default",
        context: delegatedContext(),
      }),
    ).resolves.toBe("-1001");
  });

  it("binds a delegated base-chat spelling to the trusted current topic", async () => {
    await expect(
      resolveTelegramMessageMutationChatId({
        chatId: "-1001",
        messageId: 901,
        cfg,
        accountId: "default",
        context: delegatedContext(),
      }),
    ).resolves.toBe("-1001");
  });

  it("binds General-topic mutations using trusted thread context", async () => {
    await recordMessage({ messageId: 900, threadId: 1, providerObserved: true });
    await recordMessage({ messageId: 899, threadId: 2, providerObserved: true });
    const context = delegatedContext({
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "telegram:-1001",
        currentMessageId: "901",
        currentThreadTs: "1",
      },
    });

    await expect(
      resolveTelegramMessageMutationChatId({
        chatId: "-1001",
        messageId: 901,
        cfg,
        accountId: "default",
        context,
      }),
    ).resolves.toBe("-1001");
    await expect(
      resolveTelegramMessageMutationChatId({
        chatId: "-1001",
        messageId: 900,
        cfg,
        accountId: "default",
        context,
      }),
    ).resolves.toBe("-1001");
    await expect(
      resolveTelegramMessageMutationChatId({
        chatId: "-1001",
        messageId: 899,
        cfg,
        accountId: "default",
        context,
      }),
    ).rejects.toThrow("provider-observed binding");
  });

  it("rejects a topicless different-chat target during a trusted topic turn", async () => {
    await expect(
      resolveTelegramMessageMutationChatId({
        chatId: "-1002",
        messageId: 901,
        cfg,
        accountId: "default",
        context: delegatedContext(),
      }),
    ).rejects.toThrow("provider-observed binding");
  });

  it.each([
    {
      name: "different chat",
      chatId: "-1002",
      context: delegatedContext({
        toolContext: {
          currentChannelProvider: "telegram",
          currentChannelId: "telegram:-1001",
          currentMessageId: "901",
        },
      }),
    },
    {
      name: "different provider",
      chatId: "-1001",
      context: delegatedContext({
        toolContext: {
          currentChannelProvider: "slack",
          currentChannelId: "telegram:-1001",
          currentMessageId: "901",
        },
      }),
    },
    {
      name: "different account",
      chatId: "-1001",
      context: delegatedContext({
        requesterAccountId: "work",
        toolContext: {
          currentChannelProvider: "telegram",
          currentChannelId: "telegram:-1001",
          currentMessageId: "901",
        },
      }),
    },
  ])("rejects a threadless $name mutation", async ({ chatId, context }) => {
    await expect(
      resolveTelegramMessageMutationChatId({
        chatId,
        messageId: 901,
        cfg,
        accountId: "default",
        context,
      }),
    ).rejects.toThrow("provider-observed binding");
  });

  it("allows a threadless exact-current mutation with a matching account", async () => {
    await expect(
      resolveTelegramMessageMutationChatId({
        chatId: "-1001",
        messageId: 901,
        cfg,
        accountId: "default",
        context: delegatedContext({
          toolContext: {
            currentChannelProvider: "telegram",
            currentChannelId: "telegram:-1001",
            currentMessageId: "901",
          },
        }),
      }),
    ).resolves.toBe("-1001");
  });

  it("allows an earlier provider-observed same-topic message after restart", async () => {
    await recordMessage({ messageId: 900, threadId: 77, providerObserved: true });
    resetTelegramMessageCacheForTest();

    await expect(
      resolveTelegramMessageMutationChatId({
        chatId: "-1001:topic:77",
        messageId: 900,
        cfg,
        accountId: "default",
        context: delegatedContext(),
      }),
    ).resolves.toBe("-1001");
  });

  it("rejects legacy and wrong-topic cache entries", async () => {
    await recordMessage({ messageId: 899, threadId: 77, providerObserved: false });
    await recordMessage({ messageId: 900, threadId: 88, providerObserved: true });
    resetTelegramMessageCacheForTest();

    for (const messageId of [899, 900]) {
      await expect(
        resolveTelegramMessageMutationChatId({
          chatId: "-1001:topic:77",
          messageId,
          cfg,
          accountId: "default",
          context: delegatedContext(),
        }),
      ).rejects.toThrow("provider-observed binding");
    }
  });

  it("does not borrow a binding from another account", async () => {
    await recordMessage({ messageId: 900, threadId: 77, providerObserved: true });

    await expect(
      resolveTelegramMessageMutationChatId({
        chatId: "-1001:topic:77",
        messageId: 900,
        cfg,
        accountId: "work",
        context: delegatedContext({ requesterAccountId: "work" }),
      }),
    ).rejects.toThrow("provider-observed binding");

    await recordMessage({
      messageId: 900,
      threadId: 77,
      providerObserved: true,
      accountId: "work",
    });
    await expect(
      resolveTelegramMessageMutationChatId({
        chatId: "-1001:topic:77",
        messageId: 900,
        cfg,
        accountId: "work",
        context: delegatedContext({ requesterAccountId: "work" }),
      }),
    ).resolves.toBe("-1001");
  });

  it.each([
    {
      name: "missing origin",
      messageId: 800,
      context: {
        requesterAccountId: "default",
        toolContext: delegatedContext().toolContext,
      },
    },
    {
      name: "unknown origin",
      messageId: 800,
      context: delegatedContext({ conversationReadOrigin: "forged-direct-operator" }),
    },
    {
      name: "wrong account",
      context: delegatedContext({ requesterAccountId: "work" }),
    },
    {
      name: "invalid account",
      accountId: " !!! ",
      context: delegatedContext({ requesterAccountId: " !!! " }),
    },
    {
      name: "wrong provider",
      context: delegatedContext({
        toolContext: {
          ...delegatedContext().toolContext,
          currentChannelProvider: "slack",
        },
      }),
    },
    {
      name: "stale topic",
      context: delegatedContext({
        toolContext: {
          ...delegatedContext().toolContext,
          currentChannelId: "telegram:-1001:topic:88",
        },
      }),
    },
    {
      name: "conflicting trusted thread context",
      context: delegatedContext({
        toolContext: {
          ...delegatedContext().toolContext,
          currentThreadTs: "88",
        },
      }),
    },
    {
      name: "conflicting target forms",
      context: delegatedContext({
        toolContext: {
          ...delegatedContext().toolContext,
          currentMessagingTarget: "telegram:-1002:topic:77",
        },
      }),
    },
  ])("rejects $name before provider execution", async ({ accountId, context, messageId }) => {
    await expect(
      resolveTelegramMessageMutationChatId({
        chatId: "-1001:topic:77",
        messageId: messageId ?? 901,
        cfg,
        accountId: accountId ?? "default",
        context: context as never,
      }),
    ).rejects.toThrow("provider-observed binding");
  });

  it("keeps direct and delegated authority operation-local under mixed ordering", async () => {
    const direct = () =>
      resolveTelegramMessageMutationChatId({
        chatId: "-1001:topic:77",
        messageId: 800,
        cfg,
        accountId: "default",
        context: { conversationReadOrigin: "direct-operator" },
      });
    const delegated = () =>
      resolveTelegramMessageMutationChatId({
        chatId: "-1001:topic:77",
        messageId: 800,
        cfg,
        accountId: "default",
        context: delegatedContext(),
      });

    await expect(direct()).resolves.toBe("-1001");
    await expect(delegated()).rejects.toThrow("provider-observed binding");
    await expect(delegated()).rejects.toThrow("provider-observed binding");
    await expect(direct()).resolves.toBe("-1001");

    const concurrent = await Promise.allSettled([direct(), delegated()]);
    expect(concurrent.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  });
});
