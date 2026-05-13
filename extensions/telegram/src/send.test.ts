import fs from "node:fs";
import type { Bot } from "grammy";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getTelegramSendTestMocks,
  importTelegramSendModule,
  installTelegramSendTestHooks,
} from "./send.test-harness.js";
import {
  clearSentMessageCache,
  recordSentMessage,
  resetSentMessageCacheForTest,
  wasSentByBot,
} from "./sent-message-cache.js";

installTelegramSendTestHooks();

const {
  botApi,
  botConfigUseSpy,
  botCtorSpy,
  imageMetadata,
  loadConfig,
  loadWebMedia,
  maybePersistResolvedTelegramTarget,
  probeVideoDimensions,
} = getTelegramSendTestMocks();
const {
  buildInlineKeyboard,
  createForumTopicTelegram,
  deleteMessageTelegram,
  editForumTopicTelegram,
  editMessageTelegram,
  pinMessageTelegram,
  reactMessageTelegram,
  renameForumTopicTelegram,
  sendMessageTelegram,
  sendTypingTelegram,
  sendPollTelegram,
  sendStickerTelegram,
  unpinMessageTelegram,
} = await importTelegramSendModule();

const TELEGRAM_TEST_CFG = {};

async function expectChatNotFoundWithChatId(
  action: Promise<unknown>,
  expectedChatId: string,
): Promise<void> {
  try {
    await action;
    throw new Error("Expected action to reject with chat-not-found context");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Expected action to reject with chat-not-found context"
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/chat not found/i);
    expect(message).toMatch(new RegExp(`chat_id=${expectedChatId}`));
  }
}

async function expectTelegramMembershipErrorWithChatId(
  action: Promise<unknown>,
  expectedChatId: string,
  expectedDetail: RegExp,
): Promise<void> {
  try {
    await action;
    throw new Error("Expected action to reject with membership error context");
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Expected action to reject with membership error context"
    ) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    expect(message).toMatch(/not a member of the chat, was blocked, or was kicked/i);
    expect(message).toMatch(expectedDetail);
    expect(message).toMatch(/Fix: Add the bot to the channel\/group/i);
    expect(message).toMatch(new RegExp(`chat_id=${expectedChatId}`));
  }
}

function mockLoadedMedia({
  buffer = Buffer.from("media"),
  contentType,
  fileName,
}: {
  buffer?: Buffer;
  contentType?: string;
  fileName?: string;
}): void {
  loadWebMedia.mockResolvedValueOnce({
    buffer,
    ...(contentType ? { contentType } : {}),
    ...(fileName ? { fileName } : {}),
  });
}

function requireMockCall<T extends unknown[]>(call: T | undefined, label: string): T {
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call;
}

function mockCall(mock: ReturnType<typeof vi.fn>, index: number, label: string): unknown[] {
  const calls = mock.mock.calls;
  const resolvedIndex = index < 0 ? calls.length + index : index;
  return requireMockCall(calls[resolvedIndex], label);
}

function firstMockCall(mock: ReturnType<typeof vi.fn>, label: string): unknown[] {
  return mockCall(mock, 0, label);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`expected ${label} to be a string`);
  }
  return value;
}

