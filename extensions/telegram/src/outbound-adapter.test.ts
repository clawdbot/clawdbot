import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageTelegramMock = vi.fn();

vi.mock("./send.js", () => ({
  sendMessageTelegram: (...args: unknown[]) => sendMessageTelegramMock(...args),
}));

import { telegramOutbound } from "./outbound-adapter.js";

describe("telegramOutbound", () => {
  beforeEach(() => {
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
});
