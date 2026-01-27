import { describe, expect, it, vi } from "vitest";

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
    catch = vi.fn();
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

describe("buildInlineKeyboard", () => {
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
    expect(sendMessage).toHaveBeenNthCalledWith(1, chatId, "<i>bad markdown</i>", {
      parse_mode: "HTML",
      message_thread_id: 271,
      reply_to_message_id: 100,
    });
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
      parse_mode: "HTML",
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

    expect(setMessageReaction).toHaveBeenCalledWith("123", 456, [{ type: "emoji", emoji: "✅" }]);
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