function mockCallText(call: unknown[], label: string): string {
  return requireString(call[1], label);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function expectMediaSendCall(
  call: unknown[] | undefined,
  label: string,
  chatId: string,
  expectedParams: Record<string, unknown>,
): void {
  const [actualChatId, media, actualParams] = requireMockCall(call, label);
  expect(actualChatId).toBe(chatId);
  if (media === undefined) {
    throw new Error(`expected ${label} media`);
  }
  expect(actualParams).toEqual(expectedParams);
}

function expectPersistedTarget(fields: Record<string, unknown>): void {
  const [target] = requireMockCall(
    mockCall(maybePersistResolvedTelegramTarget, -1, "persisted Telegram target"),
    "persisted Telegram target",
  );
  const record = requireRecord(target, "persisted Telegram target");
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

describe("sent-message-cache", () => {
  afterEach(() => {
    vi.useRealTimers();
    clearSentMessageCache();
  });

  it("records and retrieves sent messages", () => {
    recordSentMessage(123, 1);
    recordSentMessage(123, 2);
    recordSentMessage(456, 10);

    expect(wasSentByBot(123, 1)).toBe(true);
    expect(wasSentByBot(123, 2)).toBe(true);
    expect(wasSentByBot(456, 10)).toBe(true);
    expect(wasSentByBot(123, 3)).toBe(false);
    expect(wasSentByBot(789, 1)).toBe(false);
  });

  it("handles string chat IDs", () => {
    recordSentMessage("123", 1);
    expect(wasSentByBot("123", 1)).toBe(true);
    expect(wasSentByBot(123, 1)).toBe(true);
  });

  it("clears cache", () => {
    recordSentMessage(123, 1);
    expect(wasSentByBot(123, 1)).toBe(true);

    clearSentMessageCache();
    expect(wasSentByBot(123, 1)).toBe(false);
  });

  it("keeps sent-message ownership across restart", async () => {
    const persistedStorePath = `/tmp/openclaw-telegram-send-tests-${process.pid}-restart.json`;
    const sentMessageCfg = { session: { store: persistedStorePath } };

    recordSentMessage(123, 1, sentMessageCfg);
    expect(wasSentByBot(123, 1, sentMessageCfg)).toBe(true);

    resetSentMessageCacheForTest();

    const restartedCache = await importFreshModule<typeof import("./sent-message-cache.js")>(
      import.meta.url,
      "./sent-message-cache.js?scope=restart",
    );

    try {
      expect(restartedCache.wasSentByBot(123, 1, sentMessageCfg)).toBe(true);
    } finally {
      restartedCache.clearSentMessageCache();
    }
  });

  it("keeps expired custom-store cleanup away from the default store", () => {
    const customStorePath = `/tmp/openclaw-telegram-send-tests-${process.pid}-custom-cleanup.json`;
    const customCfg = { session: { store: customStorePath } };
    const startedAt = new Date("2026-01-01T00:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(startedAt);

    try {
      recordSentMessage(123, 2, customCfg);

      vi.setSystemTime(startedAt.getTime() + 24 * 60 * 60 * 1000 + 1);
      recordSentMessage(123, 1);

      expect(wasSentByBot(123, 2, customCfg)).toBe(false);
      expect(wasSentByBot(123, 1)).toBe(true);
    } finally {
      fs.rmSync(customStorePath, { force: true });
      fs.rmSync(`${customStorePath}.telegram-sent-messages.json`, { force: true });
    }
  });

  it("keeps default and custom stores isolated while both are loaded", () => {
    const customStorePath = `/tmp/openclaw-telegram-send-tests-${process.pid}-custom-isolated.json`;
    const customCfg = { session: { store: customStorePath } };

    try {
      recordSentMessage(123, 1);
      recordSentMessage(123, 2, customCfg);

      expect(wasSentByBot(123, 1)).toBe(true);
      expect(wasSentByBot(123, 2)).toBe(false);
      expect(wasSentByBot(123, 1, customCfg)).toBe(false);
      expect(wasSentByBot(123, 2, customCfg)).toBe(true);
    } finally {
      fs.rmSync(customStorePath, { force: true });
      fs.rmSync(`${customStorePath}.telegram-sent-messages.json`, { force: true });
    }
  });

  it("shares sent-message state across distinct module instances", async () => {
    const cacheA = await importFreshModule<typeof import("./sent-message-cache.js")>(
      import.meta.url,
      "./sent-message-cache.js?scope=shared-a",
    );
    const cacheB = await importFreshModule<typeof import("./sent-message-cache.js")>(
      import.meta.url,
      "./sent-message-cache.js?scope=shared-b",
    );

    cacheA.clearSentMessageCache();

    try {
      cacheA.recordSentMessage(123, 1);
      expect(cacheB.wasSentByBot(123, 1)).toBe(true);

      cacheB.clearSentMessageCache();
      expect(cacheA.wasSentByBot(123, 1)).toBe(false);
    } finally {
      cacheA.clearSentMessageCache();
    }
  });
});

describe("buildInlineKeyboard", () => {
  it("normalizes keyboard inputs", () => {
    const cases: Array<{
      name: string;
      input: Parameters<typeof buildInlineKeyboard>[0];
      expected: ReturnType<typeof buildInlineKeyboard>;
    }> = [
      {
        name: "empty input",
        input: undefined,
        expected: undefined,
      },
      {
        name: "empty rows",
        input: [],
        expected: undefined,
      },
      {
        name: "valid rows",
        input: [
          [{ text: "Option A", callback_data: "cmd:a" }],
          [
            { text: "Option B", callback_data: "cmd:b" },
            { text: "Option C", callback_data: "cmd:c" },
          ],
        ],
        expected: {
          inline_keyboard: [
            [{ text: "Option A", callback_data: "cmd:a" }],
            [
              { text: "Option B", callback_data: "cmd:b" },
              { text: "Option C", callback_data: "cmd:c" },
            ],
          ],
        },
      },
      {
        name: "keeps button style fields",
        input: [
          [
            {
              text: "Option A",
              callback_data: "cmd:a",
              style: "primary",
            },
          ],
        ],
        expected: {
          inline_keyboard: [
            [
              {
                text: "Option A",
                callback_data: "cmd:a",
                style: "primary",
              },
            ],
          ],
        },
      },
      {
        name: "keeps url buttons",
        input: [[{ text: "Open", url: "https://example.com" }]],
        expected: {
          inline_keyboard: [[{ text: "Open", url: "https://example.com" }]],
        },
      },
      {
        name: "prefers url over callback data when both are present",
        input: [[{ text: "Open", callback_data: "cmd:open", url: "https://example.com" }]],
        expected: {
          inline_keyboard: [[{ text: "Open", url: "https://example.com" }]],
        },
      },
      {
        name: "filters invalid buttons and empty rows",
        input: [
          [
            { text: "", callback_data: "cmd:skip" },
            { text: "Ok", callback_data: "cmd:ok" },
          ],
          [{ text: "Missing data", callback_data: "" }],
          [{ text: "Missing action" }],
          [],
        ],
        expected: {
          inline_keyboard: [[{ text: "Ok", callback_data: "cmd:ok" }]],
        },
      },
    ];
    for (const testCase of cases) {
      const input = testCase.input?.map((row) => row.map((button) => ({ ...button })));
      expect(buildInlineKeyboard(input), testCase.name).toEqual(testCase.expected);
    }
  });
});

describe("sendMessageTelegram", () => {
  it("sends typing to the resolved chat and topic", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.sendChatAction.mockResolvedValue(true);

    await sendTypingTelegram("telegram:group:-1001234567890:topic:271", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "default",
    });

    expect(botApi.sendChatAction).toHaveBeenCalledWith("-1001234567890", "typing", {
      message_thread_id: 271,
    });
  });

  it("pins and unpins Telegram messages", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.pinChatMessage.mockResolvedValue(true);
    botApi.unpinChatMessage.mockResolvedValue(true);

    await pinMessageTelegram("-1001234567890", 101, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "default",
    });
    await unpinMessageTelegram("-1001234567890", 101, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "default",
    });

    expect(botApi.pinChatMessage).toHaveBeenCalledWith("-1001234567890", 101, {
      disable_notification: true,
    });
    expect(botApi.unpinChatMessage).toHaveBeenCalledWith("-1001234567890", 101);
  });

  it("honors Telegram pin notification requests", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.pinChatMessage.mockResolvedValue(true);

    await pinMessageTelegram("-1001234567890", 101, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "default",
      notify: true,
    });

    expect(botApi.pinChatMessage).toHaveBeenCalledWith("-1001234567890", 101, {
      disable_notification: false,
    });
  });

  it("renames a Telegram forum topic", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.editForumTopic.mockResolvedValue(true);

    await renameForumTopicTelegram("-1001234567890", 271, "Codex Thread", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "default",
    });

    expect(botApi.editForumTopic).toHaveBeenCalledWith("-1001234567890", 271, {
      name: "Codex Thread",
    });
  });

  it("edits a Telegram forum topic name and icon via the shared helper", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.editForumTopic.mockResolvedValue(true);

    await editForumTopicTelegram("-1001234567890", 271, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "default",
      name: "Codex Thread",
      iconCustomEmojiId: "emoji-123",
    });

    expect(botApi.editForumTopic).toHaveBeenCalledWith("-1001234567890", 271, {
      name: "Codex Thread",
      icon_custom_emoji_id: "emoji-123",
    });
  });

  it("strips topic suffixes before editing a Telegram forum topic", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          botToken: "tok",
        },
      },
    });
    botApi.editForumTopic.mockResolvedValue(true);

    await editForumTopicTelegram("telegram:group:-1001234567890:topic:271", 271, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      accountId: "default",
      name: "Codex Thread",
    });

    expect(botApi.editForumTopic).toHaveBeenCalledWith("-1001234567890", 271, {
      name: "Codex Thread",
    });
  });

  it("rejects empty topic edits", async () => {
    await expect(
      editForumTopicTelegram("-1001234567890", 271, {
        cfg: TELEGRAM_TEST_CFG,
        accountId: "default",
      }),
    ).rejects.toThrow("Telegram forum topic update requires a name or iconCustomEmojiId");
    await expect(
      editForumTopicTelegram("-1001234567890", 271, {
        cfg: TELEGRAM_TEST_CFG,
        accountId: "default",
        iconCustomEmojiId: "   ",
      }),
    ).rejects.toThrow("Telegram forum topic icon custom emoji ID is required");
  });

  it("applies timeoutSeconds config precedence", async () => {
    const cases = [
      {
        name: "global telegram timeout",
        cfg: { channels: { telegram: { timeoutSeconds: 60 } } },
        opts: { cfg: TELEGRAM_TEST_CFG, token: "tok" },
        expectedTimeout: 60,
      },
      {
        name: "per-account timeout override",
        cfg: {
          channels: {
            telegram: {
              timeoutSeconds: 60,
              accounts: { foo: { timeoutSeconds: 61 } },
            },
          },
        },
        opts: { cfg: TELEGRAM_TEST_CFG, token: "tok", accountId: "foo" },
        expectedTimeout: 61,
      },
    ] as const;
    for (const testCase of cases) {
      botCtorSpy.mockClear();
      loadConfig.mockReturnValue(testCase.cfg);
      botApi.sendMessage.mockResolvedValue({
        message_id: 1,
        chat: { id: "123" },
      });
      await sendMessageTelegram("123", "hi", { ...testCase.opts, cfg: testCase.cfg });
      const [token, options] = firstMockCall(botCtorSpy, "bot constructor call");
      expect(token, testCase.name).toBe("tok");
      const client = requireRecord(requireRecord(options, "bot options").client, "bot client");
      expect(client.timeoutSeconds, testCase.name).toBe(testCase.expectedTimeout);
    }
  });

  it("normalizes full Telegram bot endpoint apiRoot before send clients reach grammY", async () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            foo: {
              apiRoot: "https://api.telegram.org/bot123456:ABC/",
            },
          },
        },
      },
    };
    loadConfig.mockReturnValue(cfg);
    botApi.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: "123" } });

    await sendMessageTelegram("123", "hi", { cfg, token: "tok", accountId: "foo" });

    const [token, options] = firstMockCall(botCtorSpy, "bot constructor call");
    expect(token).toBe("tok");
    const client = requireRecord(requireRecord(options, "bot options").client, "bot client");
    expect(client.apiRoot).toBe("https://api.telegram.org");
  });

  it("installs the shared grammY throttler on send clients", async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: "123" } });

    await sendMessageTelegram("123", "hi", { cfg: TELEGRAM_TEST_CFG, token: "tok" });

    const [middleware] = firstMockCall(botConfigUseSpy, "bot config use call");
    expect(middleware).toBeTypeOf("function");
  });

  it("falls back to plain text when Telegram rejects HTML and preserves send params", async () => {
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 9",
    );
    const cases = [
      {
        name: "plain text send",
        chatId: "123",
        text: "_oops_",
        htmlText: "<i>oops</i>",
        messageId: 42,
        options: { verbose: true } as const,
        firstCall: { parse_mode: "HTML" },
        secondCall: undefined,
      },
      {
        name: "threaded reply send",
        chatId: "-1001234567890",
        text: "_bad markdown_",
        htmlText: "<i>bad markdown</i>",
        messageId: 60,
        options: { messageThreadId: 271, replyToMessageId: 100 } as const,
        firstCall: {
          parse_mode: "HTML",
          message_thread_id: 271,
          reply_to_message_id: 100,
          allow_sending_without_reply: true,
        },
        secondCall: {
          message_thread_id: 271,
          reply_to_message_id: 100,
          allow_sending_without_reply: true,
        },
      },
    ] as const;

    for (const testCase of cases) {
      const sendMessage = vi
        .fn()
        .mockRejectedValueOnce(parseErr)
        .mockResolvedValueOnce({
          message_id: testCase.messageId,
          chat: { id: testCase.chatId },
        });
      const api = { sendMessage } as unknown as {
        sendMessage: typeof sendMessage;
      };

      const res = await sendMessageTelegram(testCase.chatId, testCase.text, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        ...testCase.options,
      });

      expect(sendMessage, testCase.name).toHaveBeenNthCalledWith(
        1,
        testCase.chatId,
        testCase.htmlText,
        testCase.firstCall,
      );
      if (testCase.secondCall) {
        expect(sendMessage, testCase.name).toHaveBeenNthCalledWith(
          2,
          testCase.chatId,
          testCase.text,
          testCase.secondCall,
        );
      } else {
        expect(sendMessage, testCase.name).toHaveBeenNthCalledWith(
          2,
          testCase.chatId,
          testCase.text,
        );
      }
      expect(res.chatId, testCase.name).toBe(testCase.chatId);
      expect(res.messageId, testCase.name).toBe(String(testCase.messageId));
    }
  });

  it("keeps link_preview_options disabled for both html and plain-text fallback", async () => {
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 9",
    );
    const cases = [
      {
        name: "html send succeeds",
        text: "hi",
        sendMessage: vi.fn().mockResolvedValue({ message_id: 7, chat: { id: "123" } }),
        expectedCalls: [
          ["123", "hi", { parse_mode: "HTML", link_preview_options: { is_disabled: true } }],
        ],
      },
      {
        name: "html parse fails then plain-text fallback",
        text: "_oops_",
        sendMessage: vi
          .fn()
          .mockRejectedValueOnce(parseErr)
          .mockResolvedValueOnce({ message_id: 42, chat: { id: "123" } }),
        expectedCalls: [
          [
            "123",
            "<i>oops</i>",
            { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
          ],
          ["123", "_oops_", { link_preview_options: { is_disabled: true } }],
        ],
      },
    ] as const;
    for (const testCase of cases) {
      const cfg = {
        channels: { telegram: { linkPreview: false } },
      };
      loadConfig.mockReturnValue(cfg);
      const api = { sendMessage: testCase.sendMessage } as unknown as {
        sendMessage: typeof testCase.sendMessage;
      };
      await sendMessageTelegram("123", testCase.text, {
        cfg,
        token: "tok",
        api,
      });
      expect(testCase.sendMessage.mock.calls, testCase.name).toEqual(testCase.expectedCalls);
    }
  });

  it("fails when Telegram text send returns no message_id", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      chat: { id: "123" },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram("123", "hi", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
      }),
    ).rejects.toThrow(/returned no message_id/i);
  });

  it("fails when Telegram media send returns no message_id", async () => {
    mockLoadedMedia({ contentType: "image/png", fileName: "photo.png" });
    const sendPhoto = vi.fn().mockResolvedValue({
      chat: { id: "123" },
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    await expect(
      sendMessageTelegram("123", "caption", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        mediaUrl: "https://example.com/photo.png",
      }),
    ).rejects.toThrow(/returned no message_id/i);
  });

  it("uses native fetch for BAN compatibility when api is omitted", async () => {
    const originalFetch = globalThis.fetch;
    const originalBun = (globalThis as { Bun?: unknown }).Bun;
    const fetchSpy = vi.fn() as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    (globalThis as { Bun?: unknown }).Bun = {};
    botApi.sendMessage.mockResolvedValue({
      message_id: 1,
      chat: { id: "123" },
    });
    try {
      await sendMessageTelegram("123", "hi", { cfg: TELEGRAM_TEST_CFG, token: "tok" });
      const clientFetch = (
        firstMockCall(botCtorSpy, "bot constructor call")[1] as {
          client?: { fetch?: unknown };
        }
      )?.client?.fetch;
      expect(clientFetch).toBeTypeOf("function");
      expect(clientFetch).not.toBe(fetchSpy);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalBun === undefined) {
        delete (globalThis as { Bun?: unknown }).Bun;
      } else {
        (globalThis as { Bun?: unknown }).Bun = originalBun;
      }
    }
  });

  it("normalizes chat ids with internal prefixes", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 1,
      chat: { id: "123" },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram("telegram:123", "hi", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
    });

    expect(sendMessage).toHaveBeenCalledWith("123", "hi", {
      parse_mode: "HTML",
    });
  });

  it("resolves t.me targets to numeric chat ids via getChat", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 1,
      chat: { id: "-100123" },
    });
    const getChat = vi.fn().mockResolvedValue({ id: -100123 });
    const api = { sendMessage, getChat } as unknown as {
      sendMessage: typeof sendMessage;
      getChat: typeof getChat;
    };

    await sendMessageTelegram("https://t.me/mychannel", "hi", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      gatewayClientScopes: ["operator.write"],
    });

    expect(getChat).toHaveBeenCalledWith("@mychannel");
    expect(sendMessage).toHaveBeenCalledWith("-100123", "hi", {
      parse_mode: "HTML",
    });
    expectPersistedTarget({
      rawTarget: "https://t.me/mychannel",
      resolvedChatId: "-100123",
      gatewayClientScopes: ["operator.write"],
    });
  });

  it("fails clearly when a legacy target cannot be resolved", async () => {
    const getChat = vi.fn().mockRejectedValue(new Error("400: Bad Request: chat not found"));
    const api = { getChat } as unknown as {
      getChat: typeof getChat;
    };

    await expect(
      sendMessageTelegram("@missingchannel", "hi", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
      }),
    ).rejects.toThrow(/could not be resolved to a numeric chat ID/i);
  });

  it("includes thread params in media messages", async () => {
    const chatId = "-1001234567890";
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 58,
      chat: { id: chatId },
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, "photo in topic", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
      messageThreadId: 99,
    });

    expectMediaSendCall(firstMockCall(sendPhoto, "send photo call"), "send photo call", chatId, {
      caption: "photo in topic",
      parse_mode: "HTML",
      message_thread_id: 99,
    });
  });

  it("splits long captions into media + text messages when text exceeds 1024 chars", async () => {
    const chatId = "123";
    const longText = "A".repeat(1100);

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 70,
      chat: { id: chatId },
    });
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 71,
      chat: { id: chatId },
    });
    const api = { sendPhoto, sendMessage } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const res = await sendMessageTelegram(chatId, longText, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
    });

    expectMediaSendCall(firstMockCall(sendPhoto, "send photo call"), "send photo call", chatId, {
      caption: undefined,
    });
    expect(sendMessage).toHaveBeenCalledWith(chatId, longText, {
      parse_mode: "HTML",
    });
    expect(res.messageId).toBe("71");
  });

  it("chunks long default markdown media follow-up text", async () => {
    const chatId = "123";
    const longText = `**${"A".repeat(5000)}**`;

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 72,
      chat: { id: chatId },
    });
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 73, chat: { id: chatId } })
      .mockResolvedValueOnce({ message_id: 74, chat: { id: chatId } });
    const api = { sendPhoto, sendMessage } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const res = await sendMessageTelegram(chatId, longText, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
    });

    expectMediaSendCall(firstMockCall(sendPhoto, "send photo call"), "send photo call", chatId, {
      caption: undefined,
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.every((call) => call[2]?.parse_mode === "HTML")).toBe(true);
    expect(sendMessage.mock.calls.every((call) => String(call[1] ?? "").length <= 4000)).toBe(true);
    expect(sendMessage.mock.calls.map((call) => String(call[1] ?? "")).join("")).toContain("<b>");
    expect(res.messageId).toBe("74");
  });

  it("uses caption when text is within 1024 char limit", async () => {
    const chatId = "123";
    const shortText = "B".repeat(1024);

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 72,
      chat: { id: chatId },
    });
    const sendMessage = vi.fn();
    const api = { sendPhoto, sendMessage } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const res = await sendMessageTelegram(chatId, shortText, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
    });

    expectMediaSendCall(firstMockCall(sendPhoto, "send photo call"), "send photo call", chatId, {
      caption: shortText,
      parse_mode: "HTML",
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(res.messageId).toBe("72");
  });

  it("renders markdown in media captions", async () => {
    const chatId = "123";
    const caption = "hi **boss**";

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 90,
      chat: { id: chatId },
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, caption, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
    });

    expectMediaSendCall(firstMockCall(sendPhoto, "send photo call"), "send photo call", chatId, {
      caption: "hi <b>boss</b>",
      parse_mode: "HTML",
    });
  });

  it("sends video notes when requested and regular videos otherwise", async () => {
    const chatId = "123";

    {
      const text = "ignored caption context";
      const sendVideoNote = vi.fn().mockResolvedValue({
        message_id: 101,
        chat: { id: chatId },
      });
      const sendMessage = vi.fn().mockResolvedValue({
        message_id: 102,
        chat: { id: chatId },
      });
      const api = { sendVideoNote, sendMessage } as unknown as {
        sendVideoNote: typeof sendVideoNote;
        sendMessage: typeof sendMessage;
      };

      mockLoadedMedia({
        buffer: Buffer.from("fake-video"),
        contentType: "video/mp4",
        fileName: "video.mp4",
      });

      const res = await sendMessageTelegram(chatId, text, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        mediaUrl: "https://example.com/video.mp4",
        asVideoNote: true,
      });

      expectMediaSendCall(
        firstMockCall(sendVideoNote, "send video note call"),
        "send video note call",
        chatId,
        {},
      );
      expect(sendMessage).toHaveBeenCalledWith(chatId, text, {
        parse_mode: "HTML",
      });
      expect(res.messageId).toBe("102");
    }

    {
      const text = "my caption";
      const sendVideo = vi.fn().mockResolvedValue({
        message_id: 201,
        chat: { id: chatId },
      });
      const api = { sendVideo } as unknown as {
        sendVideo: typeof sendVideo;
      };

      mockLoadedMedia({
        buffer: Buffer.from("fake-video"),
        contentType: "video/mp4",
        fileName: "video.mp4",
      });

      const res = await sendMessageTelegram(chatId, text, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        mediaUrl: "https://example.com/video.mp4",
        asVideoNote: false,
      });

      const [actualChatId, media, videoParams] = firstMockCall(sendVideo, "send video call");
      expect(actualChatId).toBe(chatId);
      if (media === undefined) {
        throw new Error("expected send video media");
      }
      const params = requireRecord(videoParams, "send video params");
      expect(typeof params.caption).toBe("string");
      expect(params.parse_mode).toBe("HTML");
      expect(Object.keys(params).toSorted()).toEqual(["caption", "parse_mode"]);
      expect(res.messageId).toBe("201");
    }
  });

  it("passes probed dimensions to regular video sends", async () => {
    const chatId = "123";
    const videoBuffer = Buffer.from("fake-video");
    const sendVideo = vi.fn().mockResolvedValue({
      message_id: 201,
      chat: { id: chatId },
    });
    const api = { sendVideo } as unknown as {
      sendVideo: typeof sendVideo;
    };
    probeVideoDimensions.mockResolvedValueOnce({ width: 720, height: 1280 });

    mockLoadedMedia({
      buffer: videoBuffer,
      contentType: "video/mp4",
      fileName: "video.mp4",
    });

    await sendMessageTelegram(chatId, "my caption", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/video.mp4",
    });

    expect(probeVideoDimensions).toHaveBeenCalledWith(videoBuffer);
    expectMediaSendCall(firstMockCall(sendVideo, "send video call"), "send video call", chatId, {
      caption: "my caption",
      parse_mode: "HTML",
      width: 720,
      height: 1280,
    });
  });

  it("does not probe video dimensions for video notes", async () => {
    const chatId = "123";
    const sendVideoNote = vi.fn().mockResolvedValue({
      message_id: 101,
      chat: { id: chatId },
    });
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 102,
      chat: { id: chatId },
    });
    const api = { sendVideoNote, sendMessage } as unknown as {
      sendVideoNote: typeof sendVideoNote;
      sendMessage: typeof sendMessage;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-video"),
      contentType: "video/mp4",
      fileName: "video.mp4",
    });

    await sendMessageTelegram(chatId, "ignored caption context", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/video.mp4",
      asVideoNote: true,
    });

    expect(probeVideoDimensions).not.toHaveBeenCalled();
    expectMediaSendCall(
      firstMockCall(sendVideoNote, "send video note call"),
      "send video note call",
      chatId,
      {},
    );
  });

  it("applies reply markup and thread options to split video-note sends", async () => {
    const chatId = "123";
    const cases: Array<{
      text: string;
      options: Partial<NonNullable<Parameters<typeof sendMessageTelegram>[2]>>;
      expectedVideoNote: Record<string, unknown>;
      expectedMessage: Record<string, unknown>;
    }> = [
      {
        text: "Check this out",
        options: {
          buttons: [[{ text: "Btn", callback_data: "dat" }]],
        },
        expectedVideoNote: {},
        expectedMessage: {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [[{ text: "Btn", callback_data: "dat" }]],
          },
        },
      },
      {
        text: "Threaded reply",
        options: {
          replyToMessageId: 999,
        },
        expectedVideoNote: { reply_to_message_id: 999, allow_sending_without_reply: true },
        expectedMessage: {
          parse_mode: "HTML",
          reply_to_message_id: 999,
          allow_sending_without_reply: true,
        },
      },
    ];

    for (const testCase of cases) {
      const sendVideoNote = vi.fn().mockResolvedValue({
        message_id: 301,
        chat: { id: chatId },
      });
      const sendMessage = vi.fn().mockResolvedValue({
        message_id: 302,
        chat: { id: chatId },
      });
      const api = { sendVideoNote, sendMessage } as unknown as {
        sendVideoNote: typeof sendVideoNote;
        sendMessage: typeof sendMessage;
      };

      mockLoadedMedia({
        buffer: Buffer.from("fake-video"),
        contentType: "video/mp4",
        fileName: "video.mp4",
      });

      const sendOptions: NonNullable<Parameters<typeof sendMessageTelegram>[2]> = {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        mediaUrl: "https://example.com/video.mp4",
        asVideoNote: true,
      };
      if (
        "replyToMessageId" in testCase.options &&
        testCase.options.replyToMessageId !== undefined
      ) {
        sendOptions.replyToMessageId = testCase.options.replyToMessageId;
      }
      if ("buttons" in testCase.options && testCase.options.buttons) {
        sendOptions.buttons = testCase.options.buttons;
      }
      await sendMessageTelegram(chatId, testCase.text, sendOptions);

      expectMediaSendCall(
        firstMockCall(sendVideoNote, "send video note call"),
        "send video note call",
        chatId,
        testCase.expectedVideoNote,
      );
      expect(sendMessage).toHaveBeenCalledWith(chatId, testCase.text, testCase.expectedMessage);
    }
  });

  it("retries pre-connect send errors and honors retry_after when present", async () => {
    vi.useFakeTimers();
    const chatId = "123";
    const err = Object.assign(new Error("getaddrinfo ENOTFOUND api.telegram.org"), {
      code: "ENOTFOUND",
      parameters: { retry_after: 0.5 },
    });
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        message_id: 1,
        chat: { id: chatId },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const promise = sendMessageTelegram(chatId, "hi", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 1000, jitter: 0 },
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ messageId: "1", chatId });
    expect(firstMockCall(setTimeoutSpy, "setTimeout call")[1]).toBe(500);
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });

  it("retries wrapped pre-connect HttpError sends", async () => {
    vi.useFakeTimers();
    const chatId = "123";
    const root = Object.assign(new Error("connect ECONNREFUSED api.telegram.org"), {
      code: "ECONNREFUSED",
    });
    const fetchError = Object.assign(new TypeError("fetch failed"), { cause: root });
    const err = Object.assign(new Error("Network request for 'sendMessage' failed!"), {
      name: "HttpError",
      error: fetchError,
    });
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        message_id: 1,
        chat: { id: chatId },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    const promise = sendMessageTelegram(chatId, "hi", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 1000, jitter: 0 },
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ messageId: "1", chatId });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not retry on non-transient errors", async () => {
    const chatId = "123";
    const sendMessage = vi.fn().mockRejectedValue(new Error("400: Bad Request"));
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram(chatId, "hi", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toThrow(/Bad Request/);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not retry generic grammY failed-after envelopes for non-idempotent sends", async () => {
    const chatId = "123";
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Network request for 'sendMessage' failed after 1 attempts."),
      );
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram(chatId, "hi", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toThrow(/failed after 1 attempts/i);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("sends GIF media as animation", async () => {
    const chatId = "123";
    const sendAnimation = vi.fn().mockResolvedValue({
      message_id: 9,
      chat: { id: chatId },
    });
    const api = { sendAnimation } as unknown as {
      sendAnimation: typeof sendAnimation;
    };

    mockLoadedMedia({
      buffer: Buffer.from("GIF89a"),
      fileName: "fun.gif",
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/fun",
    });

    expect(sendAnimation).toHaveBeenCalledTimes(1);
    expectMediaSendCall(
      firstMockCall(sendAnimation, "send animation call"),
      "send animation call",
      chatId,
      {
        caption: "caption",
        parse_mode: "HTML",
      },
    );
    expect(probeVideoDimensions).not.toHaveBeenCalled();
    expect(res.messageId).toBe("9");
  });

  it.each([
    {
      name: "images",
      buffer: Buffer.from("fake-image"),
      contentType: "image/png",
      fileName: "photo.png",
      mediaUrl: "https://example.com/photo.png",
    },
    {
      name: "GIFs",
      buffer: Buffer.from("GIF89a"),
      contentType: "image/gif",
      fileName: "fun.gif",
      mediaUrl: "https://example.com/fun.gif",
    },
    {
      name: "videos",
      buffer: Buffer.from("fake-video"),
      contentType: "video/mp4",
      fileName: "clip.mp4",
      mediaUrl: "https://example.com/clip.mp4",
    },
  ])("sends $name as documents when forceDocument is true", async (testCase) => {
    const chatId = "123";
    const sendAnimation = vi.fn();
    const sendDocument = vi.fn().mockResolvedValue({
      message_id: 10,
      chat: { id: chatId },
    });
    const sendPhoto = vi.fn();
    const sendVideo = vi.fn();
    const api = { sendAnimation, sendDocument, sendPhoto, sendVideo } as unknown as {
      sendAnimation: typeof sendAnimation;
      sendDocument: typeof sendDocument;
      sendPhoto: typeof sendPhoto;
      sendVideo: typeof sendVideo;
    };

    mockLoadedMedia({
      buffer: testCase.buffer,
      contentType: testCase.contentType,
      fileName: testCase.fileName,
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: testCase.mediaUrl,
      forceDocument: true,
    });

    expectMediaSendCall(
      firstMockCall(sendDocument, "send document call"),
      `send document call ${testCase.name}`,
      chatId,
      {
        caption: "caption",
        parse_mode: "HTML",
        disable_content_type_detection: true,
      },
    );
    expect(sendPhoto, testCase.name).not.toHaveBeenCalled();
    expect(sendAnimation, testCase.name).not.toHaveBeenCalled();
    expect(sendVideo, testCase.name).not.toHaveBeenCalled();
    expect(probeVideoDimensions, testCase.name).not.toHaveBeenCalled();
    expect(res.messageId).toBe("10");
  });

  it.each([
    { name: "oversized dimensions", width: 6000, height: 5001 },
    { name: "oversized aspect ratio", width: 4000, height: 100 },
  ])("sends images as documents when Telegram rejects $name", async ({ width, height }) => {
    const chatId = "123";
    const sendDocument = vi.fn().mockResolvedValue({
      message_id: 10,
      chat: { id: chatId },
    });
    const sendPhoto = vi.fn();
    const api = { sendDocument, sendPhoto } as unknown as {
      sendDocument: typeof sendDocument;
      sendPhoto: typeof sendPhoto;
    };

    imageMetadata.width = width;
    imageMetadata.height = height;
    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/png",
      fileName: "photo.png",
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.png",
    });

    expectMediaSendCall(
      firstMockCall(sendDocument, "send document call"),
      "send document call",
      chatId,
      {
        caption: "caption",
        parse_mode: "HTML",
      },
    );
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(res.messageId).toBe("10");
  });

  it("sends images as documents when metadata dimensions are unavailable", async () => {
    const chatId = "123";
    const sendDocument = vi.fn().mockResolvedValue({
      message_id: 10,
      chat: { id: chatId },
    });
    const sendPhoto = vi.fn();
    const api = { sendDocument, sendPhoto } as unknown as {
      sendDocument: typeof sendDocument;
      sendPhoto: typeof sendPhoto;
    };

    imageMetadata.width = undefined;
    imageMetadata.height = undefined;
    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/png",
      fileName: "photo.png",
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.png",
    });

    expectMediaSendCall(
      firstMockCall(sendDocument, "send document call"),
      "send document call",
      chatId,
      {
        caption: "caption",
        parse_mode: "HTML",
      },
    );
    expect(sendPhoto).not.toHaveBeenCalled();
    expect(res.messageId).toBe("10");
  });

  it("keeps regular document sends on the default Telegram params", async () => {
    const chatId = "123";
    const sendDocument = vi.fn().mockResolvedValue({
      message_id: 11,
      chat: { id: chatId },
    });
    const api = { sendDocument } as unknown as {
      sendDocument: typeof sendDocument;
    };

    mockLoadedMedia({
      buffer: Buffer.from("%PDF-1.7"),
      contentType: "application/pdf",
      fileName: "report.pdf",
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/report.pdf",
    });

    expectMediaSendCall(
      firstMockCall(sendDocument, "send document call"),
      "send document call",
      chatId,
      {
        caption: "caption",
        parse_mode: "HTML",
      },
    );
    expect(res.messageId).toBe("11");
  });

  it("routes audio media to sendAudio/sendVoice based on voice compatibility", async () => {
    const cases: Array<{
      name: string;
      chatId: string;
      text: string;
      mediaUrl: string;
      contentType: string;
      fileName: string;
      asVoice?: boolean;
      messageThreadId?: number;
      replyToMessageId?: number;
      expectedMethod: "sendAudio" | "sendVoice";
      expectedOptions: Record<string, unknown>;
    }> = [
      {
        name: "default audio send",
        chatId: "123",
        text: "caption",
        mediaUrl: "https://example.com/clip.mp3",
        contentType: "audio/mpeg",
        fileName: "clip.mp3",
        expectedMethod: "sendAudio" as const,
        expectedOptions: { caption: "caption", parse_mode: "HTML" },
      },
      {
        name: "voice-compatible media with thread params",
        chatId: "-1001234567890",
        text: "voice note",
        mediaUrl: "https://example.com/note.ogg",
        contentType: "audio/ogg",
        fileName: "note.ogg",
        asVoice: true,
        messageThreadId: 271,
        replyToMessageId: 500,
        expectedMethod: "sendVoice" as const,
        expectedOptions: {
          caption: "voice note",
          parse_mode: "HTML",
          message_thread_id: 271,
          reply_to_message_id: 500,
          allow_sending_without_reply: true,
        },
      },
      {
        name: "asVoice fallback for non-voice media",
        chatId: "123",
        text: "caption",
        mediaUrl: "https://example.com/clip.wav",
        contentType: "audio/wav",
        fileName: "clip.wav",
        asVoice: true,
        expectedMethod: "sendAudio" as const,
        expectedOptions: { caption: "caption", parse_mode: "HTML" },
      },
      {
        name: "asVoice accepts mp3",
        chatId: "123",
        text: "caption",
        mediaUrl: "https://example.com/clip.mp3",
        contentType: "audio/mpeg",
        fileName: "clip.mp3",
        asVoice: true,
        expectedMethod: "sendVoice" as const,
        expectedOptions: { caption: "caption", parse_mode: "HTML" },
      },
      {
        name: "normalizes parameterized audio MIME with mixed casing",
        chatId: "123",
        text: "caption",
        mediaUrl: "https://example.com/note",
        contentType: " Audio/Ogg; codecs=opus ",
        fileName: "note.ogg",
        expectedMethod: "sendAudio" as const,
        expectedOptions: { caption: "caption", parse_mode: "HTML" },
      },
    ];

    for (const testCase of cases) {
      const sendAudio = vi.fn().mockResolvedValue({
        message_id: 10,
        chat: { id: testCase.chatId },
      });
      const sendVoice = vi.fn().mockResolvedValue({
        message_id: 11,
        chat: { id: testCase.chatId },
      });
      const api = { sendAudio, sendVoice } as unknown as {
        sendAudio: typeof sendAudio;
        sendVoice: typeof sendVoice;
      };

      mockLoadedMedia({
        buffer: Buffer.from("audio"),
        contentType: testCase.contentType,
        fileName: testCase.fileName,
      });

      await sendMessageTelegram(testCase.chatId, testCase.text, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        mediaUrl: testCase.mediaUrl,
        ...("asVoice" in testCase && testCase.asVoice ? { asVoice: true } : {}),
        ...("messageThreadId" in testCase && testCase.messageThreadId !== undefined
          ? { messageThreadId: testCase.messageThreadId }
          : {}),
        ...("replyToMessageId" in testCase && testCase.replyToMessageId !== undefined
          ? { replyToMessageId: testCase.replyToMessageId }
          : {}),
      });

      const called = testCase.expectedMethod === "sendVoice" ? sendVoice : sendAudio;
      const notCalled = testCase.expectedMethod === "sendVoice" ? sendAudio : sendVoice;
      expectMediaSendCall(
        firstMockCall(called, "called mock call"),
        `${testCase.expectedMethod} call ${testCase.name}`,
        testCase.chatId,
        testCase.expectedOptions,
      );
      expect(notCalled, testCase.name).not.toHaveBeenCalled();
    }
  });

  it("keeps message_thread_id for forum/private/group sends", async () => {
    const cases = [
      {
        name: "forum topic",
        chatId: "-1001234567890",
        text: "hello forum",
        messageId: 55,
      },
      {
        name: "private chat topic (#18974)",
        chatId: "123456789",
        text: "hello private",
        messageId: 56,
      },
      {
        // Group/supergroup chats have negative IDs.
        name: "group chat (#17242)",
        chatId: "-1001234567890",
        text: "hello group",
        messageId: 57,
      },
    ] as const;

    for (const testCase of cases) {
      const sendMessage = vi.fn().mockResolvedValue({
        message_id: testCase.messageId,
        chat: { id: testCase.chatId },
      });
      const api = { sendMessage } as unknown as {
        sendMessage: typeof sendMessage;
      };

      await sendMessageTelegram(testCase.chatId, testCase.text, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        messageThreadId: 271,
      });

      expect(sendMessage, testCase.name).toHaveBeenCalledWith(testCase.chatId, testCase.text, {
        parse_mode: "HTML",
        message_thread_id: 271,
      });
    }
  });

  it("retries sends without message_thread_id on thread-not-found", async () => {
    const cases = [
      { name: "forum", chatId: "-100123", text: "hello forum", messageId: 58 },
    ] as const;
    const threadErr = new Error("400: Bad Request: message thread not found");

    for (const testCase of cases) {
      const sendMessage = vi
        .fn()
        .mockRejectedValueOnce(threadErr)
        .mockResolvedValueOnce({
          message_id: testCase.messageId,
          chat: { id: testCase.chatId },
        });
      const api = { sendMessage } as unknown as {
        sendMessage: typeof sendMessage;
      };

      const res = await sendMessageTelegram(testCase.chatId, testCase.text, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        messageThreadId: 271,
      });

      expect(sendMessage, testCase.name).toHaveBeenNthCalledWith(
        1,
        testCase.chatId,
        testCase.text,
        {
          parse_mode: "HTML",
          message_thread_id: 271,
        },
      );
      expect(sendMessage, testCase.name).toHaveBeenNthCalledWith(
        2,
        testCase.chatId,
        testCase.text,
        {
          parse_mode: "HTML",
        },
      );
      expect(res.messageId, testCase.name).toBe(String(testCase.messageId));
    }
  });

  it("does not retry private DM topic sends without the topic id", async () => {
    const threadErr = new Error("400: Bad Request: message thread not found");
    const sendMessage = vi.fn().mockRejectedValueOnce(threadErr);
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(
      sendMessageTelegram("123456789", "hello private", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        messageThreadId: 271,
      }),
    ).rejects.toThrow("message thread not found");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("123456789", "hello private", {
      parse_mode: "HTML",
      message_thread_id: 271,
    });
  });

  it("does not retry on non-retriable thread/chat errors", async () => {
    const cases: Array<{
      chatId: string;
      text: string;
      error: Error;
      opts?: { messageThreadId?: number };
      expectedError: RegExp | string;
      expectedCallArgs: [string, string, { parse_mode: "HTML"; message_thread_id?: number }];
    }> = [
      {
        chatId: "123",
        text: "hello forum",
        error: new Error("400: Bad Request: message thread not found"),
        expectedError: "message thread not found",
        expectedCallArgs: ["123", "hello forum", { parse_mode: "HTML" }],
      },
      {
        chatId: "123456789",
        text: "hello private",
        error: new Error("400: Bad Request: chat not found"),
        opts: { messageThreadId: 271 },
        expectedError: /chat not found/i,
        expectedCallArgs: [
          "123456789",
          "hello private",
          { parse_mode: "HTML", message_thread_id: 271 },
        ],
      },
    ];

    for (const testCase of cases) {
      const sendMessage = vi.fn().mockRejectedValueOnce(testCase.error);
      const api = { sendMessage } as unknown as {
        sendMessage: typeof sendMessage;
      };

      await expect(
        sendMessageTelegram(testCase.chatId, testCase.text, {
          cfg: TELEGRAM_TEST_CFG,
          token: "tok",
          api,
          ...testCase.opts,
        }),
      ).rejects.toThrow(testCase.expectedError);

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(...testCase.expectedCallArgs);
    }
  });

  it("sets disable_notification when silent is true", async () => {
    const chatId = "123";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 1,
      chat: { id: chatId },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(chatId, "hi", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      silent: true,
    });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "hi", {
      parse_mode: "HTML",
      disable_notification: true,
    });
  });

  it("keeps disable_notification on plain-text fallback when silent is true", async () => {
    const chatId = "123";
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 9",
    );
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce({ message_id: 2, chat: { id: chatId } });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(chatId, "_oops_", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      silent: true,
    });

    expect(sendMessage.mock.calls).toEqual([
      [chatId, "<i>oops</i>", { parse_mode: "HTML", disable_notification: true }],
      [chatId, "_oops_", { disable_notification: true }],
    ]);
  });

  it("parses message_thread_id from recipient string (telegram:group:...:topic:...)", async () => {
    const chatId = "-1001234567890";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 55,
      chat: { id: chatId },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(`telegram:group:${chatId}:topic:271`, "hello forum", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
    });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "hello forum", {
      parse_mode: "HTML",
      message_thread_id: 271,
    });
  });

  it("retries media sends without message_thread_id when thread is missing", async () => {
    const chatId = "-100123";
    const threadErr = new Error("400: Bad Request: message thread not found");
    const sendPhoto = vi
      .fn()
      .mockRejectedValueOnce(threadErr)
      .mockResolvedValueOnce({
        message_id: 59,
        chat: { id: chatId },
      });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const res = await sendMessageTelegram(chatId, "photo", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
      messageThreadId: 271,
    });

    expectMediaSendCall(
      firstMockCall(sendPhoto, "first send photo call"),
      "first send photo call",
      chatId,
      {
        caption: "photo",
        parse_mode: "HTML",
        message_thread_id: 271,
      },
    );
    expectMediaSendCall(
      mockCall(sendPhoto, 1, "second send photo call"),
      "second send photo call",
      chatId,
      {
        caption: "photo",
        parse_mode: "HTML",
      },
    );
    expect(res.messageId).toBe("59");
  });

  it("defaults outbound media uploads to 100MB", async () => {
    const chatId = "123";
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 60,
      chat: { id: chatId },
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, "photo", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
    });

    const [mediaUrl, options] = requireMockCall(
      firstMockCall(loadWebMedia, "loadWebMedia call"),
      "load web media call",
    );
    expect(mediaUrl).toBe("https://example.com/photo.jpg");
    expect(requireRecord(options, "load web media options").maxBytes).toBe(100 * 1024 * 1024);
  });

  it("uses configured telegram mediaMaxMb for outbound uploads", async () => {
    const chatId = "123";
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 61,
      chat: { id: chatId },
    });
    const api = { sendPhoto } as unknown as {
      sendPhoto: typeof sendPhoto;
    };
    const cfg = {
      channels: {
        telegram: {
          mediaMaxMb: 42,
        },
      },
    };
    loadConfig.mockReturnValue(cfg);

    mockLoadedMedia({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, "photo", {
      cfg,
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
    });

    const [mediaUrl, options] = requireMockCall(
      firstMockCall(loadWebMedia, "loadWebMedia call"),
      "load web media call",
    );
    expect(mediaUrl).toBe("https://example.com/photo.jpg");
    expect(requireRecord(options, "load web media options").maxBytes).toBe(42 * 1024 * 1024);
  });

  it("chunks long html-mode text and keeps buttons on the last chunk only", async () => {
    const chatId = "123";
    const htmlText = `<b>${"A".repeat(5000)}</b>`;

    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 90, chat: { id: chatId } })
      .mockResolvedValueOnce({ message_id: 91, chat: { id: chatId } });
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    const res = await sendMessageTelegram(chatId, htmlText, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      textMode: "html",
      buttons: [[{ text: "OK", callback_data: "ok" }]],
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const firstCall = firstMockCall(sendMessage, "first sendMessage call");
    const secondCall = mockCall(sendMessage, 1, "second sendMessage call");
    const firstParams = requireRecord(firstCall[2], "first sendMessage params");
    const secondParams = requireRecord(secondCall[2], "second sendMessage params");
    expect((firstCall[1] as string).length).toBeLessThanOrEqual(4000);
    expect((secondCall[1] as string).length).toBeLessThanOrEqual(4000);
    expect(firstParams.reply_markup).toBeUndefined();
    expect(secondParams.reply_markup).toEqual({
      inline_keyboard: [[{ text: "OK", callback_data: "ok" }]],
    });
    expect(res.messageId).toBe("91");
  });

  it("chunks long default markdown text and keeps buttons on the last chunk only", async () => {
    const chatId = "123";
    const markdownText = `**${"A".repeat(5000)}**`;

    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 90, chat: { id: chatId } })
      .mockResolvedValueOnce({ message_id: 91, chat: { id: chatId } });
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    const res = await sendMessageTelegram(chatId, markdownText, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      buttons: [[{ text: "OK", callback_data: "ok" }]],
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    const firstCall = firstMockCall(sendMessage, "first sendMessage call");
    const secondCall = mockCall(sendMessage, 1, "second sendMessage call");
    const firstParams = requireRecord(firstCall[2], "first sendMessage params");
    const secondParams = requireRecord(secondCall[2], "second sendMessage params");
    const firstText = requireString(firstCall[1], "first sendMessage text");
    const secondText = requireString(secondCall[1], "second sendMessage text");
    expect(firstText.length).toBeLessThanOrEqual(4000);
    expect(secondText.length).toBeLessThanOrEqual(4000);
    expect(firstParams.parse_mode).toBe("HTML");
    expect(secondParams.parse_mode).toBe("HTML");
    expect(firstText).toMatch(/^<b>[\s\S]*<\/b>$/);
    expect(secondText).toMatch(/^<b>[\s\S]*<\/b>$/);
    expect(firstParams.reply_markup).toBeUndefined();
    expect(secondParams.reply_markup).toEqual({
      inline_keyboard: [[{ text: "OK", callback_data: "ok" }]],
    });
    expect(res.messageId).toBe("91");
  });

  it("preserves caller plain-text fallback across chunked html parse retries", async () => {
    const chatId = "123";
    const htmlText = `<b>${"A".repeat(5000)}</b>`;
    const plainText = `${"P".repeat(2500)}${"Q".repeat(2500)}`;
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 9",
    );
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce({ message_id: 90, chat: { id: chatId } })
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce({ message_id: 91, chat: { id: chatId } });
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    const res = await sendMessageTelegram(chatId, htmlText, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      textMode: "html",
      plainText,
    });

    expect(sendMessage).toHaveBeenCalledTimes(4);
    const plainFallbackCalls = [
      mockCall(sendMessage, 1, "first plain fallback sendMessage call"),
      mockCall(sendMessage, 3, "second plain fallback sendMessage call"),
    ];
    const plainFallbackText = plainFallbackCalls
      .map((call) => mockCallText(call, "plain fallback text"))
      .join("");
    expect(plainFallbackText).toBe(plainText);
    expect(plainFallbackText).not.toContain("<");
    expect(res.messageId).toBe("91");
  });

  it("keeps malformed leading ampersands on the chunked plain-text fallback path", async () => {
    const chatId = "123";
    const htmlText = `&${"A".repeat(5000)}`;
    const plainText = "fallback!!";
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 0",
    );
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce({ message_id: 92, chat: { id: chatId } })
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce({ message_id: 93, chat: { id: chatId } });
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    const res = await sendMessageTelegram(chatId, htmlText, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      textMode: "html",
      plainText,
    });

    expect(sendMessage).toHaveBeenCalledTimes(4);
    expect(
      requireString(firstMockCall(sendMessage, "sendMessage call")[1], "sendMessage text"),
    ).toMatch(/^&/);
    const plainFallbackCalls = [
      mockCall(sendMessage, 1, "first plain fallback sendMessage call"),
      mockCall(sendMessage, 3, "second plain fallback sendMessage call"),
    ];
    const plainFallbackTexts = plainFallbackCalls.map((call) =>
      mockCallText(call, "plain fallback text"),
    );
    expect(plainFallbackTexts.join("")).toBe(plainText);
    expect(plainFallbackTexts.filter((text) => text === "")).toEqual([]);
    expect(res.messageId).toBe("93");
  });

  it("cuts over to plain text when fallback text needs more chunks than html", async () => {
    const chatId = "123";
    const htmlText = `<b>${"A".repeat(5000)}</b>`;
    const plainText = "P".repeat(9000);
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ message_id: 94, chat: { id: chatId } })
      .mockResolvedValueOnce({ message_id: 95, chat: { id: chatId } })
      .mockResolvedValueOnce({ message_id: 96, chat: { id: chatId } });
    const api = { sendMessage } as unknown as { sendMessage: typeof sendMessage };

    const res = await sendMessageTelegram(chatId, htmlText, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      textMode: "html",
      plainText,
    });

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls.map((call) => call[2]?.parse_mode)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(sendMessage.mock.calls.map((call) => String(call[1] ?? "")).join("")).toBe(plainText);
    expect(res.messageId).toBe("96");
  });
});

