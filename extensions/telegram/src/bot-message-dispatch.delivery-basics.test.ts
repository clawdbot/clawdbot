import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import {
  describeTelegramDispatch,
  createContext,
  createDraftStream,
  createTelegramDraftStream,
  deliverInboundReplyWithMessageSendContext,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  expectDeliverRepliesParams,
  expectDraftStreamParams,
  expectRecordFields,
  mockCallArg,
  mockDefaultSessionEntry,
  readLatestAssistantTextByIdentity,
  recordOutboundMessageForPromptContext,
  setupDraftStreams,
  telegramDepsForTest,
} from "./bot-message-dispatch.test-harness.js";
import type {
  TelegramBotDeps,
  TelegramMessageContext,
} from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage delivery-basics", () => {
  it("queues final Telegram replies through outbound delivery when available", async () => {
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["1001"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello queued" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          ChatType: "direct",
          SenderId: "42",
          SenderName: "Alice",
          SenderUsername: "alice",
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "off",
      telegramDeps: telegramDepsForTest,
    });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      channel: "telegram",
      to: "123",
      accountId: "default",
      info: { kind: "final" },
      replyToMode: "first",
      threadId: 777,
      agentId: "default",
    });
    expectRecordFields(outbound.payload, { text: "Hello queued" });
    expectRecordFields(outbound.formatting, { textLimit: 4096, tableMode: "preserve" });
    expectRecordFields(outbound.ctxPayload, {
      SessionKey: "s1",
      ChatType: "direct",
      SenderId: "42",
      SenderName: "Alice",
      SenderUsername: "alice",
    });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("canonicalizes mixed presentation finals before durable stream-off delivery", async () => {
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: { messageIds: ["1002"], visibleReplySent: true },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "Quarterly results",
          presentation: {
            title: "FY25 outlook",
            blocks: [
              { type: "text", text: "Executive summary" },
              { type: "context", text: "Unaudited" },
              {
                type: "chart",
                chartType: "pie",
                title: "Revenue mix",
                segments: [
                  { label: "Product", value: 60 },
                  { label: "Services", value: 40 },
                ],
              },
              {
                type: "table",
                caption: "Pipeline",
                headers: ["Account", "Stage"],
                rows: [["Acme", "Won"]],
              },
              { type: "buttons", buttons: [{ label: "Refresh", value: "refresh" }] },
            ],
          },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
      telegramDeps: telegramDepsForTest,
    });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {});
    const payload = expectRecordFields(outbound.payload, {
      text: [
        "Quarterly results",
        "FY25 outlook",
        "Executive summary",
        "Unaudited",
        "Revenue mix (pie chart)\n- Product: 60\n- Services: 40",
        "Pipeline (table)\n- Account: Acme; Stage: Won",
      ].join("\n\n"),
    });
    expect(payload.presentation).toBeUndefined();
    expect(payload.text).not.toContain("Refresh");
    expectRecordFields(payload.channelData, {
      telegram: { buttons: [[{ text: "Refresh", callback_data: "refresh" }]] },
    });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("keeps control-only finals deliverable through durable stream-off delivery", async () => {
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: { messageIds: ["1003"], visibleReplySent: true },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          presentation: {
            blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "retry" }] }],
          },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
      telegramDeps: telegramDepsForTest,
    });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {});
    const payload = expectRecordFields(outbound.payload, { text: "Choose an option." });
    expect(payload.presentation).toBeUndefined();
    expectRecordFields(payload.channelData, {
      telegram: { buttons: [[{ text: "Retry", callback_data: "retry" }]] },
    });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("queues media-only final Telegram replies through outbound delivery when available", async () => {
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["1002"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ mediaUrl: "file:///tmp/final.png" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
      telegramDeps: telegramDepsForTest,
    });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      channel: "telegram",
      info: { kind: "final" },
    });
    expectRecordFields(outbound.payload, { mediaUrl: "file:///tmp/final.png" });
    expectRecordFields(outbound.requiredCapabilities, { media: true, payload: true });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("suppresses text-only tool output after media-only final Telegram replies", async () => {
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["1002"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ mediaUrl: "file:///tmp/final.png" }, { kind: "final" });
      await dispatcherOptions.deliver({ text: "late tool output" }, { kind: "tool" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
      telegramDeps: telegramDepsForTest,
    });

    expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledTimes(1);
    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      channel: "telegram",
      info: { kind: "final" },
    });
    expectRecordFields(outbound.payload, { mediaUrl: "file:///tmp/final.png" });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("skips answer draft stream for same-chat selected quotes", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello", replyToId: "1001" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        msg: {
          message_id: 1001,
        } as unknown as TelegramMessageContext["msg"],
        ctxPayload: {
          MessageSid: "1001",
          ReplyToId: "9001",
          ReplyToBody: "quoted slice",
          ReplyToQuoteText: " quoted slice\n",
          ReplyToIsQuote: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    const delivery = expectDeliverRepliesParams({
      replyQuoteMessageId: 9001,
      replyQuoteText: " quoted slice\n",
    });
    expectRecordFields((delivery.replies as Array<unknown>)[0], { replyToId: "9001" });
  });

  it("keeps bot-reply answers anchored to the current user message", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello", replyToId: "1001" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        msg: {
          message_id: 1001,
          reply_to_message: {
            message_id: 9001,
            from: { is_bot: true },
          },
        } as unknown as TelegramMessageContext["msg"],
        ctxPayload: {
          MessageSid: "1001",
          ReplyToId: "9001",
          ReplyToBody: "quoted bot reply",
          ReplyToQuoteText: " quoted bot reply\n",
          ReplyToIsQuote: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    const delivery = expectDeliverRepliesParams({
      replyQuoteMessageId: 9001,
      replyQuoteText: " quoted bot reply\n",
    });
    expectRecordFields((delivery.replies as Array<unknown>)[0], { replyToId: "1001" });
  });

  it("keeps answer draft stream for current message replies with native quote candidates", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello", replyToId: "1001" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        msg: {
          message_id: 1001,
          text: "Original current message",
          entities: [{ type: "bold", offset: 0, length: 8 }],
        } as unknown as TelegramMessageContext["msg"],
        ctxPayload: {
          MessageSid: "1001",
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    expectDraftStreamParams({ replyToMessageId: 1001, replyToMode: "first" });
    const delivery = expectDeliverRepliesParams({
      replyQuoteByMessageId: {
        "1001": {
          text: "Original current message",
          position: 0,
          entities: [{ type: "bold", offset: 0, length: 8 }],
        },
      },
    });
    expectRecordFields((delivery.replies as Array<unknown>)[0], { replyToId: "1001" });
  });

  it("passes native quote candidates for explicit reply targets", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello", replyToId: "9001" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          ReplyToId: "9001",
          ReplyToBody: "trimmed body",
          ReplyToQuoteSourceText: "  exact reply body",
          ReplyToQuoteSourceEntities: [{ type: "italic", offset: 2, length: 5 }],
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    const delivery = expectDeliverRepliesParams({
      replyQuoteByMessageId: {
        "9001": {
          text: "  exact reply body",
          position: 0,
          entities: [{ type: "italic", offset: 2, length: 5 }],
        },
      },
    });
    expectRecordFields((delivery.replies as Array<unknown>)[0], { replyToId: "9001" });
  });

  it("replaces a materialized current-message preview when the final quotes another message", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    answerDraftStream.hasConsumedReplyTarget.mockReturnValue(true);
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-native-quote-overflow",
      text: "Quoted final",
      timestamp: Date.now() + 1_000,
    });
    deliverReplies.mockImplementation(async (params: Record<string, unknown>) => {
      const [reply] = params.replies as Array<{ replyToId?: string; text?: string }>;
      const sequence = params.promptContextSequence as
        | { accept(message: { messageId: number; text?: string }): Promise<void> }
        | undefined;
      await sequence?.accept({ messageId: 2002, text: reply?.text });
      return { delivered: true };
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Working preview" });
        const streamParams = mockCallArg(createTelegramDraftStream) as Parameters<
          NonNullable<TelegramBotDeps["createTelegramDraftStream"]>
        >[0];
        streamParams.onRetainedPage?.({
          messageId: 1999,
          textSnapshot: "Retained preview",
        });
        await dispatcherOptions.deliver(
          { text: "Quoted final", replyToId: "9001" },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext({
        msg: {
          message_id: 1001,
          text: "Current request",
        } as unknown as TelegramMessageContext["msg"],
        ctxPayload: {
          MessageSid: "1001",
          SessionKey: "agent:default:telegram:direct:123",
          ReplyToId: "9001",
          ReplyToBody: "older source",
          ReplyToQuoteSourceText: "Exact older source",
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    expect(answerDraftStream.update).toHaveBeenCalledWith("Working preview");
    expect(answerDraftStream.update).not.toHaveBeenCalledWith("Quoted final");
    expect(answerDraftStream.clear).toHaveBeenCalled();
    const delivery = expectDeliverRepliesParams({
      replyQuoteByMessageId: expect.objectContaining({
        "9001": { text: "Exact older source", position: 0 },
      }),
    });
    expectRecordFields((delivery.replies as Array<unknown>)[0], {
      text: "Quoted final",
      replyToId: "9001",
    });
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(recordOutboundMessageForPromptContext).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext, 0), {
      messageId: 1999,
      text: "Retained preview",
      promptContextProjection: {
        transcriptMessageId: "assistant-native-quote-overflow",
        partIndex: 0,
        finalPart: false,
      },
    });
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext, 1), {
      messageId: 2002,
      text: "Quoted final",
      promptContextProjection: {
        transcriptMessageId: "assistant-native-quote-overflow",
        partIndex: 1,
        finalPart: true,
      },
    });
  });

  it.each([
    { replyToMode: "first" as const, expectedFallbackMode: "off", keepsReply: false },
    { replyToMode: "batched" as const, expectedFallbackMode: "off", keepsReply: false },
    { replyToMode: "all" as const, expectedFallbackMode: "all", keepsReply: true },
  ])(
    "uses reply mode $replyToMode after retained pagination falls back to its suffix",
    async ({ replyToMode, expectedFallbackMode, keepsReply }) => {
      const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
      answerDraftStream.remainingFinalContent.mockReturnValue({
        text: "unsent suffix",
        sourceText: "unsent suffix",
        sourceTextMode: "html",
      });
      const finalText = "visible prefixunsent suffix";
      mockDefaultSessionEntry();
      readLatestAssistantTextByIdentity.mockResolvedValue({
        id: `assistant-retained-${replyToMode}`,
        text: finalText,
        timestamp: Date.now() + 1_000,
      });
      deliverReplies.mockImplementation(async (params: Record<string, unknown>) => {
        const [reply] = params.replies as Array<{ text?: string }>;
        const sequence = params.promptContextSequence as
          | { accept(message: { messageId: number; text?: string }): Promise<void> }
          | undefined;
        await sequence?.accept({ messageId: 2002, text: reply?.text });
        return { delivered: true };
      });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onPartialReply?.({ text: "visible prefix" });
          const streamParams = mockCallArg(createTelegramDraftStream) as Parameters<
            NonNullable<TelegramBotDeps["createTelegramDraftStream"]>
          >[0];
          streamParams.onRetainedPage?.({
            messageId: 1999,
            textSnapshot: "visible prefix",
          });
          await dispatcherOptions.deliver(
            { text: finalText, replyToId: "1001" },
            { kind: "final" },
          );
          return { queuedFinal: true };
        },
      );

      await dispatchWithContext({
        context: createContext({
          msg: {
            message_id: 1001,
            text: "Current request",
          } as unknown as TelegramMessageContext["msg"],
          ctxPayload: {
            MessageSid: "1001",
            SessionKey: "agent:default:telegram:direct:123",
          } as unknown as TelegramMessageContext["ctxPayload"],
        }),
        replyToMode,
      });

      const fallback = expectDeliverRepliesParams({ replyToMode: expectedFallbackMode });
      const fallbackPayload = expectDefined(
        (fallback.replies as Array<Record<string, unknown>>)[0],
        "unsent suffix fallback payload",
      );
      expect(fallbackPayload.text).toBe("unsent suffix");
      if (keepsReply) {
        expect(fallbackPayload.replyToId).toBe("1001");
      } else {
        expect(fallbackPayload).not.toHaveProperty("replyToId");
      }
    },
  );

  it.each([
    { replyToMode: "first" as const, expectedFallbackMode: "off", keepsReply: false },
    { replyToMode: "batched" as const, expectedFallbackMode: "off", keepsReply: false },
    { replyToMode: "all" as const, expectedFallbackMode: "all", keepsReply: true },
  ])(
    "uses reply mode $replyToMode when an accepted one-page draft falls back",
    async ({ replyToMode, expectedFallbackMode, keepsReply }) => {
      const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
      answerDraftStream.lastDeliveredText.mockReturnValue("visible preview");
      answerDraftStream.hasConsumedReplyTarget.mockReturnValue(true);
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onPartialReply?.({ text: "visible preview" });
          await dispatcherOptions.deliver(
            { text: "final replacement", replyToId: "1001" },
            { kind: "final" },
          );
          return { queuedFinal: true };
        },
      );

      await dispatchWithContext({
        context: createContext({
          msg: { message_id: 1001, text: "Current request" } as TelegramMessageContext["msg"],
          ctxPayload: { MessageSid: "1001" } as TelegramMessageContext["ctxPayload"],
        }),
        replyToMode,
      });

      expect(answerDraftStream.clear).toHaveBeenCalled();
      const fallback = expectDeliverRepliesParams({ replyToMode: expectedFallbackMode });
      const fallbackPayload = expectDefined(
        (fallback.replies as Array<Record<string, unknown>>)[0],
        "accepted draft fallback payload",
      );
      expect(fallbackPayload.text).toBe("final replacement");
      if (keepsReply) {
        expect(fallbackPayload.replyToId).toBe("1001");
      } else {
        expect(fallbackPayload).not.toHaveProperty("replyToId");
      }
    },
  );

  it.each([
    { replyToMode: "first" as const, expectedMediaMode: "off", keepsReply: false },
    { replyToMode: "batched" as const, expectedMediaMode: "off", keepsReply: false },
    { replyToMode: "all" as const, expectedMediaMode: "all", keepsReply: true },
  ])(
    "uses reply mode $replyToMode for media after an accepted draft",
    async ({ replyToMode, expectedMediaMode, keepsReply }) => {
      setupDraftStreams({ answerMessageId: 2001 });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onPartialReply?.({ text: "photo" });
          await dispatcherOptions.deliver(
            { text: "photo", mediaUrl: "https://example.com/a.png", replyToId: "1001" },
            { kind: "final" },
          );
          return { queuedFinal: true };
        },
      );

      await dispatchWithContext({
        context: createContext({
          msg: { message_id: 1001, text: "Current request" } as TelegramMessageContext["msg"],
          ctxPayload: { MessageSid: "1001" } as TelegramMessageContext["ctxPayload"],
        }),
        replyToMode,
      });

      const media = expectDeliverRepliesParams({ replyToMode: expectedMediaMode });
      const mediaPayload = expectDefined(
        (media.replies as Array<Record<string, unknown>>)[0],
        "accepted draft media payload",
      );
      expect(mediaPayload.mediaUrl).toBe("https://example.com/a.png");
      if (keepsReply) {
        expect(mediaPayload.replyToId).toBe("1001");
      } else {
        expect(mediaPayload).not.toHaveProperty("replyToId");
      }
    },
  );
});
