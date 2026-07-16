import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStoreForTests,
  createPluginStateSyncKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTelegramMessageCache, resolveTelegramMessageCacheScope } from "./message-cache.js";
import { recordOutboundMessageForPromptContext } from "./outbound-message-context.js";
import { setTelegramRuntime } from "./runtime.js";
import {
  clearTelegramRuntimeForTest as clearTelegramRuntime,
  resetTelegramMessageCacheForTest as resetTelegramMessageCacheBucketsForTest,
} from "./runtime.test-support.js";
import type { TelegramRuntime } from "./runtime.types.js";

const cfg = {
  session: { store: "/tmp/openclaw-telegram-outbound-context-test.json" },
} satisfies OpenClawConfig;

function installTelegramStateRuntimeForTest(): void {
  setTelegramRuntime({
    state: {
      openKeyedStore: ((options) =>
        createPluginStateKeyedStoreForTests(
          "telegram",
          options,
        )) as TelegramRuntime["state"]["openKeyedStore"],
      openSyncKeyedStore: ((options) =>
        createPluginStateSyncKeyedStoreForTests(
          "telegram",
          options,
        )) as TelegramRuntime["state"]["openSyncKeyedStore"],
    },
    channel: {},
  } as TelegramRuntime);
}

async function recordAndRead(
  params: Omit<Parameters<typeof recordOutboundMessageForPromptContext>[0], "cfg">,
) {
  await recordOutboundMessageForPromptContext({ cfg, ...params });
  const cache = createPromptContextCache();
  return await cache.get({
    accountId: params.account.accountId,
    chatId: params.chatId,
    messageId: String(params.messageId),
  });
}

function createPromptContextCache() {
  return createTelegramMessageCache({
    scope: resolveTelegramMessageCacheScope(resolveStorePath(cfg.session.store)),
  });
}

describe("recordOutboundMessageForPromptContext", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    resetTelegramMessageCacheBucketsForTest();
    installTelegramStateRuntimeForTest();
  });

  afterEach(() => {
    clearTelegramRuntime();
    resetTelegramMessageCacheBucketsForTest();
    resetPluginStateStoreForTests();
  });

  it("uses the configured self name and drops stale Telegram display-name fields", async () => {
    const cached = await recordAndRead({
      account: { accountId: "default", name: "  Configured Agent  " },
      chatId: 42,
      message: {
        chat: { id: 42, type: "private" },
        date: 1_736_380_700,
        from: {
          id: 999,
          is_bot: true,
          first_name: "Provisioning",
          last_name: "Placeholder",
          username: "openclaw_bot",
        },
        message_id: 700,
        text: "Bot just replied",
      },
      messageId: 700,
      text: "Bot just replied",
    });

    expect(cached).toMatchObject({
      sender: "Configured Agent (you)",
      senderId: "999",
      senderUsername: "openclaw_bot",
      sourceMessage: {
        from: {
          id: 999,
          is_bot: true,
          first_name: "Configured Agent (you)",
          username: "openclaw_bot",
        },
      },
    });
    expect(cached?.sourceMessage.from).not.toHaveProperty("last_name");
  });

  it("falls back to the Telegram bot name when no configured name exists", async () => {
    const cached = await recordAndRead({
      account: { accountId: "default", name: "" },
      chatId: 42,
      message: {
        chat: { id: 42, type: "private" },
        date: 1_736_380_700,
        from: {
          id: 999,
          is_bot: true,
          first_name: "Atlas",
          username: "atlas_bot",
        },
        message_id: 701,
        text: "Bot just replied",
      },
      messageId: 701,
      text: "Bot just replied",
    });

    expect(cached).toMatchObject({
      sender: "Atlas (you)",
      senderId: "999",
      senderUsername: "atlas_bot",
    });
  });

  it("preserves the sending bot identity for Telegram Business messages", async () => {
    const cached = await recordAndRead({
      account: { accountId: "default", name: "Configured Agent" },
      chatId: 42,
      message: {
        chat: { id: 42, type: "private" },
        date: 1_736_380_700,
        from: {
          id: 777,
          is_bot: false,
          first_name: "Business Account",
          username: "business_account",
        },
        sender_business_bot: {
          id: 999,
          is_bot: true,
          first_name: "Telegram Bot Name",
          username: "openclaw_bot",
        },
        message_id: 702,
        text: "Business reply",
      },
      messageId: 702,
      text: "Business reply",
    });

    expect(cached).toMatchObject({
      sender: "Configured Agent (you)",
      senderId: "777",
      senderUsername: "business_account",
      sourceMessage: {
        sender_business_bot: { id: 999, is_bot: true, username: "openclaw_bot" },
      },
    });
  });

  it("uses the synthetic sender identity for a finalized streamed message without from", async () => {
    const initial = await recordAndRead({
      account: { accountId: "default", name: "StreamBot" },
      chatId: 42,
      message: { message_id: 1497 },
      messageId: 1497,
      text: "Final streamed reply",
    });

    expect(initial).toMatchObject({
      sender: "StreamBot (you)",
      senderId: "0",
      sourceMessage: {
        from: {
          id: 0,
          is_bot: true,
          first_name: "StreamBot (you)",
        },
      },
    });
  });

  it("ignores Telegram's fake sender identity across channel post echoes", async () => {
    const initial = await recordAndRead({
      account: { accountId: "default" },
      chatId: -1001,
      message: {
        message_id: 1498,
        from: { id: 777_000, is_bot: false, first_name: "Telegram" },
        sender_chat: { id: -1001, title: "Announcements" },
      },
      messageId: 1498,
      text: "Channel announcement",
    });
    expect(initial).toMatchObject({ sender: "OpenClaw (you)", senderId: "0" });

    const cache = createPromptContextCache();
    await cache.record({
      accountId: "default",
      chatId: -1001,
      msg: {
        message_id: 1498,
        date: 1_736_380_900,
        chat: { id: -1001, type: "supergroup", title: "Announcements" },
        from: { id: 777_000, is_bot: false, first_name: "Telegram" },
        sender_chat: { id: -1001, type: "channel", title: "Announcements" },
        text: "Channel announcement",
      },
    });

    const merged = await cache.get({
      accountId: "default",
      chatId: -1001,
      messageId: "1498",
    });
    expect(merged).toMatchObject({
      sender: "OpenClaw (you)",
      senderId: "0",
      sourceMessage: {
        from: { id: 0, is_bot: true, first_name: "OpenClaw (you)" },
        sender_chat: { id: -1001, type: "channel", title: "Announcements" },
      },
    });
  });
});