describe("reactMessageTelegram", () => {
  it.each([
    {
      testName: "sends emoji reactions",
      target: "telegram:123",
      messageId: "456",
      emoji: "✅",
      remove: false,
      expected: [{ type: "emoji", emoji: "✅" }],
    },
    {
      testName: "removes reactions when emoji is empty",
      target: "123",
      messageId: 456,
      emoji: "",
      remove: false,
      expected: [],
    },
    {
      testName: "removes reactions when remove flag is set",
      target: "123",
      messageId: 456,
      emoji: "✅",
      remove: true,
      expected: [],
    },
  ] as const)("$testName", async (testCase) => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const api = { setMessageReaction } as unknown as {
      setMessageReaction: typeof setMessageReaction;
    };

    await reactMessageTelegram(testCase.target, testCase.messageId, testCase.emoji, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      ...(testCase.remove ? { remove: true } : {}),
    });

    expect(setMessageReaction).toHaveBeenCalledWith("123", 456, testCase.expected);
  });

  it("resolves legacy telegram targets before reacting", async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const getChat = vi.fn().mockResolvedValue({ id: -100123 });
    const api = { setMessageReaction, getChat } as unknown as {
      setMessageReaction: typeof setMessageReaction;
      getChat: typeof getChat;
    };

    await reactMessageTelegram("@mychannel", 456, "✅", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
    });

    expect(getChat).toHaveBeenCalledWith("@mychannel");
    expect(setMessageReaction).toHaveBeenCalledWith("-100123", 456, [
      { type: "emoji", emoji: "✅" },
    ]);
    expectPersistedTarget({
      rawTarget: "@mychannel",
      resolvedChatId: "-100123",
    });
  });
});

