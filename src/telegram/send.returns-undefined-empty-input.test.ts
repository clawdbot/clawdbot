import { beforeEach, describe, expect, it, vi } from "vitest";

const { botApi, botCtorSpy } = vi.hoisted(() => ({
  botApi: {
    sendMessage: vi.fn(),
    setMessageReaction: vi.fn(),
    sendSticker: vi.fn(),
  },
  botCtorSpy: vi.fn(),
}));

const { loadWebMedia } = vi.hoisted(() => ({
  loadWebMedia: vi.fn(),
}));

vi.mock("../web/media.js", () => ({
  loadWebMedia,
}));

vi.mock("grammy", () => ({
  Bot: class {
    api = botApi;
    catch = vi.fn();
    constructor(
      public token: string,
      public options?: {
        client?: { fetch?: typeof fetch; timeoutSeconds?: number };
      },
    ) {
      botCtorSpy(token, options);
    }
  },
  InputFile: class {},
}));

const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
}));
vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig,
  };
});

import { buildInlineKeyboard, sendMessageTelegram, sendStickerTelegram } from "./send.js";

describe("buildInlineKeyboard", () => {
  it("returns undefined for empty input", () => {
    expect(buildInlineKeyboard()).toBeUndefined();
    expect(buildInlineKeyboard([])).toBeUndefined();
  });

  it("builds inline keyboards for valid input", () => {
    const result = buildInlineKeyboard([
      [{ text: "Option A", callback_data: "cmd:a" }],
      [
        { text: "Option B", callback_data: "cmd:b" },
        { text: "Option C", callback_data: "cmd:c" },
      ],
    ]);
    expect(result).toEqual({
      inline_keyboard: [
        [{ text: "Option A", callback_data: "cmd:a" }],
        [
          { text: "Option B", callback_data: "cmd:b" },
          { text: "Option C", callback_data: "cmd:c" },
        ],
      ],
    });
  });

  it("filters invalid buttons and empty rows", () => {
    const result = buildInlineKeyboard([
      [
        { text: "", callback_data: "cmd:skip" },
        { text: "Ok", callback_data: "cmd:ok" },
      ],
      [{ text: "Missing data", callback_data: "" }],
      [],
    ]);
    expect(result).toEqual({
      inline_keyboard: [[{ text: "Ok", callback_data: "cmd:ok" }]],
    });
  });
});

