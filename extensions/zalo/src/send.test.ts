import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageMock = vi.fn();
const sendPhotoMock = vi.fn();
const resolveZaloProxyFetchMock = vi.fn();

vi.mock("./api.js", () => ({
  sendMessage: (...args: unknown[]) => sendMessageMock(...args),
  sendPhoto: (...args: unknown[]) => sendPhotoMock(...args),
}));

vi.mock("./proxy.js", () => ({
  resolveZaloProxyFetch: (...args: unknown[]) => resolveZaloProxyFetchMock(...args),
}));

import { sendMessageZalo, sendPhotoZalo } from "./send.js";

describe("zalo send", () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    sendPhotoMock.mockReset();
    resolveZaloProxyFetchMock.mockReset();
    resolveZaloProxyFetchMock.mockReturnValue(undefined);
  });

  it("sends text messages through the message API", async () => {
    sendMessageMock.mockResolvedValueOnce({
      ok: true,
      result: { message_id: "z-msg-1" },
    });

    const result = await sendMessageZalo("dm-chat-1", "hello there", {
      token: "zalo-token",
    });

    expect(sendMessageMock).toHaveBeenCalledWith(
      "zalo-token",
      {
        chat_id: "dm-chat-1",
        text: "hello there",
      },
      undefined,
    );
    expect(sendPhotoMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, messageId: "z-msg-1" });
    expect(result.receipt).toMatchObject({
      primaryPlatformMessageId: "z-msg-1",
      platformMessageIds: ["z-msg-1"],
      parts: [
        {
          platformMessageId: "z-msg-1",
          kind: "text",
          raw: {
            channel: "zalo",
            chatId: "dm-chat-1",
            messageId: "z-msg-1",
          },
        },
      ],
    });
  });

  it("routes media-bearing sends through the photo API and uses text as caption", async () => {
    sendPhotoMock.mockResolvedValueOnce({
      ok: true,
      result: { message_id: "z-photo-1" },
    });

    const result = await sendMessageZalo("dm-chat-2", "caption text", {
      token: "zalo-token",
      mediaUrl: "https://example.com/photo.jpg",
      caption: "ignored fallback caption",
    });

    expect(sendPhotoMock).toHaveBeenCalledWith(
      "zalo-token",
      {
        chat_id: "dm-chat-2",
        photo: "https://example.com/photo.jpg",
        caption: "caption text",
      },
      undefined,
    );
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, messageId: "z-photo-1" });
    expect(result.receipt).toMatchObject({
      primaryPlatformMessageId: "z-photo-1",
      platformMessageIds: ["z-photo-1"],
      parts: [
        {
          platformMessageId: "z-photo-1",
          kind: "media",
        },
      ],
    });
  });

  it("fails fast for missing token or blank photo URLs", async () => {
    const missingToken = await sendMessageZalo("dm-chat-3", "hello", {});
    expect(missingToken).toMatchObject({
      ok: false,
      error: "No Zalo bot token configured",
    });
    expect(missingToken.receipt.platformMessageIds).toStrictEqual([]);

    const blankPhoto = await sendPhotoZalo("dm-chat-4", "   ", {
      token: "zalo-token",
    });
    expect(blankPhoto).toMatchObject({
      ok: false,
      error: "No photo URL provided",
    });
    expect(blankPhoto.receipt.platformMessageIds).toStrictEqual([]);

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(sendPhotoMock).not.toHaveBeenCalled();
  });

  it("sends cfg-backed media directly without hosted-media rewrites", async () => {
    sendPhotoMock.mockResolvedValueOnce({
      ok: true,
      result: { message_id: "z-photo-2" },
    });

    const result = await sendPhotoZalo("dm-chat-5", "https://example.com/photo.jpg", {
      cfg: {
        channels: {
          zalo: {
            botToken: "zalo-token",
            webhookUrl: "https://gateway.example.com/zalo-webhook",
          },
        },
      } as never,
    });

    expect(sendPhotoMock).toHaveBeenCalledWith(
      "zalo-token",
      {
        chat_id: "dm-chat-5",
        photo: "https://example.com/photo.jpg",
        caption: undefined,
      },
      undefined,
    );
    expect(result).toMatchObject({ ok: true, messageId: "z-photo-2" });
    expect(result.receipt.platformMessageIds).toEqual(["z-photo-2"]);
  });
});
