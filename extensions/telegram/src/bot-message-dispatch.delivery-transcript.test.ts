import { expect, it, vi } from "vitest";
import {
  describeTelegramDispatch,
  appendAssistantMirrorMessageByIdentity,
  createContext,
  createDraftStream,
  createTelegramDraftStream,
  deliverInboundReplyWithMessageSendContext,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
  emitInternalMessageSentHook,
  expectDraftStreamParams,
  expectRecordFields,
  loadSessionStore,
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
import {
  buildTelegramConversationContext,
  createTelegramMessageCache,
  resolveTelegramMessageCacheScope,
} from "./message-cache.js";
import { recordOutboundMessageForPromptContext as recordOutboundMessageForPromptContextActual } from "./outbound-message-context.js";

describeTelegramDispatch("dispatchTelegramMessage delivery-transcript", () => {
  it("keeps the Telegram edit cap for non-block previews regardless of chunk config", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onPartialReply?.({ text: "Hello" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      cfg: {
        channels: {
          telegram: { streaming: { preview: { chunk: { maxChars: 600 } } } },
        },
      },
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expectDraftStreamParams({ maxChars: 4000 });
  });

  it("streams text-only finals into the answer message", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const transcriptTimestamp = Date.now() + 1_000;
    const context = createContext({
      primaryCtx: {
        me: {
          id: 999,
          is_bot: true,
          first_name: "Telegram Bot Name",
          username: "openclaw_bot",
        },
      } as TelegramMessageContext["primaryCtx"],
    });
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-stream-1",
      text: "Final answer",
      timestamp: transcriptTimestamp,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    expect(answerDraftStream.update).toHaveBeenCalledWith("Final answer");
    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(emitInternalMessageSentHook), {
      content: "Final answer",
      messageId: 2001,
    });
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext), {
      account: {
        accountId: "default",
        bot: {
          id: 999,
          is_bot: true,
          first_name: "Telegram Bot Name",
          username: "openclaw_bot",
        },
      },
      chatId: "123",
      messageId: 2001,
      text: "Final answer",
      messageThreadId: 777,
      promptContextProjection: {
        transcriptMessageId: "assistant-stream-1",
        partIndex: 0,
        finalPart: true,
      },
    });
  });

  it("projects retained draft pages and the active tail as one complete sequence", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2100 });
    answerDraftStream.currentMessageSnapshot.mockReturnValue({
      text: "page 2",
      sourceText: "page 2",
    });
    const finalText = "page 0page 1page 2";
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-stream-multipart",
      text: finalText,
      timestamp: Date.now() + 1_000,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      const streamParams = mockCallArg(createTelegramDraftStream) as Parameters<
        NonNullable<TelegramBotDeps["createTelegramDraftStream"]>
      >[0];
      streamParams.onRetainedPage?.({
        messageId: 2098,
        textSnapshot: "page 0",
      });
      streamParams.onRetainedPage?.({
        messageId: 2099,
        textSnapshot: "page 1",
      });
      await dispatcherOptions.deliver({ text: finalText }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    expect(answerDraftStream.update).toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    const effectiveByMessageId = new Map<
      number,
      {
        text?: string;
        projection: { transcriptMessageId: string; partIndex: number; finalPart: boolean };
      }
    >();
    for (const [rawRecord] of recordOutboundMessageForPromptContext.mock.calls) {
      const record = rawRecord as {
        messageId: number;
        text?: string;
        promptContextProjection?: {
          transcriptMessageId: string;
          partIndex: number;
          finalPart: boolean;
        };
      };
      if (record.promptContextProjection) {
        effectiveByMessageId.set(record.messageId, {
          text: record.text,
          projection: record.promptContextProjection,
        });
      }
    }
    const records = Array.from(effectiveByMessageId.values()).toSorted(
      (left, right) => left.projection.partIndex - right.projection.partIndex,
    );
    expect(records.map((record) => record.text)).toEqual(["page 0", "page 1", "page 2"]);
    const projections = records.map((record) => record.projection);
    expect(projections.map((projection) => projection.partIndex)).toEqual(
      projections.map((_, index) => index),
    );
    expect(projections.map((projection) => projection.finalPart)).toEqual([
      ...Array.from({ length: projections.length - 1 }, () => false),
      true,
    ]);
    expect(
      projections.every(
        (projection) => projection.transcriptMessageId === "assistant-stream-multipart",
      ),
    ).toBe(true);
  });

  it("records streamed final replies into the prompt context cache", async () => {
    const storePath = `/tmp/openclaw-telegram-stream-context-${process.pid}-${Date.now()}.json`;
    const transcriptTimestamp = Date.now() + 1_000;
    const context = createContext({
      primaryCtx: {
        me: {
          id: 999,
          is_bot: true,
          first_name: "Telegram Bot Name",
          username: "openclaw_bot",
        },
      } as TelegramMessageContext["primaryCtx"],
    });
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-stream-2",
      text: "Done already: timeoutSeconds is now 7200s.",
      timestamp: transcriptTimestamp,
    });
    setupDraftStreams({ answerMessageId: 1497 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "Done already: timeoutSeconds is now 7200s." },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context,
      cfg: { session: { store: storePath } },
      telegramCfg: { name: "Configured Agent" },
      telegramDeps: {
        ...telegramDepsForTest,
        recordOutboundMessageForPromptContext: recordOutboundMessageForPromptContextActual,
      },
    });

    const cache = createTelegramMessageCache({
      scope: resolveTelegramMessageCacheScope(storePath),
    });
    await cache.record({
      accountId: "default",
      chatId: "123",
      threadId: 777,
      msg: {
        chat: { id: 123, type: "private", first_name: "Keshav" },
        message_thread_id: 777,
        message_id: 1521,
        date: 1_779_425_460,
        text: "Did all Amazon crons run fine",
        from: { id: 5185575566, is_bot: false, first_name: "Keshav" },
      },
    });

    const conversationContext = await buildTelegramConversationContext({
      cache,
      accountId: "default",
      chatId: "123",
      threadId: 777,
      messageId: "1521",
      replyChainNodes: [],
      recentLimit: 10,
      replyTargetWindowSize: 2,
    });

    const streamedReply = conversationContext.find((entry) => entry.node.messageId === "1497");
    expect(streamedReply?.node).toMatchObject({
      body: "Done already: timeoutSeconds is now 7200s.",
      sender: "Configured Agent (you)",
      senderId: "999",
      sourceMessage: {
        from: {
          id: 999,
          is_bot: true,
          first_name: "Configured Agent (you)",
        },
      },
    });
    expect(streamedReply?.node.timestamp).not.toBe(transcriptTimestamp);
    expect(streamedReply?.node.promptContextProjectionMarker).toEqual({
      kind: "valid",
      projection: {
        transcriptMessageId: "assistant-stream-2",
        partIndex: 0,
        finalPart: true,
      },
    });
  });

  it("suppresses text-only tool payloads delivered after the final answer", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      await dispatcherOptions.deliver(
        { text: "failed command output", isError: true },
        { kind: "tool" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenCalledWith("Final answer");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("materializes chart-only finals into the active answer preview", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          presentation: {
            title: "FY25 outlook",
            blocks: [
              {
                type: "chart",
                chartType: "pie",
                title: "Revenue mix",
                segments: [
                  { label: "Product", value: 60 },
                  { label: "Services", value: 40 },
                ],
              },
            ],
          },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "FY25 outlook\n\nRevenue mix (pie chart)\n- Product: 60\n- Services: 40",
    );
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(deliverInboundReplyWithMessageSendContext).not.toHaveBeenCalled();
  });

  it("materializes table-only finals into the active answer preview", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          presentation: {
            title: "FY25 outlook",
            blocks: [
              {
                type: "table",
                caption: "Pipeline",
                headers: ["Account", "Stage", "ARR"],
                rows: [
                  ["Acme", "Won", 125000],
                  ["Globex", "Review", 82000],
                ],
              },
            ],
          },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "FY25 outlook\n\nPipeline (table)\n- Account: Acme; Stage: Won; ARR: 125000\n- Account: Globex; Stage: Review; ARR: 82000",
    );
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(deliverInboundReplyWithMessageSendContext).not.toHaveBeenCalled();
  });

  it("appends chart data to final text before active preview finalization", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "Quarterly results",
          presentation: {
            title: "FY25 outlook",
            blocks: [
              { type: "text", text: "Do not duplicate this block" },
              {
                type: "chart",
                chartType: "bar",
                title: "Revenue",
                categories: ["Q1", "Q2"],
                series: [{ name: "USD", values: [12, 18] }],
              },
            ],
          },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "Quarterly results\n\nFY25 outlook\n\nDo not duplicate this block\n\nRevenue (bar chart)\n- USD: Q1: 12; Q2: 18",
    );
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(deliverInboundReplyWithMessageSendContext).not.toHaveBeenCalled();
  });

  it("mirrors preview-finalized finals into the session transcript", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    const mirrorCall = expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), {
      agentId: "default",
      sessionId: "s1",
      idempotencyKey: expect.stringContaining("telegram-final:agent:default:telegram:direct:123:"),
      sessionKey: "agent:default:telegram:direct:123",
      storePath: "/tmp/sessions.json",
      text: "Final answer",
    });
    expect(mirrorCall.deliveryMirror).toEqual({
      kind: "channel-final",
      sourceMessageId: mirrorCall.idempotencyKey,
    });
  });

  it("keeps same-millisecond transcript mirror keys distinct per inbound message", async () => {
    createTelegramDraftStream.mockImplementation(() => createDraftStream(2001));
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1234567890);
    const firstContext = createContext({
      ctxPayload: {
        MessageSid: "456",
        SessionKey: "agent:default:telegram:direct:123",
      } as TelegramMessageContext["ctxPayload"],
    });
    const secondContext = createContext({
      ctxPayload: {
        MessageSid: "457",
        SessionKey: "agent:default:telegram:direct:123",
      } as TelegramMessageContext["ctxPayload"],
      msg: { message_id: 457 } as TelegramMessageContext["msg"],
    });
    mockDefaultSessionEntry();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    try {
      await dispatchWithContext({ context: firstContext });
      await dispatchWithContext({ context: secondContext });
    } finally {
      dateNow.mockRestore();
    }

    const firstMirrorCall = expectRecordFields(
      mockCallArg(appendAssistantMirrorMessageByIdentity),
      {
        idempotencyKey: expect.stringContaining(
          "telegram-final:agent:default:telegram:direct:123:123:456:",
        ),
      },
    );
    const secondMirrorCall = expectRecordFields(
      mockCallArg(appendAssistantMirrorMessageByIdentity, 1),
      {
        idempotencyKey: expect.stringContaining(
          "telegram-final:agent:default:telegram:direct:123:123:457:",
        ),
      },
    );
    expect(firstMirrorCall.idempotencyKey).not.toBe(secondMirrorCall.idempotencyKey);
  });

  it("skips transcript mirroring when the scoped session is absent", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    loadSessionStore.mockReturnValue({});
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    expect(appendAssistantMirrorMessageByIdentity).not.toHaveBeenCalled();
  });

  it("does not mirror non-final tool progress into the session transcript", async () => {
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    deliverReplies.mockImplementation(
      async (params: {
        replies?: Array<{ text?: string }>;
        transcriptMirror?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void>;
      }) => {
        const text = params.replies
          ?.map((reply) => reply.text)
          .filter(Boolean)
          .join("\n\n");
        await params.transcriptMirror?.({ text });
        return { delivered: true };
      },
    );
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "🛠️ tool progress" }, { kind: "tool" });
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context,
      streamMode: "partial",
      cfg: { agents: { defaults: { blockStreamingDefault: "on" } } },
      telegramCfg: { streaming: { mode: "partial", preview: { toolProgress: true } } },
    });

    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expectRecordFields(mockCallArg(deliverReplies, 0), {
      transcriptMirror: undefined,
    });
    expect(typeof mockCallArg(deliverReplies, 1).transcriptMirror).toBe("function");
    expect(appendAssistantMirrorMessageByIdentity).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), {
      agentId: "default",
      sessionId: "s1",
      sessionKey: "agent:default:telegram:direct:123",
      storePath: "/tmp/sessions.json",
      text: "Final answer",
    });
  });

  it("mirrors a legitimate repeat after a new user turn instead of skipping it", async () => {
    const repeatedText = "Final answer";
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({ text: repeatedText, timestamp: 1 });
    deliverReplies.mockImplementation(
      async (params: {
        replies?: Array<{ text?: string }>;
        transcriptMirror?: (payload: { text?: string; mediaUrls?: string[] }) => Promise<void>;
      }) => {
        const text = params.replies
          ?.map((reply) => reply.text)
          .filter(Boolean)
          .join("\n\n");
        await params.transcriptMirror?.({ text });
        return { delivered: true };
      },
    );
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: repeatedText }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    expect(appendAssistantMirrorMessageByIdentity).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), {
      agentId: "default",
      sessionId: "s1",
      idempotencyKey: expect.stringContaining("telegram-final:agent:default:telegram:direct:123:"),
      sessionKey: "agent:default:telegram:direct:123",
      storePath: "/tmp/sessions.json",
      text: repeatedText,
    });
  });

  it("mirrors the longer streamed preview when final text is truncated", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const fullAnswer =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man aus der Google Cloud Console. Danach pruefst du die Projekt- und API-Einstellungen.";
    const truncatedFinal =
      "Ja. Hier nochmal sauber Schritt fuer Schritt. Einen API Key kopiert man...";
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      text: fullAnswer,
      timestamp: Date.now() + 1_000,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: fullAnswer });
        await dispatcherOptions.deliver({ text: truncatedFinal }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context });

    expect(answerDraftStream.update).toHaveBeenCalledWith(fullAnswer);
    expect(answerDraftStream.update).not.toHaveBeenCalledWith(truncatedFinal);
    expectRecordFields(mockCallArg(emitInternalMessageSentHook), {
      content: fullAnswer,
      messageId: 2001,
    });
    expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), {
      agentId: "default",
      sessionId: "s1",
      sessionKey: "agent:default:telegram:direct:123",
      storePath: "/tmp/sessions.json",
      text: fullAnswer,
    });
  });

  it("treats session rebound mirror skips as non-fatal", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    appendAssistantMirrorMessageByIdentity.mockResolvedValueOnce({
      ok: false,
      code: "session-rebound",
      reason: "session rebound for sessionKey: agent:default:telegram:direct:123",
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context });

    expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), {
      agentId: "default",
      sessionId: "s1",
      sessionKey: "agent:default:telegram:direct:123",
      storePath: "/tmp/sessions.json",
      text: "Final answer",
    });
  });
});
