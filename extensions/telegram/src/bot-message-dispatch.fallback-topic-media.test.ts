import { describe, expect, it, vi } from "vitest";
import {
  describeTelegramDispatch,
  createBot,
  createContext,
  createDirectSessionPayload,
  deliverInboundReplyWithMessageSendContext,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchTelegramMessage,
  dispatchWithContext,
  generateTopicLabel,
  loadSessionStore,
  telegramDepsForTest,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage fallback-topic-media", () => {
  it("uses resolved DM config for auto-topic-label overrides", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({ queuedFinal: true });
    loadSessionStore.mockReturnValue({ s1: {} });
    const bot = createBot();

    await dispatchWithContext({
      bot,
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          RawBody: "Need help with invoices",
        } as TelegramMessageContext["ctxPayload"],
        groupConfig: {
          autoTopicLabel: false,
        } as TelegramMessageContext["groupConfig"],
      }),
      telegramCfg: { autoTopicLabel: true },
      cfg: {
        channels: {
          telegram: {
            direct: {
              "123": { autoTopicLabel: true },
            },
          },
        },
      },
    });

    expect(generateTopicLabel).not.toHaveBeenCalled();
    expect(bot.api["editForumTopic"]).not.toHaveBeenCalled();
  });

  it("truncates DM topic auto-rename input on UTF-16 boundaries", async () => {
    const sessionKey = "agent:default:telegram:direct:123";
    loadSessionStore.mockReturnValue({
      [sessionKey]: { sessionId: "s1", updatedAt: 1 },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({ queuedFinal: true });
    const bot = createBot();
    const base = "a".repeat(499);
    const rawBody = `${base}😀tail`;

    await dispatchWithContext({
      bot,
      context: createContext({
        ctxPayload: {
          SessionKey: sessionKey,
          RawBody: rawBody,
        } as TelegramMessageContext["ctxPayload"],
      }),
      telegramCfg: { autoTopicLabel: true },
    });

    await vi.waitFor(() => {
      expect(generateTopicLabel).toHaveBeenCalled();
    });
    const call = generateTopicLabel.mock.calls[0]?.[0] as { userMessage: string };
    expect(call.userMessage).toBe(base);
  });

  it("does not emit a silent-reply fallback when the dispatcher reports a queued final reply", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: true,
      counts: { block: 0, final: 1, tool: 0 },
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: createDirectSessionPayload(),
      }),
      streamMode: "off",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not emit a silent-reply fallback for no-response DM turns", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: createDirectSessionPayload(),
      }),
      streamMode: "off",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not emit an empty-response fallback for internal artifact skips", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      dispatcherOptions.onSkip?.({ text: "<channel|>" }, { kind: "final", reason: "silent" });
      return { queuedFinal: false, counts: { block: 0, final: 0, tool: 0 } };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: createDirectSessionPayload(),
      }),
      streamMode: "off",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not emit a silent-reply fallback for no-response group turns", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });

    await dispatchWithContext({
      context: createContext({
        chatId: -1001234,
        isGroup: true,
        ctxPayload: {
          SessionKey: "agent:test:telegram:group:-1001234",
          ChatType: "group",
        } as TelegramMessageContext["ctxPayload"],
        primaryCtx: {
          message: { chat: { id: -1001234, type: "supergroup" } },
        } as TelegramMessageContext["primaryCtx"],
        msg: {
          chat: { id: -1001234, type: "supergroup" },
          message_id: 456,
        } as TelegramMessageContext["msg"],
        threadSpec: { id: undefined, scope: "none" },
        replyThreadId: undefined,
      }),
      cfg: {
        agents: {
          defaults: {
            silentReply: {
              group: "disallow",
              internal: "allow",
            },
          },
        },
      } as Parameters<typeof dispatchTelegramMessage>[0]["cfg"],
      streamMode: "off",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
  });

  describe("non-streaming media dedup", () => {
    const finalDeliveryPayload = () => {
      for (const [params] of deliverInboundReplyWithMessageSendContext.mock.calls) {
        if (params.info.kind === "final") {
          return params.payload;
        }
      }
      throw new Error("missing final delivery");
    };

    it("deduplicates block-sent media from final reply", async () => {
      deliverReplies.mockResolvedValue({ delivered: true });
      deliverInboundReplyWithMessageSendContext.mockResolvedValue({
        status: "handled_visible",
        delivery: { messageIds: ["101"], visibleReplySent: true },
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ mediaUrls: ["/tmp/cat.jpg"] }, { kind: "block" });
        await dispatcherOptions.deliver(
          { text: "Here is the image", mediaUrls: ["/tmp/cat.jpg"] },
          { kind: "final" },
        );
        return { queuedFinal: true };
      });

      await dispatchWithContext({
        context: createContext(),
        streamMode: "off",
        telegramDeps: telegramDepsForTest,
      });

      expect(finalDeliveryPayload().mediaUrls).toEqual([]);
    });

    it("preserves final media when block delivery reports no visible send", async () => {
      deliverReplies.mockResolvedValueOnce({ delivered: false });
      deliverReplies.mockResolvedValue({ delivered: true });
      deliverInboundReplyWithMessageSendContext.mockResolvedValue({
        status: "handled_visible",
        delivery: { messageIds: ["101"], visibleReplySent: true },
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ mediaUrls: ["/tmp/cat.jpg"] }, { kind: "block" });
        await dispatcherOptions.deliver(
          { text: "Here is the image", mediaUrls: ["/tmp/cat.jpg"] },
          { kind: "final" },
        );
        return { queuedFinal: true };
      });

      await dispatchWithContext({
        context: createContext(),
        streamMode: "off",
        telegramDeps: telegramDepsForTest,
      });

      expect(finalDeliveryPayload().mediaUrls).toEqual(["/tmp/cat.jpg"]);
    });

    it("preserves final media when block delivery fails", async () => {
      deliverReplies.mockRejectedValueOnce(new Error("Telegram API error"));
      deliverReplies.mockResolvedValue({ delivered: true });
      deliverInboundReplyWithMessageSendContext.mockResolvedValue({
        status: "handled_visible",
        delivery: { messageIds: ["101"], visibleReplySent: true },
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
        try {
          await dispatcherOptions.deliver({ mediaUrls: ["/tmp/cat.jpg"] }, { kind: "block" });
        } catch {}
        await dispatcherOptions.deliver(
          { text: "Here is the image", mediaUrls: ["/tmp/cat.jpg"] },
          { kind: "final" },
        );
        return { queuedFinal: true };
      });

      await dispatchWithContext({
        context: createContext(),
        streamMode: "off",
        telegramDeps: telegramDepsForTest,
      });

      expect(finalDeliveryPayload().mediaUrls).toEqual(["/tmp/cat.jpg"]);
    });
  });
});