describe("deleteMessageTelegram", () => {
  it.each([
    "400: Bad Request: message to delete not found",
    "400: Bad Request: message can't be deleted",
    "MESSAGE_ID_INVALID",
    "MESSAGE_DELETE_FORBIDDEN",
  ] as const)("returns a warning for benign delete no-op error: %s", async (message) => {
    const deleteMessage = vi.fn().mockRejectedValue(new Error(message));
    const api = { deleteMessage } as unknown as { deleteMessage: typeof deleteMessage };

    const result = await deleteMessageTelegram("123", 456, {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
    });

    expect(deleteMessage).toHaveBeenCalledWith("123", 456);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected delete warning result");
    }
    expect(result.warning).toContain(message);
  });

  it("throws non-benign delete errors", async () => {
    const deleteMessage = vi.fn().mockRejectedValue(new Error("500: Internal Server Error"));
    const api = { deleteMessage } as unknown as { deleteMessage: typeof deleteMessage };

    await expect(
      deleteMessageTelegram("123", 456, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
      }),
    ).rejects.toThrow(/Internal Server Error/);
  });
});

describe("sendStickerTelegram", () => {
  const positiveSendCases = [
    {
      name: "sends a sticker by file_id",
      fileId: "CAACAgIAAxkBAAI...sticker_file_id",
      expectedFileId: "CAACAgIAAxkBAAI...sticker_file_id",
      expectedMessageId: 100,
    },
    {
      name: "trims whitespace from fileId",
      fileId: "  fileId123  ",
      expectedFileId: "fileId123",
      expectedMessageId: 106,
    },
  ] as const;

  for (const testCase of positiveSendCases) {
    it(testCase.name, async () => {
      const chatId = "123";
      const sendSticker = vi.fn().mockResolvedValue({
        message_id: testCase.expectedMessageId,
        chat: { id: chatId },
      });
      const api = { sendSticker } as unknown as {
        sendSticker: typeof sendSticker;
      };

      const res = await sendStickerTelegram(chatId, testCase.fileId, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
      });

      expect(sendSticker).toHaveBeenCalledWith(chatId, testCase.expectedFileId, undefined);
      expect(res.messageId).toBe(String(testCase.expectedMessageId));
      expect(res.chatId).toBe(chatId);
    });
  }

  it("throws error when fileId is blank", async () => {
    for (const fileId of ["", "   "]) {
      await expect(
        sendStickerTelegram("123", fileId, { cfg: TELEGRAM_TEST_CFG, token: "tok" }),
      ).rejects.toThrow(/file_id is required/i);
    }
  });

  it("retries sticker sends without message_thread_id when thread is missing", async () => {
    const chatId = "-100123";
    const threadErr = new Error("400: Bad Request: message thread not found");
    const sendSticker = vi
      .fn()
      .mockRejectedValueOnce(threadErr)
      .mockResolvedValueOnce({
        message_id: 109,
        chat: { id: chatId },
      });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    const res = await sendStickerTelegram(chatId, "fileId123", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      messageThreadId: 271,
    });

    expect(sendSticker).toHaveBeenNthCalledWith(1, chatId, "fileId123", {
      message_thread_id: 271,
    });
    expect(sendSticker).toHaveBeenNthCalledWith(2, chatId, "fileId123", undefined);
    expect(res.messageId).toBe("109");
  });

  it("fails when sticker send returns no message_id", async () => {
    const chatId = "123";
    const sendSticker = vi.fn().mockResolvedValue({
      chat: { id: chatId },
    });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await expect(
      sendStickerTelegram(chatId, "fileId123", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
      }),
    ).rejects.toThrow(/returned no message_id/i);
  });

  it("does not retry generic grammY failed envelopes for sticker sends", async () => {
    const chatId = "123";
    const sendSticker = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network request for 'sendSticker' failed!"));
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await expect(
      sendStickerTelegram(chatId, "fileId123", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toThrow(/Network request for 'sendSticker' failed!/i);
    expect(sendSticker).toHaveBeenCalledTimes(1);
  });

  it("retries rate-limited sticker sends and honors retry_after", async () => {
    vi.useFakeTimers();
    const chatId = "123";
    const sendSticker = vi
      .fn()
      .mockRejectedValueOnce({
        message: "429 Too Many Requests",
        response: { parameters: { retry_after: 1 } },
      })
      .mockResolvedValueOnce({
        message_id: 109,
        chat: { id: chatId },
      });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const promise = sendStickerTelegram(chatId, "fileId123", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 1000, jitter: 0 },
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ messageId: "109", chatId });
    expect(firstMockCall(setTimeoutSpy, "setTimeout call")[1]).toBe(1000);
    expect(sendSticker).toHaveBeenCalledTimes(2);
    setTimeoutSpy.mockRestore();
    vi.useRealTimers();
  });
});

