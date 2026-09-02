// Telegram tests cover forum topic recovery from the real message cache.
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTelegramMessageContextRuntime,
  createTelegramMessageSessionRuntime,
} from "./bot-handlers.message-context.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { resetTelegramMessageCacheForTest } from "./runtime.test-support.js";

const CHAT_ID = 5678;
const TOPIC_ID = 77;

let storeScopeId = 0;

/**
 * Builds the runtime against the real message cache so the reaction path's topic
 * recovery is proven through the cache it actually reads, not a stub.
 */
function createRuntime() {
  storeScopeId += 1;
  const cfg: OpenClawConfig = {};
  return createTelegramMessageContextRuntime({
    cfg,
    accountId: "default",
    ownerAgentId: "main",
    opts: { token: "test" },
    telegramCfg: {},
    telegramDeps: {
      resolveStorePath: () => `/tmp/openclaw-telegram-thread-recovery-${storeScopeId}/store.json`,
    } as RegisterTelegramHandlerParams["telegramDeps"],
  });
}

function forumMessage(messageId: number, threadId?: number): Message {
  return {
    chat: { id: CHAT_ID, type: "supergroup", title: "Forum", is_forum: true },
    message_id: messageId,
    date: 1736380800,
    text: "topic message",
    from: { id: 10, is_bot: false, first_name: "Bob" },
    ...(threadId === undefined ? {} : { message_thread_id: threadId }),
  } as Message;
}

describe("resolveCachedMessageThreadSpec", () => {
  beforeEach(() => {
    resetTelegramMessageCacheForTest();
  });

  it("keeps account cache ownership separate from a topic-routed session owner", () => {
    const resolveStorePath = vi.fn(
      (_store, options: { agentId?: string }) =>
        `/tmp/openclaw-telegram-owner-${options.agentId}.json`,
    );
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { main: {}, ops: {}, research: {} },
      },
      bindings: [{ agentId: "main", match: { channel: "telegram", accountId: "*" } }],
    } as OpenClawConfig;
    createTelegramMessageContextRuntime({
      cfg,
      accountId: "primary",
      ownerAgentId: "main",
      opts: { token: "test" },
      telegramCfg: {},
      telegramDeps: {
        resolveStorePath,
      } as unknown as RegisterTelegramHandlerParams["telegramDeps"],
    });
    const sessionRuntime = createTelegramMessageSessionRuntime({
      accountId: "primary",
      resolveTelegramGroupConfig: () => ({ topicConfig: { agentId: "research" } }),
      telegramDeps: {
        resolveStorePath,
      } as unknown as RegisterTelegramHandlerParams["telegramDeps"],
    });

    const session = sessionRuntime.resolveTelegramSessionState({
      chatId: CHAT_ID,
      isGroup: true,
      threadSpec: { id: TOPIC_ID, scope: "forum" },
      senderId: 10,
      runtimeCfg: cfg,
    });

    expect(resolveStorePath.mock.calls.map(([, options]) => options?.agentId)).toEqual([
      "main",
      "research",
    ]);
    expect(session).toMatchObject({
      agentId: "research",
      storePath: "/tmp/openclaw-telegram-owner-research.json",
    });
    expect(session.sessionKey).toContain("agent:research:");
  });

  it("recovers the topic of a recorded forum message", async () => {
    const runtime = createRuntime();
    await runtime.recordMessageForReplyChain(forumMessage(100, TOPIC_ID), {
      scope: "forum",
      id: TOPIC_ID,
    });

    await expect(
      runtime.resolveCachedMessageThreadSpec({ chatId: CHAT_ID, messageId: 100 }),
    ).resolves.toEqual({ scope: "forum", id: TOPIC_ID });
  });

  it("returns undefined for a message that is not in the cache", async () => {
    const runtime = createRuntime();

    // Cache miss must stay unknown; the reaction handler drops rather than
    // attributing the reaction to the General topic.
    await expect(
      runtime.resolveCachedMessageThreadSpec({ chatId: CHAT_ID, messageId: 404 }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined for a recorded message that carries no topic", async () => {
    const runtime = createRuntime();
    await runtime.recordMessageForReplyChain(forumMessage(101));

    await expect(
      runtime.resolveCachedMessageThreadSpec({ chatId: CHAT_ID, messageId: 101 }),
    ).resolves.toBeUndefined();
  });

  it("recovers a channel Direct Messages scope without reusing raw message_thread_id", async () => {
    const runtime = createRuntime();
    const msg = {
      ...forumMessage(102, 999),
      chat: {
        id: CHAT_ID,
        type: "supergroup",
        title: "Channel replies",
        is_direct_messages: true,
      },
      direct_messages_topic: { topic_id: TOPIC_ID },
    } as Message;
    await runtime.recordMessageForReplyChain(msg, {
      scope: "direct-messages",
      id: TOPIC_ID,
    });

    await expect(
      runtime.resolveCachedMessageThreadSpec({ chatId: CHAT_ID, messageId: 102 }),
    ).resolves.toEqual({ scope: "direct-messages", id: TOPIC_ID });
  });
});
