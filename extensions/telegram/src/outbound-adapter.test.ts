import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageTelegramMock = vi.fn();
const pinMessageTelegramMock = vi.fn();

vi.mock("./send.js", () => ({
  pinMessageTelegram: (...args: unknown[]) => pinMessageTelegramMock(...args),
  sendMessageTelegram: (...args: unknown[]) => sendMessageTelegramMock(...args),
}));

import { telegramOutbound } from "./outbound-adapter.js";

describe("telegramOutbound", () => {
  beforeEach(() => {
    pinMessageTelegramMock.mockReset();
    sendMessageTelegramMock.mockReset();
  });

  it("forwards mediaLocalRoots in direct media sends", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-media" });

    const result = await telegramOutbound.sendMedia!({
      cfg: {} as never,
      to: "12345",
      text: "hello",
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp/agent-root"],
      accountId: "ops",
      replyToId: "900",
      threadId: "12",
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    expect(sendMessageTelegramMock).toHaveBeenCalledWith(
      "12345",
      "hello",
      expect.objectContaining({
        mediaUrl: "/tmp/image.png",
        mediaLocalRoots: ["/tmp/agent-root"],
        accountId: "ops",
        replyToMessageId: 900,
        messageThreadId: 12,
        textMode: "html",
      }),
    );
    expect(result).toEqual({ channel: "telegram", messageId: "tg-media" });
  });

  it("sends payload media in sequence and keeps buttons on the first message only", async () => {
    sendMessageTelegramMock
      .mockResolvedValueOnce({ messageId: "tg-1", chatId: "12345" })
      .mockResolvedValueOnce({ messageId: "tg-2", chatId: "12345" });

    const result = await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "",
      payload: {
        text: "Approval required",
        mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
        channelData: {
          telegram: {
            quoteText: "quoted",
            buttons: [[{ text: "Allow Once", callback_data: "/approve abc allow-once" }]],
          },
        },
      },
      mediaLocalRoots: ["/tmp/media"],
      accountId: "ops",
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    expect(sendMessageTelegramMock).toHaveBeenCalledTimes(2);
    expect(sendMessageTelegramMock).toHaveBeenNthCalledWith(
      1,
      "12345",
      "Approval required",
      expect.objectContaining({
        mediaUrl: "https://example.com/1.jpg",
        mediaLocalRoots: ["/tmp/media"],
        quoteText: "quoted",
        buttons: [[{ text: "Allow Once", callback_data: "/approve abc allow-once" }]],
      }),
    );
    expect(sendMessageTelegramMock).toHaveBeenNthCalledWith(
      2,
      "12345",
      "",
      expect.objectContaining({
        mediaUrl: "https://example.com/2.jpg",
        mediaLocalRoots: ["/tmp/media"],
        quoteText: "quoted",
      }),
    );
    expect(
      (sendMessageTelegramMock.mock.calls[1]?.[2] as Record<string, unknown>)?.buttons,
    ).toBeUndefined();
    expect(result).toEqual({ channel: "telegram", messageId: "tg-2", chatId: "12345" });
  });

  it("uses interactive button labels as fallback text for button-only payloads", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-buttons", chatId: "12345" });

    const result = await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "",
      payload: {
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "cmd:retry" }] }],
        },
      },
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    expect(sendMessageTelegramMock).toHaveBeenCalledWith(
      "12345",
      "- Retry",
      expect.objectContaining({
        buttons: [[{ text: "Retry", callback_data: "cmd:retry" }]],
      }),
    );
    expect(result).toEqual({ channel: "telegram", messageId: "tg-buttons", chatId: "12345" });
  });

  it("forwards audioAsVoice payload media to Telegram voice sends", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-voice", chatId: "12345" });

    const result = await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "",
      payload: {
        text: "voice caption",
        mediaUrl: "file:///tmp/note.ogg",
        audioAsVoice: true,
      },
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    expect(sendMessageTelegramMock).toHaveBeenCalledWith(
      "12345",
      "voice caption",
      expect.objectContaining({
        mediaUrl: "file:///tmp/note.ogg",
        asVoice: true,
      }),
    );
    expect(result).toEqual({ channel: "telegram", messageId: "tg-voice", chatId: "12345" });
  });

  it("passes delivery pin notify requests to Telegram pinning", async () => {
    pinMessageTelegramMock.mockResolvedValueOnce({ ok: true, messageId: "tg-1", chatId: "12345" });

    await telegramOutbound.pinDeliveredMessage?.({
      cfg: {} as never,
      target: { channel: "telegram", to: "12345", accountId: "ops" },
      messageId: "tg-1",
      pin: { enabled: true, notify: true },
    });

    expect(pinMessageTelegramMock).toHaveBeenCalledWith(
      "12345",
      "tg-1",
      expect.objectContaining({
        accountId: "ops",
        notify: true,
        verbose: false,
      }),
    );
  });
});
