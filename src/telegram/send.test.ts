import { beforeEach, describe, expect, it, vi } from "vitest";

const { botApi, botCtorSpy } = vi.hoisted(() => ({
  botApi: {
    sendMessage: vi.fn(),
    setMessageReaction: vi.fn(),
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
      public options?: { client?: { fetch?: typeof fetch } },
    ) {
      botCtorSpy(token, options);
    }
  },
  InputFile: class {},
}));

import { reactMessageTelegram, sendMessageTelegram } from "./send.js";

describe("sendMessageTelegram", () => {
  beforeEach(() => {
    loadWebMedia.mockReset();
    botApi.sendMessage.mockReset();
    botCtorSpy.mockReset();
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
      expect(botCtorSpy).toHaveBeenCalledWith(
        "tok",
        expect.objectContaining({
          client: expect.objectContaining({ fetch: fetchSpy }),
        }),
      );
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

    await expect(
      sendMessageTelegram(chatId, "hi", { token: "tok", api }),
    ).rejects.toThrow(/chat not found/i);
    await expect(
      sendMessageTelegram(chatId, "hi", { token: "tok", api }),
    ).rejects.toThrow(/chat_id=123/);
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
    const sendMessage = vi
      .fn()
      .mockRejectedValue(new Error("400: Bad Request"));
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
      message_thread_id: 271,
      reply_to_message_id: 500,
    });
    expect(sendAudio).not.toHaveBeenCalled();
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

  it("preserves thread params in plain text fallback", async () => {
    const chatId = "-1001234567890";
    const parseErr = new Error(
      "400: Bad Request: can't parse entities: Can't find end of the entity",
    );
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(parseErr)
      .mockResolvedValueOnce({
        message_id: 60,
        chat: { id: chatId },
      });
    const api = { sendMessage } as unknown as {
      sendMessage: typeof sendMessage;
    };

    const res = await sendMessageTelegram(chatId, "_bad markdown_", {
      token: "tok",
      api,
      messageThreadId: 271,
      replyToMessageId: 100,
    });

    // First call: with HTML + thread params
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      chatId,
      "<i>bad markdown</i>",
      {
        parse_mode: "HTML",
        message_thread_id: 271,
        reply_to_message_id: 100,
      },
    );
    // Second call: plain text BUT still with thread params (critical!)
    expect(sendMessage).toHaveBeenNthCalledWith(2, chatId, "_bad markdown_", {
      message_thread_id: 271,
      reply_to_message_id: 100,
    });
    expect(res.messageId).toBe("60");
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

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("fake-image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram(chatId, "photo in topic", {
      token: "tok",
      api,
      mediaUrl: "https://example.com/photo.jpg",
      messageThreadId: 99,
    });

    expect(sendPhoto).toHaveBeenCalledWith(chatId, expect.anything(), {
      caption: "photo in topic",
      message_thread_id: 99,
    });
  });
});

describe("reactMessageTelegram", () => {
  it("sends emoji reactions", async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const api = { setMessageReaction } as unknown as {
      setMessageReaction: typeof setMessageReaction;
    };

    await reactMessageTelegram("telegram:123", "456", "✅", {
      token: "tok",
      api,
    });

    expect(setMessageReaction).toHaveBeenCalledWith("123", 456, [
      { type: "emoji", emoji: "✅" },
    ]);
  });

  it("removes reactions when emoji is empty", async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const api = { setMessageReaction } as unknown as {
      setMessageReaction: typeof setMessageReaction;
    };

    await reactMessageTelegram("123", 456, "", {
      token: "tok",
      api,
    });

    expect(setMessageReaction).toHaveBeenCalledWith("123", 456, []);
  });

  it("removes reactions when remove flag is set", async () => {
    const setMessageReaction = vi.fn().mockResolvedValue(undefined);
    const api = { setMessageReaction } as unknown as {
      setMessageReaction: typeof setMessageReaction;
    };

    await reactMessageTelegram("123", 456, "✅", {
      token: "tok",
      api,
      remove: true,
    });

    expect(setMessageReaction).toHaveBeenCalledWith("123", 456, []);
  });
});
