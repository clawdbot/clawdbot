import { verifyDurableFinalCapabilityProofs } from "openclaw/plugin-sdk/channel-message";
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

  it("forwards silent delivery options to Telegram sends", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-silent", chatId: "12345" });

    const result = await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "quiet",
      payload: { text: "quiet" },
      silent: true,
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    expect(sendMessageTelegramMock).toHaveBeenCalledWith(
      "12345",
      "quiet",
      expect.objectContaining({
        silent: true,
      }),
    );
    expect(result).toEqual({ channel: "telegram", messageId: "tg-silent", chatId: "12345" });
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

  it("backs declared durable final capabilities with delivery proofs", async () => {
    const proveText = async () => {
      sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-text", chatId: "12345" });
      await telegramOutbound.sendText!({
        cfg: {} as never,
        to: "12345",
        text: "hello",
        deps: { sendTelegram: sendMessageTelegramMock },
      });
      expect(sendMessageTelegramMock).toHaveBeenLastCalledWith(
        "12345",
        "hello",
        expect.objectContaining({ textMode: "html" }),
      );
    };
    const proveMedia = async () => {
      sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-media", chatId: "12345" });
      await telegramOutbound.sendMedia!({
        cfg: {} as never,
        to: "12345",
        text: "caption",
        mediaUrl: "https://example.com/a.png",
        deps: { sendTelegram: sendMessageTelegramMock },
      });
      expect(sendMessageTelegramMock).toHaveBeenLastCalledWith(
        "12345",
        "caption",
        expect.objectContaining({ mediaUrl: "https://example.com/a.png" }),
      );
    };
    const provePayload = async () => {
      sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-payload", chatId: "12345" });
      await telegramOutbound.sendPayload!({
        cfg: {} as never,
        to: "12345",
        text: "",
        payload: { text: "payload" },
        deps: { sendTelegram: sendMessageTelegramMock },
      });
      expect(sendMessageTelegramMock).toHaveBeenLastCalledWith(
        "12345",
        "payload",
        expect.any(Object),
      );
    };
    const proveReplyThreadSilent = async () => {
      sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-thread", chatId: "12345" });
      await telegramOutbound.sendText!({
        cfg: {} as never,
        to: "12345",
        text: "threaded",
        replyToId: "900",
        threadId: "12",
        silent: true,
        deps: { sendTelegram: sendMessageTelegramMock },
      });
      expect(sendMessageTelegramMock).toHaveBeenLastCalledWith(
        "12345",
        "threaded",
        expect.objectContaining({
          replyToMessageId: 900,
          messageThreadId: 12,
          silent: true,
        }),
      );
    };
    const proveBatch = async () => {
      sendMessageTelegramMock
        .mockResolvedValueOnce({ messageId: "tg-batch-1", chatId: "12345" })
        .mockResolvedValueOnce({ messageId: "tg-batch-2", chatId: "12345" });
      await telegramOutbound.sendPayload!({
        cfg: {} as never,
        to: "12345",
        text: "",
        payload: {
          text: "batch",
          mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
        },
        deps: { sendTelegram: sendMessageTelegramMock },
      });
      expect(sendMessageTelegramMock).toHaveBeenCalledWith(
        "12345",
        "batch",
        expect.objectContaining({ mediaUrl: "https://example.com/a.png" }),
      );
      expect(sendMessageTelegramMock).toHaveBeenCalledWith(
        "12345",
        "",
        expect.objectContaining({ mediaUrl: "https://example.com/b.png" }),
      );
    };

    await verifyDurableFinalCapabilityProofs({
      adapterName: "telegramOutbound",
      capabilities: telegramOutbound.deliveryCapabilities?.durableFinal,
      proofs: {
        text: proveText,
        media: proveMedia,
        payload: provePayload,
        silent: proveReplyThreadSilent,
        replyTo: proveReplyThreadSilent,
        thread: proveReplyThreadSilent,
        messageSendingHooks: () => {
          expect(telegramOutbound.sendText).toBeTypeOf("function");
        },
        batch: proveBatch,
      },
    });
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
