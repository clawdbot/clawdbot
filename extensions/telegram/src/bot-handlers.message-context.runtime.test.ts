// Telegram tests cover forum topic recovery from the real message cache.
import type { Message } from "grammy/types";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createTelegramMessageContextRuntime } from "./bot-handlers.message-context.runtime.js";
import type { RegisterTelegramHandlerParams } from "./bot-native-commands.js";
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

describe("resolveCachedMessageThreadId", () => {
  beforeEach(() => {
    resetTelegramMessageCacheForTest();
  });

  it("recovers the topic of a recorded forum message", async () => {
    const runtime = createRuntime();
    await runtime.recordMessageForReplyChain(forumMessage(100, TOPIC_ID), TOPIC_ID);

    await expect(
      runtime.resolveCachedMessageThreadId({ chatId: CHAT_ID, messageId: 100 }),
    ).resolves.toBe(TOPIC_ID);
  });

  it("returns undefined for a message that is not in the cache", async () => {
    const runtime = createRuntime();

    // Cache miss must stay unknown; the reaction handler drops rather than
    // attributing the reaction to the General topic.
    await expect(
      runtime.resolveCachedMessageThreadId({ chatId: CHAT_ID, messageId: 404 }),
    ).resolves.toBeUndefined();
  });

  it("returns undefined for a recorded message that carries no topic", async () => {
    const runtime = createRuntime();
    await runtime.recordMessageForReplyChain(forumMessage(101));

    await expect(
      runtime.resolveCachedMessageThreadId({ chatId: CHAT_ID, messageId: 101 }),
    ).resolves.toBeUndefined();
  });
});
