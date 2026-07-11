// Telegram tests cover outbound adapter plugin behavior.
import { verifyDurableFinalCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import { adaptMessagePresentationForChannel } from "openclaw/plugin-sdk/interactive-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageTelegramMock = vi.fn();
const pinMessageTelegramMock = vi.fn();
const reactMessageTelegramMock = vi.fn();
const sendPollTelegramMock = vi.fn();

vi.mock("./send.js", () => ({
  pinMessageTelegram: (...args: unknown[]) => pinMessageTelegramMock(...args),
  reactMessageTelegram: (...args: unknown[]) => reactMessageTelegramMock(...args),
  sendPollTelegram: (...args: unknown[]) => sendPollTelegramMock(...args),
  sendMessageTelegram: (...args: unknown[]) => sendMessageTelegramMock(...args),
}));

import { telegramOutbound } from "./outbound-adapter.js";
import { resolveTelegramPromptContextDeliverySignature } from "./prompt-context-projection.js";

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
    reactMessageTelegramMock.mockReset();
    sendPollTelegramMock.mockReset();
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
            promptContextSource: {
              transcriptMessageId: "assistant-media",
              deliverySignature: resolveTelegramPromptContextDeliverySignature({
                text: "Approval required",
                mediaUrls: ["https://example.com/1.jpg", "https://example.com/2.jpg"],
              }),
            },
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
    expect(firstOptions.promptContextProjectionPlan).toMatchObject({
      cursor: {
        source: {
          transcriptMessageId: "assistant-media",
        },
        nextPartIndex: 0,
        complete: true,
      },
      finalPart: false,
    });
    const secondOptions = callOptionsAt(sendMessageTelegramMock, 1, "12345", "");
    expect(secondOptions.mediaUrl).toBe("https://example.com/2.jpg");
    expect(secondOptions.mediaLocalRoots).toEqual(["/tmp/media"]);
    expect(secondOptions.quoteText).toBe("quoted");
    expect(secondOptions.buttons).toBeUndefined();
    expect(secondOptions.promptContextProjectionPlan).toMatchObject({
      cursor: {
        source: {
          transcriptMessageId: "assistant-media",
        },
        nextPartIndex: 0,
        complete: true,
      },
      finalPart: true,
    });
    expect((firstOptions.promptContextProjectionPlan as { cursor: unknown }).cursor).toBe(
      (secondOptions.promptContextProjectionPlan as { cursor: unknown }).cursor,
    );
    expect(result).toEqual({ channel: "telegram", messageId: "tg-2", chatId: "12345" });
  });

  it.each([
    ["trailing empty", ["https://example.com/only.jpg", ""]],
    ["leading empty", ["", "https://example.com/only.jpg"]],
    ["whitespace", ["   ", " https://example.com/only.jpg "]],
  ])("normalizes $0 media entries before first/final decisions", async (_name, mediaUrls) => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-only", chatId: "12345" });
    const buttons = [[{ text: "Open", callback_data: "open" }]];

    await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "caption",
      payload: {
        text: "caption",
        mediaUrls,
        channelData: {
          telegram: {
            buttons,
            promptContextSource: {
              transcriptMessageId: "assistant-media",
              deliverySignature: resolveTelegramPromptContextDeliverySignature({
                text: "caption",
                mediaUrls,
              }),
            },
          },
        },
      },
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    const options = callOptionsAt(sendMessageTelegramMock, 0, "12345", "caption");
    expect(sendMessageTelegramMock).toHaveBeenCalledTimes(1);
    expect(options.mediaUrl).toBe("https://example.com/only.jpg");
    expect(options.buttons).toEqual(buttons);
    expect(options.promptContextProjectionPlan).toMatchObject({ finalPart: true });
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

  it("forwards prompt-context sources on durable payload sends", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-final", chatId: "12345" });

    const result = await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "",
      payload: {
        text: "Final answer",
        channelData: {
          telegram: {
            promptContextSource: {
              transcriptMessageId: "assistant-final",
              deliverySignature: resolveTelegramPromptContextDeliverySignature({
                text: "Final answer",
              }),
            },
          },
        },
      },
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    const options = callOptionsAt(sendMessageTelegramMock, 0, "12345", "Final answer");
    expect(options.promptContextProjectionPlan).toMatchObject({
      cursor: {
        source: {
          transcriptMessageId: "assistant-final",
        },
        nextPartIndex: 0,
        complete: true,
      },
      finalPart: true,
    });
    expect(result).toEqual({ channel: "telegram", messageId: "tg-final", chatId: "12345" });
  });

  it("detaches stale prompt-context provenance after a durable hook rewrite", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-final", chatId: "12345" });

    await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "",
      payload: {
        text: "Hook-rewritten answer",
        channelData: {
          telegram: {
            promptContextSource: {
              transcriptMessageId: "assistant-final",
              deliverySignature: resolveTelegramPromptContextDeliverySignature({
                text: "Original answer",
              }),
            },
          },
        },
      },
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    const options = callOptionsAt(sendMessageTelegramMock, 0, "12345", "Hook-rewritten answer");
    expect(options.promptContextProjectionPlan).toBeUndefined();
  });

  it("applies reaction-only payloads without sending empty Telegram text", async () => {
    reactMessageTelegramMock.mockResolvedValueOnce({ ok: true });

    const result = await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "",
      replyToId: "777",
      payload: {
        channelData: {
          telegram: {
            reaction: { emoji: "🔥" },
          },
        },
      },
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    expect(reactMessageTelegramMock).toHaveBeenCalledWith("12345", 777, "🔥", {
      cfg: {},
      verbose: false,
      accountId: undefined,
      gatewayClientScopes: undefined,
    });
    expect(sendMessageTelegramMock).not.toHaveBeenCalled();
    expect(result).toEqual({ channel: "telegram", messageId: "777", chatId: "12345" });
  });

  it("applies reaction payloads before sending visible text", async () => {
    reactMessageTelegramMock.mockResolvedValueOnce({ ok: true });
    sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-text", chatId: "12345" });

    await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "",
      accountId: "ops",
      replyToId: "777",
      payload: {
        text: "Done",
        channelData: {
          telegram: {
            reaction: { emoji: "✅" },
          },
        },
      },
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    expect(reactMessageTelegramMock).toHaveBeenCalledWith(
      "12345",
      777,
      "✅",
      expect.objectContaining({ accountId: "ops" }),
    );
    expect(sendMessageTelegramMock).toHaveBeenCalledWith(
      "12345",
      "Done",
      expect.objectContaining({ accountId: "ops", replyToMessageId: 777 }),
    );
    expect(reactMessageTelegramMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendMessageTelegramMock.mock.invocationCallOrder[0],
    );
  });

  it("rejects text plus reaction payloads without a reply target", async () => {
    await expect(
      telegramOutbound.sendPayload!({
        cfg: {} as never,
        to: "12345",
        text: "",
        payload: {
          text: "Done",
          channelData: { telegram: { reaction: { emoji: "🔥" } } },
        },
        deps: { sendTelegram: sendMessageTelegramMock },
      }),
    ).rejects.toThrow("Telegram reaction requires a reply target");

    expect(reactMessageTelegramMock).not.toHaveBeenCalled();
    expect(sendMessageTelegramMock).not.toHaveBeenCalled();
  });

  it("rejects text plus reaction payloads when Telegram refuses the emoji", async () => {
    reactMessageTelegramMock.mockResolvedValueOnce({
      ok: false,
      warning: "Reaction unavailable: not-supported",
    });

    await expect(
      telegramOutbound.sendPayload!({
        cfg: {} as never,
        to: "12345",
        text: "",
        replyToId: "777",
        payload: {
          text: "Done",
          channelData: { telegram: { reaction: { emoji: "not-supported" } } },
        },
        deps: { sendTelegram: sendMessageTelegramMock },
      }),
    ).rejects.toThrow("Reaction unavailable: not-supported");

    expect(sendMessageTelegramMock).not.toHaveBeenCalled();
  });

  it("rejects reaction-only payloads without a reply target", async () => {
    await expect(
      telegramOutbound.sendPayload!({
        cfg: {} as never,
        to: "12345",
        text: "",
        payload: {
          channelData: { telegram: { reaction: { emoji: "🔥" } } },
        },
        deps: { sendTelegram: sendMessageTelegramMock },
      }),
    ).rejects.toThrow("Telegram reaction requires a reply target");

    expect(reactMessageTelegramMock).not.toHaveBeenCalled();
    expect(sendMessageTelegramMock).not.toHaveBeenCalled();
  });

  it("rejects reaction-only payloads when Telegram refuses the emoji", async () => {
    reactMessageTelegramMock.mockResolvedValueOnce({
      ok: false,
      warning: "Reaction unavailable: not-supported",
    });

    await expect(
      telegramOutbound.sendPayload!({
        cfg: {} as never,
        to: "12345",
        text: "",
        replyToId: "777",
        payload: {
          channelData: { telegram: { reaction: { emoji: "not-supported" } } },
        },
        deps: { sendTelegram: sendMessageTelegramMock },
      }),
    ).rejects.toThrow("Reaction unavailable: not-supported");

    expect(sendMessageTelegramMock).not.toHaveBeenCalled();
  });

  it("uses presentation button labels as fallback text for presentation-only payloads", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({
      messageId: "tg-presentation-buttons",
      chatId: "12345",
    });

    const result = await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "",
      payload: {
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "cmd:retry" }] }],
        },
      },
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    const options = callOptionsAt(sendMessageTelegramMock, 0, "12345", "- Retry");
    expect(options.buttons).toEqual([[{ text: "Retry", callback_data: "cmd:retry" }]]);
    expect(result).toEqual({
      channel: "telegram",
      messageId: "tg-presentation-buttons",
      chatId: "12345",
    });
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

  it("preserves explicit Telegram buttons when rendering presentation payloads", async () => {
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: {
        text: "Use native buttons:",
        channelData: {
          telegram: {
            buttons: [[{ text: "Native", callback_data: "native" }]],
          },
        },
      },
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Generic", value: "generic" }],
          },
        ],
      },
      ctx: {} as never,
    });

    expect((rendered?.channelData?.telegram as { buttons?: unknown })?.buttons).toEqual([
      [{ text: "Native", callback_data: "native" }],
    ]);
  });

  it("preserves legacy interactive buttons when rendering mixed presentation payloads", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({
      messageId: "tg-mixed-buttons",
      chatId: "12345",
    });
    const rendered = await telegramOutbound.renderPresentation?.({
      payload: {
        text: "Choose:",
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Legacy", value: "legacy" }] }],
        },
      },
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Generic", value: "generic" }],
          },
        ],
      },
      ctx: {} as never,
    });
    if (!rendered) {
      throw new Error("expected rendered Telegram presentation");
    }

    expect((rendered.channelData?.telegram as { buttons?: unknown } | undefined)?.buttons).toBe(
      undefined,
    );

    await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "12345",
      text: "",
      payload: rendered,
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    const options = callOptionsAt(sendMessageTelegramMock, 0, "12345", "Choose:\n\n- Generic");
    expect(options.buttons).toEqual([[{ text: "Legacy", callback_data: "legacy" }]]);
  });

  it("lets allow-always approval callbacks reach Telegram's callback rewrite", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({
      messageId: "tg-approval",
      chatId: "12345",
    });
    const approvalId = "plugin:123e4567-e89b-12d3-a456-426614174000";
    const presentation = adaptMessagePresentationForChannel({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow Always",
                value: `/approve ${approvalId} allow-always`,
              },
            ],
          },
        ],
      },
      capabilities: telegramOutbound.presentationCapabilities,
    });

    const rendered = await telegramOutbound.renderPresentation?.({
      payload: { text: "Approve?" },
      presentation,
      ctx: {} as never,
    });
    if (!rendered) {
      throw new Error("expected rendered Telegram approval presentation");
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
      "Approve?\n\n- Allow Always",
    );
    expect(options.buttons).toEqual([
      [{ text: "Allow Always", callback_data: `/approve ${approvalId} always` }],
    ]);
  });

  it("leaves long presentation text for Telegram chunking", () => {
    const text = "👍".repeat(5000);
    const presentation = adaptMessagePresentationForChannel({
      presentation: { blocks: [{ type: "text", text }] },
      capabilities: telegramOutbound.presentationCapabilities,
    });

    expect(presentation.blocks).toEqual([{ type: "text", text }]);
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

  it("normalizes legacy durable group retry targets before Telegram sends", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({
      messageId: "tg-group-retry",
      chatId: "-1001234567890",
    });

    await telegramOutbound.sendText!({
      cfg: {} as never,
      to: "group:-1001234567890",
      text: "retry reminder",
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    lastCallOptions(sendMessageTelegramMock, "-1001234567890", "retry reminder");
  });

  it("keeps numeric durable retry targets unchanged", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({
      messageId: "tg-direct-retry",
      chatId: "123456789",
    });

    await telegramOutbound.sendText!({
      cfg: {} as never,
      to: "123456789",
      text: "retry direct",
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    lastCallOptions(sendMessageTelegramMock, "123456789", "retry direct");
  });

  it("normalizes legacy durable group retry targets with topic suffixes", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({
      messageId: "tg-topic-retry",
      chatId: "-1001234567890",
    });

    await telegramOutbound.sendPayload!({
      cfg: {} as never,
      to: "group:-1001234567890:topic:77",
      text: "",
      payload: { text: "topic retry" },
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    lastCallOptions(sendMessageTelegramMock, "-1001234567890:topic:77", "topic retry");
  });

  it("does not make non-numeric legacy group targets look valid", async () => {
    sendMessageTelegramMock.mockResolvedValueOnce({
      messageId: "tg-invalid-retry",
      chatId: "group:not-a-number",
    });

    await telegramOutbound.sendText!({
      cfg: {} as never,
      to: "group:not-a-number",
      text: "bad retry target",
      deps: { sendTelegram: sendMessageTelegramMock },
    });

    lastCallOptions(sendMessageTelegramMock, "group:not-a-number", "bad retry target");
  });

  it("normalizes legacy durable group retry topic targets before Telegram polls", async () => {
    sendPollTelegramMock.mockResolvedValueOnce({
      messageId: "tg-poll-retry",
      chatId: "-1001234567890",
    });

    await telegramOutbound.sendPoll?.({
      cfg: {} as never,
      to: "group:-1001234567890:topic:77",
      poll: { question: "Retry?", options: ["Yes", "No"] },
      accountId: "ops",
    });

    expect(sendPollTelegramMock).toHaveBeenCalledWith(
      "-1001234567890:topic:77",
      { question: "Retry?", options: ["Yes", "No"] },
      {
        cfg: {},
        accountId: "ops",
        messageThreadId: undefined,
        silent: undefined,
        isAnonymous: undefined,
        gatewayClientScopes: undefined,
      },
    );
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
        formatting: { parseMode: "HTML", tableMode: "bullets" },
        deps: { sendTelegram: sendMessageTelegramMock },
      });
      const options = lastCallOptions(sendMessageTelegramMock, "12345", "hello");
      expect(options.textMode).toBe("html");
      expect(options.tableMode).toBe("bullets");
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
      gatewayClientScopes: ["operator.write"],
    });

    const options = callOptionsAt(pinMessageTelegramMock, 0, "12345", "tg-1");
    expect(options.accountId).toBe("ops");
    expect(options.notify).toBe(true);
    expect(options.verbose).toBe(false);
    expect(options.gatewayClientScopes).toEqual(["operator.write"]);
  });

  it("normalizes legacy durable group retry targets before Telegram pinning", async () => {
    pinMessageTelegramMock.mockResolvedValueOnce({
      ok: true,
      messageId: "tg-group-retry",
      chatId: "-1001234567890",
    });

    await telegramOutbound.pinDeliveredMessage?.({
      cfg: {} as never,
      target: { channel: "telegram", to: "group:-1001234567890", accountId: "ops" },
      messageId: "tg-group-retry",
      pin: { enabled: true, notify: false },
    });

    const options = callOptionsAt(pinMessageTelegramMock, 0, "-1001234567890", "tg-group-retry");
    expect(options.accountId).toBe("ops");
    expect(options.notify).toBe(false);
  });

  it("normalizes legacy durable group retry topic targets before Telegram pinning", async () => {
    pinMessageTelegramMock.mockResolvedValueOnce({
      ok: true,
      messageId: "tg-topic-retry",
      chatId: "-1001234567890",
    });

    await telegramOutbound.pinDeliveredMessage?.({
      cfg: {} as never,
      target: { channel: "telegram", to: "group:-1001234567890:topic:77", accountId: "ops" },
      messageId: "tg-topic-retry",
      pin: { enabled: true, notify: false },
    });

    const options = callOptionsAt(pinMessageTelegramMock, 0, "-1001234567890", "tg-topic-retry");
    expect(options.accountId).toBe("ops");
    expect(options.notify).toBe(false);
  });
});
