import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { expect, it } from "vitest";
import {
  appendAssistantMirrorMessageByIdentity,
  describeTelegramDispatch,
  createContext,
  createDraftStream,
  createSequencedDraftStream,
  createTelegramDraftStream,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchTelegramMessage,
  dispatchWithContext,
  editMessageTelegram,
  emitTelegramMessageSentHooks,
  expectDeliveredReply,
  expectDeliverRepliesParams,
  expectRecordFields,
  loadSessionStore,
  mockCallArg,
  mockDefaultSessionEntry,
  readLatestAssistantTextByIdentity,
  recordOutboundMessageForPromptContext,
  setupDraftStreams,
  telegramProgressPreview,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage draft-finalization", () => {
  it("does not drop any long-final text after a generic lane rotation", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver(
          { text: "A".repeat(4000) + "B".repeat(4000) },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      textLimit: 4000,
    });

    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "A".repeat(4000) + "B".repeat(4000),
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
  });

  it("does not suppress text-only blocks as delivered when answer draft is inactive", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "forced block" }, { kind: "block" });
      await dispatcherOptions.deliver({ text: "final text" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: {
        streaming: { mode: "partial", block: { enabled: true } },
      } satisfies Parameters<typeof dispatchTelegramMessage>[0]["telegramCfg"],
    });

    const deliveredTexts = deliverReplies.mock.calls.flatMap((call) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text,
      ),
    );
    expect(deliveredTexts).toContain("forced block");
  });

  it("does not suppress text-only blocks after a tool-progress draft", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "block after progress" }, { kind: "block" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(mockCallArg(answerDraftStream.updatePreview).text).toContain("Exec");
    expect(answerDraftStream.update).toHaveBeenLastCalledWith("block after progress");
  });

  it("does not suppress button-bearing blocks after answer streaming starts", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const buttons = [[{ text: "OK", callback_data: "ok" }]];
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "partial answer" });
        await dispatcherOptions.deliver(
          { text: "choose now", channelData: { telegram: { buttons } } },
          { kind: "block" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.update).toHaveBeenLastCalledWith("choose now");
    expectRecordFields(mockCallArg(editMessageTelegram, 0, 3), { buttons });
  });

  it("keeps DM Web App buttons when finalizing the streamed preview", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Opening the app" });
        await dispatcherOptions.deliver(
          {
            text: "Open the app",
            presentation: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [
                    {
                      label: "Launch",
                      action: { type: "web-app", url: "https://example.com/app" },
                    },
                  ],
                },
              ],
            },
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { richMessages: true, streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.update).toHaveBeenLastCalledWith(
      "Open the app",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expectRecordFields(mockCallArg(editMessageTelegram, 0, 3), {
      buttons: [[{ text: "Launch", web_app: { url: "https://example.com/app" } }]],
    });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("renders dropped controls in the finalized streamed preview", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Preparing controls" });
        await dispatcherOptions.deliver(
          {
            text: "Choose",
            presentation: {
              blocks: [
                {
                  type: "buttons",
                  buttons: [{ label: "Copy manually", value: "x".repeat(65) }],
                },
              ],
            },
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { richMessages: true, streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.update).toHaveBeenLastCalledWith(
      "Choose\n\n- Copy manually",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("keeps mixed controls intact through buffered finalization", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    loadSessionStore.mockReturnValue({ s1: { reasoningLevel: "stream" } });
    deliverReplies
      .mockResolvedValueOnce({ delivered: false })
      .mockResolvedValueOnce({ delivered: true });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>first attempt</think>", isReasoning: true },
        { kind: "block" },
      );
      await dispatcherOptions.deliver(
        {
          presentation: {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  { label: "Retry", value: "retry" },
                  { label: "Copy manually", value: "x".repeat(65) },
                ],
              },
            ],
          },
        },
        { kind: "final" },
      );
      await dispatcherOptions.deliver(
        { text: "<think>second attempt</think>", isReasoning: true },
        { kind: "block" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as TelegramMessageContext["ctxPayload"],
      }),
    });

    expect(answerDraftStream.update).toHaveBeenCalledWith(
      "- Copy manually",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expectRecordFields(mockCallArg(editMessageTelegram, 0, 3), {
      buttons: [[{ text: "Retry", callback_data: "retry" }]],
    });
    const fallbackReplies = deliverReplies.mock.calls.flatMap((call) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text,
      ),
    );
    expect(fallbackReplies).not.toContain("- Copy manually");
  });

  it("finalizes an ordinary block-only draft when no final follows", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "block-only answer" },
        { kind: "block", assistantMessageIndex: 0 },
      );
      return { queuedFinal: false, counts: { block: 1, final: 0, tool: 0 } };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.update).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenCalledWith("block-only answer");
    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(emitTelegramMessageSentHooks).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(emitTelegramMessageSentHooks), {
      content: "block-only answer",
      messageId: 2001,
    });
  });

  it("does not emit a terminal when a finalized preview may have landed without an id", async () => {
    const { answerDraftStream } = setupDraftStreams();
    answerDraftStream.sendMayHaveLanded.mockReturnValue(true);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "uncertain final" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(emitTelegramMessageSentHooks).not.toHaveBeenCalled();
  });

  it("delivers a block-only answer when a native quote disables the draft stream", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "quoted block-only answer", replyToId: "9001" },
        { kind: "block", assistantMessageIndex: 0 },
      );
      return { queuedFinal: false, counts: { block: 1, final: 0, tool: 0 } };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          ReplyToIsQuote: true,
          ReplyToId: "9001",
          ReplyToQuoteText: "quoted source",
        } as TelegramMessageContext["ctxPayload"],
      }),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { toolProgress: true } } },
    });

    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    const delivery = expectDeliverRepliesParams({});
    expectRecordFields((delivery.replies as Array<unknown>)[0], {
      text: "quoted block-only answer",
      replyToId: "9001",
    });
  });

  it("cleans up the draft after terminal block delivery throws", async () => {
    const { answerDraftStream } = setupDraftStreams();
    deliverReplies.mockRejectedValueOnce(new Error("terminal send failed"));
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "block-only answer" },
        { kind: "block", assistantMessageIndex: 0 },
      );
      return { queuedFinal: false, counts: { block: 1, final: 0, tool: 0 } };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.clear).toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledTimes(2);
  });

  it("finalizes a duplicate text-only block when no final follows", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-block-only",
      text: "partial answer",
      timestamp: Date.now() + 1_000,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "partial answer" });
        await dispatcherOptions.deliver(
          { text: "partial answer" },
          { kind: "block", assistantMessageIndex: 0 },
        );
        return { queuedFinal: false };
      },
    );

    await dispatchWithContext({
      context,
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(emitTelegramMessageSentHooks), {
      content: "partial answer",
      messageId: 2001,
    });
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext), {
      text: "partial answer",
      messageId: 2001,
      promptContextProjection: {
        transcriptMessageId: "assistant-block-only",
        partIndex: 0,
        finalPart: true,
      },
    });
  });

  it("keeps a delayed earlier identical block markerless when a later block rotates it", async () => {
    const answerDraftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => createDraftStream());
    const context = createContext();
    context.ctxPayload.SessionKey = "agent:default:telegram:direct:123";
    mockDefaultSessionEntry();
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-identical-second",
      text: "OK",
      timestamp: Date.now() + 2_000,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onBlockReplyQueued?.({ text: "OK" }, { assistantMessageIndex: 0 });
        await replyOptions?.onBlockReplyQueued?.({ text: "OK" }, { assistantMessageIndex: 1 });
        await dispatcherOptions.deliver(
          { text: "OK" },
          { kind: "block", assistantMessageIndex: 0 },
        );
        await dispatcherOptions.deliver(
          { text: "OK" },
          { kind: "block", assistantMessageIndex: 1 },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context, streamMode: "partial" });

    expect(readLatestAssistantTextByIdentity).not.toHaveBeenCalled();
    expect(recordOutboundMessageForPromptContext).toHaveBeenCalledTimes(1);
    const firstBlockRecord = mockCallArg(recordOutboundMessageForPromptContext);
    expectRecordFields(firstBlockRecord, { text: "OK", messageId: 2001 });
    expect(firstBlockRecord).not.toHaveProperty("promptContextProjection");
  });

  it("materializes a pending duplicate text-only block before finalizing it", async () => {
    const { answerDraftStream } = setupDraftStreams();
    answerDraftStream.stop.mockImplementation(async () => {
      answerDraftStream.setMessageId(2001);
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "pending answer" });
        await dispatcherOptions.deliver({ text: "pending answer" }, { kind: "block" });
        return { queuedFinal: false };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(emitTelegramMessageSentHooks), {
      content: "pending answer",
      messageId: 2001,
    });
  });

  it("does not restart progress drafts after final answer delivery", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Branch is up to date" }, { kind: "final" });
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Shelling" } },
      },
    });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Shelling\n\n🛠️ Exec", "<b>Shelling</b>\n<b>🛠️ Exec</b>"),
    );
    expectDeliveredReply(0, { text: "Branch is up to date" });
  });

  it("does not restart progress drafts for command output after final answer delivery", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Branch is up to date" }, { kind: "final" });
        await replyOptions?.onCommandOutput?.({
          phase: "end",
          title: "Exec",
          name: "exec",
          status: "failed",
          exitCode: 1,
        });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Shelling" } },
      },
    });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Shelling\n\n🛠️ Exec", "<b>Shelling</b>\n<b>🛠️ Exec</b>"),
    );
    expectDeliveredReply(0, { text: "Branch is up to date" });
  });

  it("does not restart progress drafts for command output while final answer delivery is pending", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        const finalDelivery = dispatcherOptions.deliver(
          { text: "Branch is up to date" },
          { kind: "final" },
        );
        await replyOptions?.onCommandOutput?.({
          phase: "end",
          title: "Exec",
          name: "exec",
          status: "failed",
          exitCode: 1,
        });
        await finalDelivery;
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Shelling" } },
      },
    });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Shelling\n\n🛠️ Exec", "<b>Shelling</b>\n<b>🛠️ Exec</b>"),
    );
    expectDeliveredReply(0, { text: "Branch is up to date" });
  });

  it("uses the transcript final when progress-mode final text is truncated", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
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
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: truncatedFinal }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context,
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { toolProgress: true } } },
    });

    expectDeliveredReply(0, { text: fullAnswer });
  });

  it("hands the complete long final to draft-owned pagination", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const longText = "one ".repeat(80);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: longText }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext(), textLimit: 80 });

    expect(answerDraftStream.update).toHaveBeenLastCalledWith(
      longText.trimEnd(),
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext), {
      messageId: 2001,
      text: longText.trimEnd(),
    });
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("keeps streamed final text in place when late media arrives", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const mediaMaxBytes = 50 * 1024 * 1024;
    let partialAccepted: boolean | void = undefined;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        partialAccepted = await replyOptions?.onPartialReply?.({ text: "Photo" });
        await dispatcherOptions.deliver(
          { text: "Photo", mediaUrl: "https://example.com/a.png" },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      telegramCfg: { mediaMaxMb: 50 },
    });

    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expect(answerDraftStream.update).toHaveBeenCalledWith("Photo");
    expect(partialAccepted).toBe(true);
    expectDeliverRepliesParams({ mediaMaxBytes });
    expectDeliveredReply(0, { text: undefined, mediaUrl: "https://example.com/a.png" });
    expect(emitTelegramMessageSentHooks).toHaveBeenCalledTimes(1);
    expectRecordFields(mockCallArg(emitTelegramMessageSentHooks), {
      content: "Photo",
      messageId: 2001,
    });
  });

  it.each([
    {
      label: "direct chat",
      sessionKey: "agent:test:telegram:direct:123",
      createMessageContext: () =>
        createContext({
          ctxPayload: {
            SessionKey: "agent:test:telegram:direct:123",
            ChatType: "direct",
          } as TelegramMessageContext["ctxPayload"],
        }),
    },
    {
      label: "group chat",
      sessionKey: "agent:test:telegram:group:-100123",
      createMessageContext: () =>
        createContext({
          chatId: -100123,
          isGroup: true,
          ctxPayload: {
            SessionKey: "agent:test:telegram:group:-100123",
            ChatType: "group",
          } as TelegramMessageContext["ctxPayload"],
          primaryCtx: {
            message: { chat: { id: -100123, type: "supergroup", title: "Test group" } },
          } as TelegramMessageContext["primaryCtx"],
          msg: {
            chat: { id: -100123, type: "supergroup", title: "Test group" },
            message_id: 456,
          } as TelegramMessageContext["msg"],
          threadSpec: { id: undefined, scope: "none" },
          replyThreadId: undefined,
        }),
    },
  ])(
    "keeps a finalized preview authoritative when late media fails in a $label",
    async ({ createMessageContext, sessionKey }) => {
      const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
      loadSessionStore.mockReturnValue({ [sessionKey]: { sessionId: "s1", updatedAt: 1 } });
      const mediaFailure = createChannelPartialDeliveryError(new Error("media rejected"), {
        messageIds: ["2002"],
        visibleReplySent: true,
      });
      deliverReplies.mockRejectedValueOnce(mediaFailure);
      let observedError: unknown;
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onPartialReply?.({ text: "Photo" });
          try {
            await dispatcherOptions.deliver(
              { text: "Photo", mediaUrl: "https://example.com/a.png" },
              { kind: "final" },
            );
          } catch (error) {
            observedError = error;
            await dispatcherOptions.onError?.(error, { kind: "final" });
          }
          return {
            queuedFinal: false,
            counts: { block: 0, final: 1, tool: 0 },
          };
        },
      );

      await dispatchWithContext({ context: createMessageContext() });

      expect(isChannelPartialDeliveryError(observedError)).toBe(true);
      if (!isChannelPartialDeliveryError(observedError)) {
        throw new Error("expected structured partial delivery error");
      }
      expect(observedError.deliveryResult).toMatchObject({
        content: "Photo",
        messageIds: ["2001", "2002"],
        receipt: { primaryPlatformMessageId: "2001" },
        visibleReplySent: true,
      });
      // onError records a non-silent failure. Avoiding a second delivery proves
      // the finalized answer was committed before that failure was surfaced.
      expect(deliverReplies).toHaveBeenCalledTimes(1);
      expectDeliveredReply(0, { text: undefined, mediaUrl: "https://example.com/a.png" });
      expect(answerDraftStream.stop).toHaveBeenCalled();
      expect(answerDraftStream.clear).not.toHaveBeenCalled();
      expect(emitTelegramMessageSentHooks).toHaveBeenCalledTimes(1);
      expectRecordFields(mockCallArg(emitTelegramMessageSentHooks), {
        content: "Photo",
        messageId: 2001,
        success: false,
      });
      expect(appendAssistantMirrorMessageByIdentity).toHaveBeenCalledTimes(1);
      expectRecordFields(mockCallArg(appendAssistantMirrorMessageByIdentity), {
        sessionKey,
        text: "Photo",
      });
    },
  );

  it("sends standalone MEDIA directive final replies as media", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "MEDIA:/tmp/reply-image.png" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).not.toHaveBeenCalledWith("MEDIA:/tmp/reply-image.png");
    expectDeliveredReply(0, {
      text: "",
      mediaUrl: "/tmp/reply-image.png",
      mediaUrls: ["/tmp/reply-image.png"],
    });
  });

  it("attaches interactive buttons to streamed text when late media arrives", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Photo" });
        await dispatcherOptions.deliver(
          {
            text: "Photo",
            mediaUrl: "https://example.com/a.png",
            interactive: {
              blocks: [{ type: "buttons", buttons: [{ label: "OK", value: "ok" }] }],
            },
          },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith("Photo");
    expectRecordFields(mockCallArg(editMessageTelegram, 0, 3), {
      buttons: [[{ text: "OK", callback_data: "ok" }]],
    });
    expectDeliveredReply(0, { text: undefined, mediaUrl: "https://example.com/a.png" });
  });
});
