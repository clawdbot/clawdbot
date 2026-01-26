import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Bot } from "grammy";

import { deliverReplies } from "./delivery.js";

const loadWebMedia = vi.fn();

vi.mock("../../web/media.js", () => ({
  loadWebMedia: (...args: unknown[]) => loadWebMedia(...args),
}));

vi.mock("grammy", () => ({
  InputFile: class {
    constructor(
      public buffer: Buffer,
      public fileName?: string,
    ) {}
  },
  GrammyError: class GrammyError extends Error {
    description = "";
  },
}));

describe("deliverReplies", () => {
  beforeEach(() => {
    loadWebMedia.mockReset();
  });

  it("skips audioAsVoice-only payloads without logging an error", async () => {
    const runtime = { error: vi.fn() };
    const bot = { api: {} } as unknown as Bot;

    await deliverReplies({
      replies: [{ audioAsVoice: true }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
    });

    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("invokes onVoiceRecording before sending a voice note", async () => {
    const events: string[] = [];
    const runtime = { error: vi.fn() };
    const sendVoice = vi.fn(async () => {
      events.push("sendVoice");
      return { message_id: 1, chat: { id: "123" } };
    });
    const bot = { api: { sendVoice } } as unknown as Bot;
    const onVoiceRecording = vi.fn(async () => {
      events.push("recordVoice");
    });

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      fileName: "note.ogg",
    });

    await deliverReplies({
      replies: [{ mediaUrl: "https://example.com/note.ogg", audioAsVoice: true }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
      onVoiceRecording,
    });

    expect(onVoiceRecording).toHaveBeenCalledTimes(1);
    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["recordVoice", "sendVoice"]);
  });

  it("renders markdown in media captions", async () => {
    const runtime = { error: vi.fn(), log: vi.fn() };
    const sendPhoto = vi.fn().mockResolvedValue({
      message_id: 2,
      chat: { id: "123" },
    });
    const bot = { api: { sendPhoto } } as unknown as Bot;

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await deliverReplies({
      replies: [{ mediaUrl: "https://example.com/photo.jpg", text: "hi **boss**" }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
    });

    expect(sendPhoto).toHaveBeenCalledWith(
      "123",
      expect.anything(),
      expect.objectContaining({
        caption: "hi <b>boss</b>",
        parse_mode: "HTML",
      }),
    );
  });

  it("includes link_preview_options when linkPreview is false", async () => {
    const runtime = { error: vi.fn(), log: vi.fn() };
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 3,
      chat: { id: "123" },
    });
    const bot = { api: { sendMessage } } as unknown as Bot;

    await deliverReplies({
      replies: [{ text: "Check https://example.com" }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
      linkPreview: false,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.objectContaining({
        link_preview_options: { is_disabled: true },
      }),
    );
  });

  it("does not include link_preview_options when linkPreview is true", async () => {
    const runtime = { error: vi.fn(), log: vi.fn() };
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 4,
      chat: { id: "123" },
    });
    const bot = { api: { sendMessage } } as unknown as Bot;

    await deliverReplies({
      replies: [{ text: "Check https://example.com" }],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
      linkPreview: true,
    });

    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.any(String),
      expect.not.objectContaining({
        link_preview_options: expect.anything(),
      }),
    );
  });

  it("falls back to text when sendVoice fails with VOICE_MESSAGES_FORBIDDEN", async () => {
    const runtime = { error: vi.fn(), log: vi.fn() };
    const sendVoice = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "GrammyError: Call to 'sendVoice' failed! (400: Bad Request: VOICE_MESSAGES_FORBIDDEN)",
        ),
      );
    const sendMessage = vi.fn().mockResolvedValue({
      message_id: 5,
      chat: { id: "123" },
    });
    const bot = { api: { sendVoice, sendMessage } } as unknown as Bot;

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      fileName: "note.ogg",
    });

    await deliverReplies({
      replies: [
        { mediaUrl: "https://example.com/note.ogg", text: "Hello there", audioAsVoice: true },
      ],
      chatId: "123",
      token: "tok",
      runtime,
      bot,
      replyToMode: "off",
      textLimit: 4000,
    });

    // Voice was attempted but failed
    expect(sendVoice).toHaveBeenCalledTimes(1);
    // Fallback to text succeeded
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "123",
      expect.stringContaining("Hello there"),
      expect.any(Object),
    );
  });

  it("rethrows non-VOICE_MESSAGES_FORBIDDEN errors from sendVoice", async () => {
    const runtime = { error: vi.fn(), log: vi.fn() };
    const sendVoice = vi.fn().mockRejectedValue(new Error("Network error"));
    const sendMessage = vi.fn();
    const bot = { api: { sendVoice, sendMessage } } as unknown as Bot;

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      fileName: "note.ogg",
    });

    await expect(
      deliverReplies({
        replies: [{ mediaUrl: "https://example.com/note.ogg", text: "Hello", audioAsVoice: true }],
        chatId: "123",
        token: "tok",
        runtime,
        bot,
        replyToMode: "off",
        textLimit: 4000,
      }),
    ).rejects.toThrow("Network error");

    expect(sendVoice).toHaveBeenCalledTimes(1);
    // Text fallback should NOT be attempted for other errors
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rethrows VOICE_MESSAGES_FORBIDDEN when no text fallback is available", async () => {
    const runtime = { error: vi.fn(), log: vi.fn() };
    const sendVoice = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "GrammyError: Call to 'sendVoice' failed! (400: Bad Request: VOICE_MESSAGES_FORBIDDEN)",
        ),
      );
    const sendMessage = vi.fn();
    const bot = { api: { sendVoice, sendMessage } } as unknown as Bot;

    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      fileName: "note.ogg",
    });

    await expect(
      deliverReplies({
        replies: [{ mediaUrl: "https://example.com/note.ogg", audioAsVoice: true }],
        chatId: "123",
        token: "tok",
        runtime,
        bot,
        replyToMode: "off",
        textLimit: 4000,
      }),
    ).rejects.toThrow("VOICE_MESSAGES_FORBIDDEN");

    expect(sendVoice).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
