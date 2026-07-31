import { expect, it, vi } from "vitest";
import {
  describeTelegramDispatch,
  createContext,
  createDraftStream,
  createTelegramDraftStream,
  deliverInboundReplyWithMessageSendContext,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  expectDeliveredReply,
  expectDeliverRepliesParams,
  expectDraftStreamParams,
  expectRecordFields,
  mockCallArg,
  mockDefaultSessionEntry,
  readLatestAssistantTextByIdentity,
  recordOutboundMessageForPromptContext,
  setupDraftStreams,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";
import { createTelegramMessageCache, resolveTelegramMessageCacheScope } from "./message-cache.js";
import {
  recordOutboundMessageForPromptContext as recordOutboundMessageForPromptContextActual,
  registerTelegramOutboundGroupHistoryRecorder,
} from "./outbound-message-context.js";

describeTelegramDispatch("dispatchTelegramMessage reply-targets", () => {
  it("does not build native quote candidates when reply mode is off", async () => {
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
        } as unknown as TelegramMessageContext["msg"],
        ctxPayload: {
          MessageSid: "1001",
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      replyToMode: "off",
    });

    expect(expectDeliverRepliesParams({})).not.toHaveProperty("replyQuoteByMessageId.1001");
  });

  it("keeps answer draft stream for selected quotes when reply mode is off", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({ queuedFinal: true });

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
      replyToMode: "off",
    });

    expectDraftStreamParams({ replyToMessageId: undefined });
  });

  it("passes same-chat quoted reply target id with Telegram quote text", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello", replyToId: "1001" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          MessageSid: "1001",
          ReplyToId: "9001",
          ReplyToBody: "quoted slice",
          ReplyToQuoteText: " quoted slice\n",
          ReplyToIsQuote: true,
          ReplyToQuotePosition: 12,
          ReplyToQuoteEntities: [{ type: "italic", offset: 0, length: 6 }],
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "off",
    });

    const delivery = expectDeliverRepliesParams({
      replyQuoteMessageId: 9001,
      replyQuoteText: " quoted slice\n",
      replyQuotePosition: 12,
      replyQuoteEntities: [{ type: "italic", offset: 0, length: 6 }],
    });
    expectRecordFields((delivery.replies as Array<unknown>)[0], { replyToId: "9001" });
  });

  it("does not pass a native quote target for external replies", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Hello", replyToId: "1001" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          MessageSid: "1001",
          ReplyToId: "9001",
          ReplyToBody: "external quoted slice",
          ReplyToQuoteText: " external quoted slice\n",
          ReplyToIsQuote: true,
          ReplyToIsExternal: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "off",
    });

    const params = expectDeliverRepliesParams({ replyQuoteText: " external quoted slice\n" });
    expectRecordFields((params.replies as Array<unknown>)[0], { replyToId: "1001" });
    expect(params?.replyQuoteMessageId).toBeUndefined();
  });

  it("does not inject approval buttons in local dispatch once the monitor owns approvals", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "Mode: foreground\nRun: /approve 117ba06d allow-once (or allow-always / deny).",
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "off",
      cfg: {
        channels: {
          telegram: {
            execApprovals: {
              enabled: true,
              approvers: ["123"],
              target: "dm",
            },
          },
        },
      },
    });

    const deliveredPayload = expectDeliveredReply(0, {
      text: "Mode: foreground\nRun: /approve 117ba06d allow-once (or allow-always / deny).",
    }) as { channelData?: unknown };
    expect(deliveredPayload.channelData).toBeUndefined();
  });

  it("uses 30-char stream debounce for legacy block stream mode", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Hello" });
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), streamMode: "block" });

    expectDraftStreamParams({ minInitialChars: 30 });
  });

  it("keeps canonical block mode on the Telegram draft stream path", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "HelloWorld" });
        await dispatcherOptions.deliver({ text: "HelloWorld" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "block",
      telegramCfg: { streaming: { mode: "block" } },
    });

    expect(createTelegramDraftStream).toHaveBeenCalled();
    expect(draftStream.update).toHaveBeenCalledWith("HelloWorld");
  });

  it("sizes block-mode preview chunks from streaming.preview.chunk", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "Hello" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "block",
      cfg: {
        channels: {
          telegram: { streaming: { preview: { chunk: { minChars: 100, maxChars: 600 } } } },
        },
      },
      telegramCfg: { streaming: { mode: "block" } },
    });

    expectDraftStreamParams({ maxChars: 600 });
  });

  it("uses the shared block chunk default when block mode has no chunk config", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "Hello" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "block",
      telegramCfg: { streaming: { mode: "block" } },
    });

    expectDraftStreamParams({ maxChars: 800 });
  });

  it("marks durable non-preview finals with their transcript source", async () => {
    const transcriptTimestamp = Date.now() + 1_000;
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-final-1",
      text: "Final answer",
      timestamp: transcriptTimestamp,
    });
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["2001"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context, streamMode: "off" });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      payload: expect.objectContaining({ text: "Final answer" }),
    });
    expectRecordFields(expectRecordFields(outbound.payload, {}).channelData, {
      telegram: {
        promptContextSource: {
          transcriptMessageId: "assistant-final-1",
          deliverySignature: '["Final answer",[],false,""]',
        },
      },
    });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("correlates directive-tagged durable finals without rendering Markdown", async () => {
    const transcriptTimestamp = Date.now() + 1_000;
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-final-2",
      text: "[[reply_to_current]]Final answer",
      timestamp: transcriptTimestamp,
    });
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["2001"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context, streamMode: "off" });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      payload: expect.objectContaining({ text: "Final answer" }),
    });
    expectRecordFields(expectRecordFields(outbound.payload, {}).channelData, {
      telegram: {
        promptContextSource: {
          transcriptMessageId: "assistant-final-2",
          deliverySignature: '["Final answer",[],false,""]',
        },
      },
    });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("binds identical sequential finals to their fresh transcript identities", async () => {
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity
      .mockResolvedValueOnce({
        id: "assistant-repeat-a",
        text: "Same answer",
        timestamp: Date.now() + 1_000,
      })
      .mockResolvedValueOnce({
        id: "assistant-repeat-b",
        text: "Same answer",
        timestamp: Date.now() + 2_000,
      });
    let messageId = 2050;
    deliverReplies.mockImplementation(async (params: Record<string, unknown>) => {
      const sequence = params.promptContextSequence as
        | { accept(message: { messageId: number; text: string }): Promise<void> }
        | undefined;
      await sequence?.accept({ messageId, text: "Same answer" });
      messageId += 1;
      return { delivered: true };
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Same answer" }, { kind: "final" });
      await dispatcherOptions.deliver({ text: "Same answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context, streamMode: "off" });

    expect(readLatestAssistantTextByIdentity).toHaveBeenCalledTimes(2);
    expect(recordOutboundMessageForPromptContext).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext, 0), {
      promptContextProjection: {
        transcriptMessageId: "assistant-repeat-a",
        partIndex: 0,
        finalPart: true,
      },
    });
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext, 1), {
      promptContextProjection: {
        transcriptMessageId: "assistant-repeat-b",
        partIndex: 0,
        finalPart: true,
      },
    });
  });

  it("does not bind a multipart final when its one transcript snapshot misses", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2100 });
    const finalText = `${"A".repeat(3_900)}\n\n${"B".repeat(3_900)}\n\n${"C".repeat(3_900)}`;
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValueOnce(undefined).mockResolvedValue({
      id: "assistant-arrived-too-late",
      text: finalText,
      timestamp: Date.now() + 1_000,
    });
    let nextMessageId = 2101;
    deliverReplies.mockImplementation(async (params: Record<string, unknown>) => {
      const [reply] = params.replies as Array<{ text?: string }>;
      const sequence = params.promptContextSequence as
        | { accept(message: { messageId: number; text?: string }): Promise<void> }
        | undefined;
      await sequence?.accept({ messageId: nextMessageId, text: reply?.text });
      nextMessageId += 1;
      return { delivered: true };
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: finalText }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    expect(answerDraftStream.update).toHaveBeenCalled();
    expect(readLatestAssistantTextByIdentity).toHaveBeenCalledTimes(1);
    expect(recordOutboundMessageForPromptContext).toHaveBeenCalledTimes(1);
    for (const [record] of recordOutboundMessageForPromptContext.mock.calls) {
      expect(record).not.toHaveProperty("promptContextProjection");
    }
  });

  it("records native-quote direct fallback sends as one complete projection", async () => {
    const transcriptTimestamp = Date.now() + 1_000;
    const context = createContext({
      ctxPayload: {
        MessageSid: "1001",
        SessionKey: "agent:default:telegram:direct:123",
        ReplyToId: "9001",
        ReplyToQuoteText: " quoted slice\n",
        ReplyToIsQuote: true,
      } as unknown as TelegramMessageContext["ctxPayload"],
    });
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-native-quote",
      text: "Final answer",
      timestamp: transcriptTimestamp,
    });
    const groupHistoryRecorder = vi.fn();
    const unregisterGroupHistoryRecorder = registerTelegramOutboundGroupHistoryRecorder({
      accountId: "default",
      recorder: groupHistoryRecorder,
    });
    recordOutboundMessageForPromptContext.mockImplementation(
      recordOutboundMessageForPromptContextActual,
    );
    deliverReplies.mockImplementation(async (params: Record<string, unknown>) => {
      const sequence = params.promptContextSequence as
        | { accept(message: { messageId: number; text: string }): Promise<void> }
        | undefined;
      await sequence?.accept({ messageId: 2001, text: "Final answer" });
      return { delivered: true };
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "Final answer", replyToId: "1001" },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    try {
      await dispatchWithContext({ context, streamMode: "off" });
    } finally {
      unregisterGroupHistoryRecorder();
    }

    expect(deliverInboundReplyWithMessageSendContext).toHaveBeenCalledTimes(1);
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expect(recordOutboundMessageForPromptContext).toHaveBeenCalledTimes(1);
    expect(groupHistoryRecorder).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext, 0), {
      messageId: 2001,
      text: "Final answer",
      promptContextProjection: {
        transcriptMessageId: "assistant-native-quote",
        partIndex: 0,
        finalPart: true,
      },
    });
  });

  it.each([
    {
      name: "captioned media",
      transcriptText: "Photo\nMEDIA:/tmp/reply-image.png",
      payload: { text: "Photo", mediaUrl: "/tmp/reply-image.png", replyToId: "1001" },
      deliveredText: "Photo",
    },
    {
      name: "media-only",
      transcriptText: "MEDIA:/tmp/reply-image.png",
      payload: { mediaUrl: "/tmp/reply-image.png", replyToId: "1001" },
      deliveredText: undefined,
    },
  ])("correlates $name after MEDIA directive normalization", async (testCase) => {
    const storePath = `/tmp/openclaw-telegram-direct-media-${process.pid}-${testCase.name}.json`;
    const context = createContext({
      ctxPayload: {
        MessageSid: "1001",
        SessionKey: "agent:default:telegram:direct:123",
        ReplyToId: "9001",
        ReplyToQuoteText: " quoted slice\n",
        ReplyToIsQuote: true,
      } as unknown as TelegramMessageContext["ctxPayload"],
    });
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: `assistant-${testCase.name}`,
      text: testCase.transcriptText,
      timestamp: Date.now() + 1_000,
    });
    const mediaMessage = {
      message_id: 2002,
      date: 1_779_425_460,
      chat: { id: 123, type: "private" as const },
      from: { id: 999, is_bot: true, first_name: "OpenClaw" },
      photo: [{ file_id: "photo-file", file_unique_id: "photo-unique", width: 10, height: 10 }],
    };
    deliverReplies.mockImplementation(async (params: Record<string, unknown>) => {
      const sequence = params.promptContextSequence as
        | {
            accept(message: {
              messageId: number;
              message: typeof mediaMessage;
              text?: string;
            }): Promise<void>;
          }
        | undefined;
      await sequence?.accept({
        messageId: mediaMessage.message_id,
        message: mediaMessage,
        text: testCase.deliveredText,
      });
      return { delivered: true };
    });
    recordOutboundMessageForPromptContext.mockImplementation(
      recordOutboundMessageForPromptContextActual,
    );
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(testCase.payload, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context,
      streamMode: "off",
      cfg: { session: { store: storePath } },
    });

    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext), {
      messageId: 2002,
      message: mediaMessage,
      ...(testCase.deliveredText ? { text: testCase.deliveredText } : {}),
      promptContextProjection: {
        transcriptMessageId: `assistant-${testCase.name}`,
        partIndex: 0,
        finalPart: true,
      },
    });
    const cached = await createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    }).get({ accountId: "default", chatId: "123", messageId: "2002" });
    expect(cached).toMatchObject({
      mediaRef: "telegram:file/photo-file",
      mediaType: "image",
      promptContextProjectionMarker: {
        kind: "valid",
        projection: {
          transcriptMessageId: `assistant-${testCase.name}`,
          partIndex: 0,
          finalPart: true,
        },
      },
    });
  });
});