describe("sendMessageTelegram", () => {
  beforeEach(() => {
    loadConfig.mockReturnValue({});
    loadWebMedia.mockReset();
    botApi.sendMessage.mockReset();
    botCtorSpy.mockReset();
  });

  it("passes timeoutSeconds to grammY client when configured", async () => {
    loadConfig.mockReturnValue({
      channels: { telegram: { timeoutSeconds: 60 } },
    });
    await sendMessageTelegram("123", "hi", { token: "tok" });
    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ timeoutSeconds: 60 }),
      }),
    );
  });
  it("prefers per-account timeoutSeconds overrides", async () => {
    loadConfig.mockReturnValue({
      channels: {
        telegram: {
          timeoutSeconds: 60,
          accounts: { foo: { timeoutSeconds: 61 } },
        },
      },
    });
    await sendMessageTelegram("123", "hi", { token: "tok", accountId: "foo" });
    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ timeoutSeconds: 61 }),
      }),
    );
  });

  it("falls back to plain text when Telegram rejects HTML", async () => {
    const chatId = "123";
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 9",
    );
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce({
        message_id: 42,
        chat: { id: chatId },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    const res = await sendMessageTelegram(chatId, "_oops_", {
      token: "tok",
      api,
      verbose: true,
    });

    expect(sendMessage).toHaveBeenNthCalledWith(1, chatId, "<i>oops</i>", {
      parse_mode: "HTML",
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, chatId, "_oops_");
    expect(res.chatId).toBe(chatId);
    expect(res.messageId).toBe("42");
  });

  it("adds link_preview_options when previews are disabled in config", async () => {
    const chatId = "123";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 7,
      chat: { id: chatId },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    loadConfig.mockReturnValue({
      channels: { telegram: { linkPreview: false } },
    });

    await sendMessageTelegram(chatId, "hi", { token: "tok", api });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "hi", {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  it("keeps link_preview_options on plain-text fallback when disabled", async () => {
    const chatId = "123";
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 9",
    );
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce({
        message_id: 42,
        chat: { id: chatId },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    loadConfig.mockReturnValue({
      channels: { telegram: { linkPreview: false } },
    });

    await sendMessageTelegram(chatId, "_oops_", {
      token: "tok",
      api,
    });

    expect(sendMessage).toHaveBeenNthCalledWith(1, chatId, "<i>oops</i>", {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, chatId, "_oops_", {
      link_preview_options: { is_disabled: true },
    });
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
      await sendMessageTelegram("123", "hi", { token: "tok" });
      const clientFetch = (botCtorSpy.mock.calls[0]?.[1] as { client?: { fetch?: unknown } })
        ?.client?.fetch;
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
      token: "tok",
      api,
    });

    expect(sendMessage).toHaveBeenCalledWith("123", "hi", {
      parse_mode: "HTML",
    });
  });

  it("wraps chat-not-found with actionable context", async () => {
    const chatId = "123";
    const err = new Error("400: Bad Request: chat not found");
    const sendMessage = vi.fn().mockRejectedValue(err);
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await expect(sendMessageTelegram(chatId, "hi", { token: "tok", api })).rejects.toThrow(
      /chat not found/i,
    );
    await expect(sendMessageTelegram(chatId, "hi", { token: "tok", api })).rejects.toThrow(
      /chat_id=123/,
    );
  });

  it("retries on transient errors with retry_after", async () => {
    vi.useFakeTimers();
    const chatId = "123";
    const err = Object.assign(new Error("429"), {
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
      token: "tok",
      api,
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 1000, jitter: 0 },
    });

    await vi.runAllTimersAsync();
    await expect(promise).resolves.toEqual({ messageId: "1", chatId });
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(500);
    setTimeoutSpy.mockRestore();
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
        token: "tok",
        api,
        retry: { attempts: 3, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      }),
    ).rejects.toThrow(/Bad Request/);
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

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("GIF89a"),
      fileName: "fun.gif",
    });

    const res = await sendMessageTelegram(chatId, "caption", {
      token: "tok",
      api,
      mediaUrl: "https://example.com/fun",
    });

    expect(sendAnimation).toHaveBeenCalledTimes(1);
    expect(sendAnimation).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "caption",
      parse_mode: "HTML",
    });
    expect(res.messageId).toBe("9");
  });

  it("sends audio media as files by default", async () => {
    const chatId = "123";
    const sendAudio = vi.fn().mockResolvedValue({
      message_id: 10,
      chat: { id: chatId },
    });
    const sendVoice = vi.fn().mockResolvedValue({
      message_id: 11,
      chat: { id: chatId },
    });
    const api = { sendAudio, sendVoice } as unknown as {
      sendAudio: typeof sendAudio;
      sendVoice: typeof sendVoice;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("audio"),
      contentType: "audio/mpeg",
      fileName: "clip.mp3",
    });

    await sendMessageTelegram(chatId, "caption", {
      token: "tok",
      api,
      mediaUrl: "https://example.com/clip.mp3",
    });

    expect(sendAudio).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "caption",
      parse_mode: "HTML",
    });
    expect(sendVoice).not.toHaveBeenCalled();
  });

  it("sends voice messages when asVoice is true and preserves thread params", async () => {
    const chatId = "-1001234567890";
    const sendAudio = vi.fn().mockResolvedValue({
      message_id: 12,
      chat: { id: chatId },
    });
    const sendVoice = vi.fn().mockResolvedValue({
      message_id: 13,
      chat: { id: chatId },
    });
    const api = { sendAudio, sendVoice } as unknown as {
      sendAudio: typeof sendAudio;
      sendVoice: typeof sendVoice;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      fileName: "note.ogg",
    });

    await sendMessageTelegram(chatId, "voice note", {
      token: "tok",
      api,
      mediaUrl: "https://example.com/note.ogg",
      asVoice: true,
      messageThreadId: 271,
      replyToMessageId: 500,
    });

    expect(sendVoice).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "voice note",
      parse_mode: "HTML",
      message_thread_id: 271,
      reply_to_message_id: 500,
    });
    expect(sendAudio).not.toHaveBeenCalled();
  });

  it("falls back to audio when asVoice is true but media is not voice compatible", async () => {
    const chatId = "123";
    const sendAudio = vi.fn().mockResolvedValue({
      message_id: 14,
      chat: { id: chatId },
    });
    const sendVoice = vi.fn().mockResolvedValue({
      message_id: 15,
      chat: { id: chatId },
    });
    const api = { sendAudio, sendVoice } as unknown as {
      sendAudio: typeof sendAudio;
      sendVoice: typeof sendVoice;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("audio"),
      contentType: "audio/mpeg",
      fileName: "clip.mp3",
    });

    await sendMessageTelegram(chatId, "caption", {
      token: "tok",
      api,
      mediaUrl: "https://example.com/clip.mp3",
      asVoice: true,
    });

    expect(sendAudio).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "caption",
      parse_mode: "HTML",
    });
    expect(sendVoice).not.toHaveBeenCalled();
  });

  it("includes message_thread_id for forum topic messages", async () => {
    const chatId = "-1001234567890";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 55,
      chat: { id: chatId },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(chatId, "hello forum", {
      token: "tok",
      api,
      messageThreadId: 271,
    });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "hello forum", {
      parse_mode: "HTML",
      message_thread_id: 271,
    });
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
      token: "tok",
      api,
      silent: true,
    });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "hi", {
      parse_mode: "HTML",
      disable_notification: true,
    });
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
      token: "tok",
      api,
    });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "hello forum", {
      parse_mode: "HTML",
      message_thread_id: 271,
    });
  });

  it("includes reply_to_message_id for threaded replies", async () => {
    const chatId = "123";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 56,
      chat: { id: chatId },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(chatId, "reply text", {
      token: "tok",
      api,
      replyToMessageId: 100,
    });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "reply text", {
      parse_mode: "HTML",
      reply_to_message_id: 100,
    });
  });

  it("includes both thread and reply params for forum topic replies", async () => {
    const chatId = "-1001234567890";
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 57,
      chat: { id: chatId },
    });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    await sendMessageTelegram(chatId, "forum reply", {
      token: "tok",
      api,
      messageThreadId: 271,
      replyToMessageId: 500,
    });

    expect(sendMessage).toHaveBeenCalledWith(chatId, "forum reply", {
      parse_mode: "HTML",
      message_thread_id: 271,
      reply_to_message_id: 500,
    });
  });
});

