import { beforeEach, describe, expect, it, vi } from "vitest";

const loadWebMedia = vi.fn();

vi.mock("./runtime.js", () => {
  return {
    getTelegramUserRuntime: () => ({
      config: { loadConfig: () => ({}) },
      media: {
        loadWebMedia: (...args: unknown[]) => loadWebMedia(...args),
      },
    }),
  };
});

const inputMediaAuto = vi.fn((file: unknown, params: unknown) => ({
  type: "auto",
  file,
  ...(params && typeof params === "object" ? params : {}),
}));
const inputMediaVoice = vi.fn((file: unknown, params: unknown) => ({
  type: "voice",
  file,
  ...(params && typeof params === "object" ? params : {}),
}));

vi.mock("@mtcute/core", () => {
  return {
    InputMedia: {
      auto: (...args: unknown[]) => inputMediaAuto(...args),
      voice: (...args: unknown[]) => inputMediaVoice(...args),
      poll: () => ({ type: "poll" }),
    },
  };
});

describe("telegram-user send", () => {
  beforeEach(() => {
    loadWebMedia.mockReset();
    inputMediaAuto.mockClear();
    inputMediaVoice.mockClear();
  });

  it("sends audio media as voice note when audioAsVoice is set", async () => {
    loadWebMedia.mockResolvedValue({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      fileName: "note.ogg",
    });

    const sendMedia = vi.fn(async () => ({ id: 123 }));
    const { sendMediaTelegramUser } = await import("./send.js");
    await sendMediaTelegramUser("telegram-user:123", "hi", {
      client: { sendMedia } as unknown as import("@mtcute/node").TelegramClient,
      mediaUrl: "https://example.com/note.ogg",
      audioAsVoice: true,
    });

    expect(inputMediaVoice).toHaveBeenCalledTimes(1);
    expect(sendMedia).toHaveBeenCalledTimes(1);
    const [, media] = sendMedia.mock.calls[0] ?? [];
    expect(media).toMatchObject({ type: "voice" });
  });

  it("falls back to normal media when audioAsVoice is set but media is not voice-compatible", async () => {
    loadWebMedia.mockResolvedValue({
      buffer: Buffer.from("img"),
      contentType: "image/png",
      fileName: "image.png",
    });

    const sendMedia = vi.fn(async () => ({ id: 123 }));
    const { sendMediaTelegramUser } = await import("./send.js");
    await sendMediaTelegramUser("telegram-user:123", "hi", {
      client: { sendMedia } as unknown as import("@mtcute/node").TelegramClient,
      mediaUrl: "https://example.com/image.png",
      audioAsVoice: true,
    });

    expect(inputMediaVoice).toHaveBeenCalledTimes(0);
    expect(inputMediaAuto).toHaveBeenCalledTimes(1);
  });

  it("falls back to auto when voice messages are forbidden", async () => {
    loadWebMedia.mockResolvedValue({
      buffer: Buffer.from("voice"),
      contentType: "audio/ogg",
      fileName: "note.ogg",
    });

    const sendMedia = vi.fn(async (_to: unknown, media: unknown) => {
      if (media && typeof media === "object" && (media as { type?: string }).type === "voice") {
        throw new Error("VOICE_MESSAGES_FORBIDDEN");
      }
      return { id: 123 };
    });

    const { sendMediaTelegramUser } = await import("./send.js");
    await sendMediaTelegramUser("telegram-user:123", "hi", {
      client: { sendMedia } as unknown as import("@mtcute/node").TelegramClient,
      mediaUrl: "https://example.com/note.ogg",
      audioAsVoice: true,
    });

    expect(inputMediaVoice).toHaveBeenCalledTimes(1);
    expect(inputMediaAuto).toHaveBeenCalledTimes(1);
    expect(sendMedia).toHaveBeenCalledTimes(2);
  });
});