describe("shared send behaviors", () => {
  it("includes reply_to_message_id for threaded replies", async () => {
    const cases = [
      {
        name: "message send",
        run: async () => {
          const chatId = "123";
          const sendMessage = vi.fn().mockResolvedValue({
            message_id: 56,
            chat: { id: chatId },
          });
          const api = { sendMessage } as unknown as {
            sendMessage: typeof sendMessage;
          };
          await sendMessageTelegram(chatId, "reply text", {
            cfg: TELEGRAM_TEST_CFG,
            token: "tok",
            api,
            replyToMessageId: 100,
          });
          expect(sendMessage).toHaveBeenCalledWith(chatId, "reply text", {
            parse_mode: "HTML",
            reply_to_message_id: 100,
            allow_sending_without_reply: true,
          });
        },
      },
      {
        name: "sticker send",
        run: async () => {
          const chatId = "123";
          const fileId = "CAACAgIAAxkBAAI...sticker_file_id";
          const sendSticker = vi.fn().mockResolvedValue({
            message_id: 102,
            chat: { id: chatId },
          });
          const api = { sendSticker } as unknown as {
            sendSticker: typeof sendSticker;
          };
          await sendStickerTelegram(chatId, fileId, {
            cfg: TELEGRAM_TEST_CFG,
            token: "tok",
            api,
            replyToMessageId: 500,
          });
          expect(sendSticker).toHaveBeenCalledWith(chatId, fileId, {
            reply_to_message_id: 500,
            allow_sending_without_reply: true,
          });
        },
      },
    ] as const;

    for (const testCase of cases) {
      await testCase.run();
    }
  });

  it("uses native reply parameters for direct quote sends without trimming the quote", async () => {
    const chatId = "123";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 56,
      chat: { id: chatId },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(chatId, "reply text", {
      cfg: TELEGRAM_TEST_CFG,
      token: "tok",
      api,
      replyToMessageId: 100,
      quoteText: " quoted text\n",
    });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "reply text", {
      parse_mode: "HTML",
      reply_parameters: {
        message_id: 100,
        quote: " quoted text\n",
        allow_sending_without_reply: true,
      },
    });
  });

  it("omits invalid reply_to_message_id values before calling Telegram", async () => {
    const invalidReplyToMessageIds = ["session-meta-id", "123abc", Number.NaN] as const;

    for (const invalidReplyToMessageId of invalidReplyToMessageIds) {
      const chatId = "123";
      const sendMessage = vi.fn().mockResolvedValue({
        message_id: 56,
        chat: { id: chatId },
      });
      const sendSticker = vi.fn().mockResolvedValue({
        message_id: 102,
        chat: { id: chatId },
      });
      const api = { sendMessage, sendSticker } as unknown as {
        sendMessage: typeof sendMessage;
        sendSticker: typeof sendSticker;
      };

      await sendMessageTelegram(chatId, "reply text", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        replyToMessageId: invalidReplyToMessageId as unknown as number,
      });
      await sendStickerTelegram(chatId, "CAACAgIAAxkBAAI...sticker_file_id", {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        replyToMessageId: invalidReplyToMessageId as unknown as number,
      });

      expect(sendMessage, String(invalidReplyToMessageId)).toHaveBeenCalledWith(
        chatId,
        "reply text",
        {
          parse_mode: "HTML",
        },
      );
      expect(sendSticker, String(invalidReplyToMessageId)).toHaveBeenCalledWith(
        chatId,
        "CAACAgIAAxkBAAI...sticker_file_id",
        undefined,
      );
    }
  });

  it("wraps chat-not-found with actionable context", async () => {
    const cases = [
      {
        name: "message send",
        run: async () => {
          const chatId = "123";
          const err = new Error("400: Bad Request: chat not found");
          const sendMessage = vi.fn().mockRejectedValue(err);
          const api = { sendMessage } as unknown as {
            sendMessage: typeof sendMessage;
          };
          await expectChatNotFoundWithChatId(
            sendMessageTelegram(chatId, "hi", { cfg: TELEGRAM_TEST_CFG, token: "tok", api }),
            chatId,
          );
        },
      },
      {
        name: "sticker send",
        run: async () => {
          const chatId = "123";
          const err = new Error("400: Bad Request: chat not found");
          const sendSticker = vi.fn().mockRejectedValue(err);
          const api = { sendSticker } as unknown as {
            sendSticker: typeof sendSticker;
          };
          await expectChatNotFoundWithChatId(
            sendStickerTelegram(chatId, "fileId123", { cfg: TELEGRAM_TEST_CFG, token: "tok", api }),
            chatId,
          );
        },
      },
    ] as const;

    for (const testCase of cases) {
      await testCase.run();
    }
  });

  it("wraps membership-related 403 errors with actionable context and original detail", async () => {
    const cases = [
      {
        name: "message send",
        errorText: "403: Forbidden: bot is not a member of the channel chat",
        run: async (chatId: string, err: Error) => {
          const sendMessage = vi.fn().mockRejectedValue(err);
          const api = { sendMessage } as unknown as {
            sendMessage: typeof sendMessage;
          };
          await expectTelegramMembershipErrorWithChatId(
            sendMessageTelegram(chatId, "hi", { cfg: TELEGRAM_TEST_CFG, token: "tok", api }),
            chatId,
            /bot is not a member of the channel chat/i,
          );
        },
      },
      {
        name: "sticker send",
        errorText: "403: Forbidden: bot was kicked from the group chat",
        run: async (chatId: string, err: Error) => {
          const sendSticker = vi.fn().mockRejectedValue(err);
          const api = { sendSticker } as unknown as {
            sendSticker: typeof sendSticker;
          };
          await expectTelegramMembershipErrorWithChatId(
            sendStickerTelegram(chatId, "fileId123", { cfg: TELEGRAM_TEST_CFG, token: "tok", api }),
            chatId,
            /bot was kicked from the group chat/i,
          );
        },
      },
    ] as const;

    for (const testCase of cases) {
      await testCase.run("123", new Error(testCase.errorText));
    }
  });
});

