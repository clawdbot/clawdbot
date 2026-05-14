import { verifyDurableFinalCapabilityProofs } from "openclaw/plugin-sdk/channel-message";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageTelegramMock = vi.fn();
const pinMessageTelegramMock = vi.fn();

vi.mock("./send.js", () => ({
  pinMessageTelegram: (...args: unknown[]) => pinMessageTelegramMock(...args),
  sendMessageTelegram: (...args: unknown[]) => sendMessageTelegramMock(...args),
}));

import { telegramOutbound } from "./outbound-adapter.js";

type MockWithCalls = {
  mock: { calls: unknown[][] };
};

function callOptionsAt(
  mock: MockWithCalls,
  index: number,
  expectedTo: string,
  expectedText: string,
): Record<string, unknown> {
  const call = mock.mock.calls[index];
  expect(call?.[0]).toBe(expectedTo);
  expect(call?.[1]).toBe(expectedText);
  const options = call?.[2];
  if (
    options === undefined ||
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    throw new Error(`expected call ${index} to include options`);
  }
  return options as Record<string, unknown>;
}

function lastCallOptions(
  mock: MockWithCalls,
  expectedTo: string,
  expectedText: string,
): Record<string, unknown> {
  return callOptionsAt(mock, mock.mock.calls.length - 1, expectedTo, expectedText);
}

function callOptionsFromEnd(
  mock: MockWithCalls,
  offsetFromEnd: number,
  expectedTo: string,
  expectedText: string,
): Record<string, unknown> {
  return callOptionsAt(mock, mock.mock.calls.length - offsetFromEnd, expectedTo, expectedText);
}

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

    expect(sendMessageTelegramMock).toHaveBeenCalledWith("12345", "hello", {
      cfg: {},
      verbose: false,
      messageThreadId: 12,
      replyToMessageId: 900,
      accountId: "ops",
      silent: undefined,
      gatewayClientScopes: undefined,
      mediaUrl: "/tmp/image.png",
      mediaLocalRoots: ["/tmp/agent-root"],
      mediaReadFile: undefined,
      forceDocument: false,
    });
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
    const firstOptions = callOptionsAt(sendMessageTelegramMock, 0, "12345", "Approval required");
    expect(firstOptions.mediaUrl).toBe("https://example.com/1.jpg");
    expect(firstOptions.mediaLocalRoots).toEqual(["/tmp/media"]);
    expect(firstOptions.quoteText).toBe("quoted");
    expect(firstOptions.buttons).toEqual([
      [{ text: "Allow Once", callback_data: "/approve abc allow-once" }],
    ]);
    const secondOptions = callOptionsAt(sendMessageTelegramMock, 1, "12345", "");
    expect(secondOptions.mediaUrl).toBe("https://example.com/2.jpg");
    expect(secondOptions.mediaLocalRoots).toEqual(["/tmp/media"]);
    expect(secondOptions.quoteText).toBe("quoted");
    expect(secondOptions.buttons).toBeUndefined();
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

    const options = callOptionsAt(sendMessageTelegramMock, 0, "12345", "- Retry");
    expect(options.buttons).toEqual([[{ text: "Retry", callback_data: "cmd:retry" }]]);
    expect(result).toEqual({ channel: "telegram", messageId: "tg-buttons", chatId: "12345" });
  });

  it("renders presentation web app buttons for payload sends", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-web-app", chatId: "12345" });
    const presentation = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [{ label: "Launch", webApp: { url: "https://example.com/app" } }],
        },
      ],
    };
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: { text: "Open app:" },
      presentation,
      ctx: {} as never,
    });
    if (!rendered) {
      throw new Error("expected rendered Telegram presentation");
    }

    await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "",
      payload: rendered,
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    const options = callOptionsAt(
      sendMessageTelegramMock,
      0,
      "12345",
      "Open app:\n\n- Launch: https://example.com/app",
    );
    expect(options.buttons).toEqual([
      [{ text: "Launch", web_app: { url: "https://example.com/app" } }],
    ]);
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

    const options = callOptionsAt(sendMessageTelegramMock, 0, "12345", "quiet");
    expect(options.silent).toBe(true);
    expect(result).toEqual({ channel: "telegram", messageId: "tg-silent", chatId: "12345" });
  });

  it("does not plain-text sanitize Telegram HTML before durable delivery", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-html", chatId: "12345" });

    await telegramOutbound.sendText!({
      cfg: {} as never,
      to: "12345",
      text: "<b>Morning</b> <code>oauth2</code>",
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    const options = callOptionsAt(
      sendMessageTelegramMock,
      0,
      "12345",
      "<b>Morning</b> <code>oauth2</code>",
    );
    expect(options.textMode).toBeUndefined();
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

    const options = callOptionsAt(sendMessageTelegramMock, 0, "12345", "voice caption");
    expect(options.mediaUrl).toBe("file:///tmp/note.ogg");
    expect(options.asVoice).toBe(true);
    expect(result).toEqual({ channel: "telegram", messageId: "tg-voice", chatId: "12345" });
  });

  it("backs declared durable final capabilities with delivery proofs", async () => {
    const proveText = async () => {
      sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-text", chatId: "12345" });
      await telegramOutbound.sendText!({
        cfg: {} as never,
        to: "12345",
        text: "hello",
        formatting: { parseMode: "HTML" },
        deps: { sendTelegram: sendMessageTelegramMock },
      });
      const options = lastCallOptions(sendMessageTelegramMock, "12345", "hello");
      expect(options.textMode).toBe("html");
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
      const options = lastCallOptions(sendMessageTelegramMock, "12345", "caption");
      expect(options.mediaUrl).toBe("https://example.com/a.png");
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
      lastCallOptions(sendMessageTelegramMock, "12345", "payload");
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
      const options = lastCallOptions(sendMessageTelegramMock, "12345", "threaded");
      expect(options.replyToMessageId).toBe(900);
      expect(options.messageThreadId).toBe(12);
      expect(options.silent).toBe(true);
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
      const firstOptions = callOptionsFromEnd(sendMessageTelegramMock, 2, "12345", "batch");
      expect(firstOptions.mediaUrl).toBe("https://example.com/a.png");
      const secondOptions = callOptionsFromEnd(sendMessageTelegramMock, 1, "12345", "");
      expect(secondOptions.mediaUrl).toBe("https://example.com/b.png");
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

    const options = callOptionsAt(pinMessageTelegramMock, 0, "12345", "tg-1");
    expect(options.accountId).toBe("ops");
    expect(options.notify).toBe(true);
    expect(options.verbose).toBe(false);
  });
});