describe("sendStickerTelegram", () => {
  beforeEach(() => {
    loadConfig.mockReturnValue({});
    botApi.sendSticker.mockReset();
    botCtorSpy.mockReset();
  });

  it("sends a sticker by file_id", async () => {
    const chatId = "123";
    const fileId = "CAACAgIAAxkBAAI...sticker_file_id";
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 100,
      chat: { id: chatId },
    });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    const res = await sendStickerTelegram(chatId, fileId, {
      token: "tok",
      api,
    });

    expect(sendSticker).toHaveBeenCalledWith(chatId, fileId, undefined);
    expect(res.messageId).toBe("100");
    expect(res.chatId).toBe(chatId);
  });

  it("throws error when fileId is empty", async () => {
    await expect(sendStickerTelegram("123", "", { token: "tok" })).rejects.toThrow(
      /file_id is required/i,
    );
  });

  it("throws error when fileId is whitespace only", async () => {
    await expect(sendStickerTelegram("123", "   ", { token: "tok" })).rejects.toThrow(
      /file_id is required/i,
    );
  });

  it("includes message_thread_id for forum topic messages", async () => {
    const chatId = "-1001234567890";
    const fileId = "CAACAgIAAxkBAAI...sticker_file_id";
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 101,
      chat: { id: chatId },
    });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await sendStickerTelegram(chatId, fileId, {
      token: "tok",
      api,
      messageThreadId: 271,
    });

    expect(sendSticker).toHaveBeenCalledWith(chatId, fileId, {
      message_thread_id: 271,
    });
  });

  it("includes reply_to_message_id for threaded replies", async () => {
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
      token: "tok",
      api,
      replyToMessageId: 500,
    });

    expect(sendSticker).toHaveBeenCalledWith(chatId, fileId, {
      reply_to_message_id: 500,
    });
  });

  it("includes both thread and reply params for forum topic replies", async () => {
    const chatId = "-1001234567890";
    const fileId = "CAACAgIAAxkBAAI...sticker_file_id";
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 103,
      chat: { id: chatId },
    });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await sendStickerTelegram(chatId, fileId, {
      token: "tok",
      api,
      messageThreadId: 271,
      replyToMessageId: 500,
    });

    expect(sendSticker).toHaveBeenCalledWith(chatId, fileId, {
      message_thread_id: 271,
      reply_to_message_id: 500,
    });
  });

  it("normalizes chat ids with internal prefixes", async () => {
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 104,
      chat: { id: "123" },
    });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await sendStickerTelegram("telegram:123", "fileId123", {
      token: "tok",
      api,
    });

    expect(sendSticker).toHaveBeenCalledWith("123", "fileId123", undefined);
  });

  it("parses message_thread_id from recipient string (telegram:group:...:topic:...)", async () => {
    const chatId = "-1001234567890";
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 105,
      chat: { id: chatId },
    });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await sendStickerTelegram(`telegram:group:${chatId}:topic:271`, "fileId123", {
      token: "tok",
      api,
    });

    expect(sendSticker).toHaveBeenCalledWith(chatId, "fileId123", {
      message_thread_id: 271,
    });
  });

  it("wraps chat-not-found with actionable context", async () => {
    const chatId = "123";
    const err = new Error("400: Bad Request: chat not found");
    const sendSticker = vi.fn().mockRejectedValue(err);
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await expect(sendStickerTelegram(chatId, "fileId123", { token: "tok", api })).rejects.toThrow(
      /chat not found/i,
    );
    await expect(sendStickerTelegram(chatId, "fileId123", { token: "tok", api })).rejects.toThrow(
      /chat_id=123/,
    );
  });

  it("trims whitespace from fileId", async () => {
    const chatId = "123";
    const sendSticker = vi.fn().mockResolvedValue({
      message_id: 106,
      chat: { id: chatId },
    });
    const api = { sendSticker } as unknown as {
      sendSticker: typeof sendSticker;
    };

    await sendStickerTelegram(chatId, "  fileId123  ", {
      token: "tok",
      api,
    });

    expect(sendSticker).toHaveBeenCalledWith(chatId, "fileId123", undefined);
  });
});