describe("editMessageTelegram", () => {
  it.each([
    {
      name: "buttons undefined keeps existing keyboard",
      text: "hi",
      buttons: undefined as Parameters<typeof buildInlineKeyboard>[0],
      expectedCalls: 1,
      firstExpectNoReplyMarkup: true,
      parseFallback: false,
    },
    {
      name: "buttons empty clears keyboard",
      text: "hi",
      buttons: [] as Parameters<typeof buildInlineKeyboard>[0],
      expectedCalls: 1,
      firstExpectReplyMarkup: { inline_keyboard: [] } as Record<string, unknown>,
      parseFallback: false,
    },
    {
      name: "parse error fallback preserves cleared keyboard",
      text: "<bad> html",
      buttons: [] as Parameters<typeof buildInlineKeyboard>[0],
      expectedCalls: 2,
      firstExpectReplyMarkup: { inline_keyboard: [] } as Record<string, unknown>,
      secondExpectReplyMarkup: { inline_keyboard: [] } as Record<string, unknown>,
      parseFallback: true,
    },
  ])("$name", async (testCase) => {
    if (testCase.parseFallback) {
      botApi.editMessageText
        .mockRejectedValueOnce(new Error("400: Bad Request: can't parse entities"))
        .mockResolvedValueOnce({ message_id: 1, chat: { id: "123" } });
    } else {
      botApi.editMessageText.mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    }

    await editMessageTelegram("123", 1, testCase.text, {
      token: "tok",
      cfg: {},
      buttons: testCase.buttons ? testCase.buttons.map((row) => [...row]) : testCase.buttons,
    });

    expect(botCtorSpy, testCase.name).toHaveBeenCalledTimes(1);
    expect(firstMockCall(botCtorSpy, "bot constructor call")[0], testCase.name).toBe("tok");
    expect(botApi.editMessageText, testCase.name).toHaveBeenCalledTimes(testCase.expectedCalls);

    const firstParams = requireRecord(
      firstMockCall(botApi.editMessageText, "editMessageText call")[3],
      "first edit params",
    );
    expect(firstParams.parse_mode, testCase.name).toBe("HTML");
    if ("firstExpectNoReplyMarkup" in testCase && testCase.firstExpectNoReplyMarkup) {
      expect(firstParams, testCase.name).not.toHaveProperty("reply_markup");
    }
    if ("firstExpectReplyMarkup" in testCase && testCase.firstExpectReplyMarkup) {
      expect(firstParams.reply_markup, testCase.name).toEqual(testCase.firstExpectReplyMarkup);
    }

    if ("secondExpectReplyMarkup" in testCase && testCase.secondExpectReplyMarkup) {
      const secondParams = requireRecord(
        mockCall(botApi.editMessageText, 1, "second editMessageText call")[3],
        "second edit params",
      );
      expect(secondParams.reply_markup, testCase.name).toEqual(testCase.secondExpectReplyMarkup);
    }
  });

  it("treats 'message is not modified' as success", async () => {
    botApi.editMessageText.mockRejectedValueOnce(
      new Error(
        "400: Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message",
      ),
    );

    await expect(
      editMessageTelegram("123", 1, "hi", {
        token: "tok",
        cfg: {},
      }),
    ).resolves.toEqual({ ok: true, messageId: "1", chatId: "123" });
    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
  });

  it("retries editMessageTelegram on Telegram 5xx errors", async () => {
    botApi.editMessageText
      .mockRejectedValueOnce(Object.assign(new Error("502: Bad Gateway"), { error_code: 502 }))
      .mockResolvedValueOnce({ message_id: 1, chat: { id: "123" } });

    await expect(
      editMessageTelegram("123", 1, "hi", {
        token: "tok",
        cfg: {},
        retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).resolves.toEqual({ ok: true, messageId: "1", chatId: "123" });

    expect(botApi.editMessageText).toHaveBeenCalledTimes(2);
  });

  it("disables link previews when linkPreview is false", async () => {
    botApi.editMessageText.mockResolvedValue({ message_id: 1, chat: { id: "123" } });

    await editMessageTelegram("123", 1, "https://example.com", {
      token: "tok",
      cfg: {},
      linkPreview: false,
    });

    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
    const params = requireRecord(
      firstMockCall(botApi.editMessageText, "editMessageText call")[3],
      "edit params",
    );
    expect(params.parse_mode).toBe("HTML");
    expect(params.link_preview_options).toEqual({ is_disabled: true });
  });
});

describe("sendPollTelegram", () => {
  it("propagates gateway client scopes when resolving legacy poll targets", async () => {
    const api = {
      getChat: vi.fn(async () => ({ id: -100321 })),
      sendPoll: vi.fn(async () => ({ message_id: 123, chat: { id: 555 }, poll: { id: "p1" } })),
    };

    await sendPollTelegram(
      "https://t.me/mychannel",
      { question: " Q ", options: [" A ", "B "] },
      {
        cfg: TELEGRAM_TEST_CFG,
        token: "t",
        api: api as unknown as Bot["api"],
        gatewayClientScopes: ["operator.admin"],
      },
    );

    expect(api.getChat).toHaveBeenCalledWith("@mychannel");
    expectPersistedTarget({
      rawTarget: "https://t.me/mychannel",
      resolvedChatId: "-100321",
      gatewayClientScopes: ["operator.admin"],
    });
  });

  it("maps durationSeconds to open_period", async () => {
    const api = {
      sendPoll: vi.fn(async () => ({ message_id: 123, chat: { id: 555 }, poll: { id: "p1" } })),
    };

    const res = await sendPollTelegram(
      "123",
      { question: " Q ", options: [" A ", "B "], durationSeconds: 60 },
      { cfg: TELEGRAM_TEST_CFG, token: "t", api: api as unknown as Bot["api"] },
    );

    expect(res).toEqual({ messageId: "123", chatId: "555", pollId: "p1" });
    expect(api.sendPoll).toHaveBeenCalledTimes(1);
    const sendPollMock = api.sendPoll as ReturnType<typeof vi.fn>;
    const sendPollCall = firstMockCall(sendPollMock, "send poll call");
    expect(sendPollCall[0]).toBe("123");
    expect(sendPollCall[1]).toBe("Q");
    expect(sendPollCall[2]).toEqual(["A", "B"]);
    expect(requireRecord(sendPollCall[3], "send poll params").open_period).toBe(60);
  });

  it("retries without message_thread_id on thread-not-found", async () => {
    const api = {
      sendPoll: vi.fn(
        async (_chatId: string, _question: string, _options: string[], params: unknown) => {
          const p = params as { message_thread_id?: unknown } | undefined;
          if (p?.message_thread_id) {
            throw new Error("400: Bad Request: message thread not found");
          }
          return { message_id: 1, chat: { id: 2 }, poll: { id: "p2" } };
        },
      ),
    };

    const res = await sendPollTelegram(
      "-100123",
      { question: "Q", options: ["A", "B"] },
      {
        cfg: TELEGRAM_TEST_CFG,
        token: "t",
        api: api as unknown as Bot["api"],
        messageThreadId: 99,
      },
    );

    expect(res).toEqual({ messageId: "1", chatId: "2", pollId: "p2" });
    expect(api.sendPoll).toHaveBeenCalledTimes(2);
    expect(
      requireRecord(firstMockCall(api.sendPoll, "send poll call")[3], "send poll params")
        .message_thread_id,
    ).toBe(99);
    expect(
      (mockCall(api.sendPoll, 1, "second send poll call")[3] as { message_thread_id?: unknown })
        .message_thread_id,
    ).toBeUndefined();
  });

  it("rejects durationHours for Telegram polls", async () => {
    const api = { sendPoll: vi.fn() };

    await expect(
      sendPollTelegram(
        "123",
        { question: "Q", options: ["A", "B"], durationHours: 1 },
        { cfg: TELEGRAM_TEST_CFG, token: "t", api: api as unknown as Bot["api"] },
      ),
    ).rejects.toThrow(/durationHours is not supported/i);

    expect(api.sendPoll).not.toHaveBeenCalled();
  });

  it("fails when poll send returns no message_id", async () => {
    const api = {
      sendPoll: vi.fn(async () => ({ chat: { id: 555 }, poll: { id: "p1" } })),
    };

    await expect(
      sendPollTelegram(
        "123",
        { question: "Q", options: ["A", "B"] },
        { cfg: TELEGRAM_TEST_CFG, token: "t", api: api as unknown as Bot["api"] },
      ),
    ).rejects.toThrow(/returned no message_id/i);
  });
});

describe("createForumTopicTelegram", () => {
  const cases = [
    {
      name: "uses base chat id when target includes topic suffix",
      target: "telegram:group:-1001234567890:topic:271",
      title: "x",
      response: { message_thread_id: 272, name: "Build Updates" },
      expectedCall: ["-1001234567890", "x", undefined] as const,
      expectedResult: {
        topicId: 272,
        name: "Build Updates",
        chatId: "-1001234567890",
      },
    },
    {
      name: "forwards optional icon fields",
      target: "-1001234567890",
      title: "Roadmap",
      response: { message_thread_id: 300, name: "Roadmap" },
      options: {
        iconColor: 0x6fb9f0,
        iconCustomEmojiId: "  1234567890  ",
      },
      expectedCall: [
        "-1001234567890",
        "Roadmap",
        { icon_color: 0x6fb9f0, icon_custom_emoji_id: "1234567890" },
      ] as const,
      expectedResult: {
        topicId: 300,
        name: "Roadmap",
        chatId: "-1001234567890",
      },
    },
  ] as const;

  for (const testCase of cases) {
    it(testCase.name, async () => {
      const createForumTopic = vi.fn().mockResolvedValue(testCase.response);
      const api = { createForumTopic } as unknown as Bot["api"];

      const result = await createForumTopicTelegram(testCase.target, testCase.title, {
        cfg: TELEGRAM_TEST_CFG,
        token: "tok",
        api,
        ...("options" in testCase ? testCase.options : {}),
      });

      expect(createForumTopic).toHaveBeenCalledWith(...testCase.expectedCall);
      expect(result).toEqual(testCase.expectedResult);
    });
  }
});
