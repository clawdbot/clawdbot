import { beforeEach, describe, expect, it, vi } from "vitest";

const { botApi, botCtorSpy } = vi.hoisted(() => ({
  botApi: {
    sendMessage: vi.fn(),
    sendPhoto: vi.fn(),
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

import { sendMessageTelegram } from "./send.js";

describe("sendMessageTelegram caption splitting", () => {
  beforeEach(() => {
    loadConfig.mockReturnValue({});
    loadWebMedia.mockReset();
    botApi.sendMessage.mockReset();
    botApi.sendPhoto.mockReset();
    botCtorSpy.mockReset();
  });

  it("splits long captions into media + text messages when text exceeds 1024 chars", async () => {
    const chatId = "123";
    // Generate text longer than 1024 characters
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

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const res = await sendMessageTelegram(chatId, longText, {
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
    });

    // Media should be sent first without caption
    expect(sendPhoto).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: undefined,
    });
    // Then text sent as separate message (plain text, matching caption behavior)
    expect(sendMessage).toHaveBeenCalledWith(chatId, longText);
    // Returns the text message ID (the "main" content)
    expect(res.messageId).toBe("71");
  });

  it("uses caption when text is within 1024 char limit", async () => {
    const chatId = "123";
    // Text exactly at 1024 characters should still use caption
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

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const res = await sendMessageTelegram(chatId, shortText, {
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
    });

    // Caption should be included with media
    expect(sendPhoto).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: shortText,
    });
    // No separate text message needed
    expect(sendMessage).not.toHaveBeenCalled();
    expect(res.messageId).toBe("72");
  });

  it("preserves thread params when splitting long captions", async () => {
    const chatId = "-1001234567890";
    const longText = "C".repeat(1100);

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 73,
      chat: { id: chatId },
    });
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 74,
      chat: { id: chatId },
    });
    const api = { sendPhoto, sendMessage } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, longText, {
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
      messageThreadId: 271,
      replyToMessageId: 500,
    });

    // Media sent with thread params but no caption
    expect(sendPhoto).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: undefined,
      message_thread_id: 271,
      reply_to_message_id: 500,
    });
    // Text message also includes thread params (plain text, matching caption behavior)
    expect(sendMessage).toHaveBeenCalledWith(chatId, longText, {
      message_thread_id: 271,
      reply_to_message_id: 500,
    });
  });

  it("puts reply_markup only on follow-up text when splitting", async () => {
    const chatId = "123";
    const longText = "D".repeat(1100);

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 75,
      chat: { id: chatId },
    });
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 76,
      chat: { id: chatId },
    });
    const api = { sendPhoto, sendMessage } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, longText, {
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
      buttons: [[{ text: "Click me", callback_data: "action:click" }]],
    });

    // Media sent WITHOUT reply_markup
    expect(sendPhoto).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: undefined,
    });
    // Follow-up text has the reply_markup
    expect(sendMessage).toHaveBeenCalledWith(chatId, longText, {
      reply_markup: {
        inline_keyboard: [[{ text: "Click me", callback_data: "action:click" }]],
      },
    });
  });

  it("includes thread params and reply_markup on follow-up text when splitting", async () => {
    const chatId = "-1001234567890";
    const longText = "F".repeat(1100);

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 78,
      chat: { id: chatId },
    });
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 79,
      chat: { id: chatId },
    });
    const api = { sendPhoto, sendMessage } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, longText, {
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
      messageThreadId: 271,
      replyToMessageId: 500,
      buttons: [[{ text: "Click me", callback_data: "action:click" }]],
    });

    expect(sendPhoto).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: undefined,
      message_thread_id: 271,
      reply_to_message_id: 500,
    });
    expect(sendMessage).toHaveBeenCalledWith(chatId, longText, {
      message_thread_id: 271,
      reply_to_message_id: 500,
      reply_markup: {
        inline_keyboard: [[{ text: "Click me", callback_data: "action:click" }]],
      },
    });
  });

  it("wraps chat-not-found errors from follow-up message", async () => {
    const chatId = "123";
    const longText = "G".repeat(1100);

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 80,
      chat: { id: chatId },
    });
    const sendMessage = vi.fn().mockRejectedValue(new Error("400: Bad Request: chat not found"));
    const api = { sendPhoto, sendMessage } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await expect(
      sendMessageTelegram(chatId, longText, {
        token: "tok",
        api,
        mediaUrl: "https://example.com/photo.jpg",
      }),
    ).rejects.toThrow(/Telegram send failed: chat not found \(chat_id=123\)\./);
  });

  it("does not send follow-up text when caption is empty", async () => {
    const chatId = "123";
    const emptyText = "   ";

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 81,
      chat: { id: chatId },
    });
    const sendMessage = vi.fn();
    const api = { sendPhoto, sendMessage } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    const res = await sendMessageTelegram(chatId, emptyText, {
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
    });

    expect(sendPhoto).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: undefined,
    });
    expect(sendMessage).not.toHaveBeenCalled();
    expect(res.messageId).toBe("81");
  });

  it("keeps reply_markup on media when not splitting", async () => {
    const chatId = "123";
    const shortText = "E".repeat(100);

    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 77,
      chat: { id: chatId },
    });
    const sendMessage = vi.fn();
    const api = { sendPhoto, sendMessage } as unknown as {
      sendPhoto: typeof sendPhoto;
      sendMessage: typeof sendMessage;
    };

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, shortText, {
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
      buttons: [[{ text: "Click me", callback_data: "action:click" }]],
    });

    // Media sent WITH reply_markup when not splitting
    expect(sendPhoto).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: shortText,
      reply_markup: {
        inline_keyboard: [[{ text: "Click me", callback_data: "action:click" }]],
      },
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
