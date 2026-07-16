import { expect, it } from "vitest";
import {
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
  emitInternalMessageSentHook,
  expectDeliverRepliesParams,
  expectRecordFields,
  mockCallArg,
  mockDefaultSessionEntry,
  readLatestAssistantTextByIdentity,
  recordOutboundMessageForPromptContext,
  setupDraftStreams,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage fence-draft-finalization", () => {
  it("keeps supersession latched when it arrives during adoption", async () => {
    const sessionKey = "agent:main:telegram:direct:adoption-race";
    let adoptionStarted: (() => void) | undefined;
    const adoptionStartGate = new Promise<void>((resolve) => {
      adoptionStarted = resolve;
    });
    let releaseAdoption: (() => void) | undefined;
    const adoptionGate = new Promise<void>((resolve) => {
      releaseAdoption = resolve;
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onTurnAdopted?.();
        await dispatcherOptions.deliver({ text: "stale final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    const dispatchPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: sessionKey,
          ChatType: "direct",
          MessageSid: "101",
          RawBody: "long turn",
          BodyForAgent: "long turn",
          CommandBody: "long turn",
          CommandAuthorized: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: 123, type: "private" },
          message_id: 101,
          text: "long turn",
        } as unknown as TelegramMessageContext["msg"],
        chatId: 123,
        isGroup: false,
        threadSpec: { id: undefined, scope: "none" },
      }),
      streamMode: "off",
      onTurnAdopted: async () => {
        adoptionStarted?.();
        await adoptionGate;
      },
    });
    await adoptionStartGate;

    const { supersedeTelegramReplyFence } = await import("./telegram-reply-fence.js");
    expect(supersedeTelegramReplyFence(sessionKey)).toBe(true);
    releaseAdoption?.();
    await dispatchPromise;

    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("lets authorized /stop kill an adopted run without the released fence controller", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([[historyKey, []]]);
    // Core owns post-adoption abort via reply-run registry / handleStopCommand.
    // Pin: after fence release, a core-owned abort still ends the run while the
    // fence controller stays non-aborted.
    const coreRunController = new AbortController();
    let firstStarted: (() => void) | undefined;
    const firstStartGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let firstAbortSignal: AbortSignal | undefined;
    let adoptTurn: (() => void | Promise<void>) | undefined;
    let runSettled = false;
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ replyOptions }) => {
        firstAbortSignal = replyOptions?.abortSignal;
        adoptTurn = replyOptions?.onTurnAdopted;
        firstStarted?.();
        await new Promise<void>((resolve) => {
          const finish = () => {
            if (runSettled) {
              return;
            }
            runSettled = true;
            resolve();
          };
          firstAbortSignal?.addEventListener("abort", finish, { once: true });
          coreRunController.signal.addEventListener("abort", finish, { once: true });
        });
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        };
      })
      .mockImplementationOnce(async () => {
        // Simulate core handleStopCommand / abortReplyRunBySessionId effect on the
        // adopted registry-owned run (independent of the released fence controller).
        coreRunController.abort();
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        };
      });

    const createGroupContext = (messageId: number, body: string) =>
      createContext({
        ctxPayload: {
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
          CommandAuthorized: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: messageId,
          text: body,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: undefined, scope: "none" },
      });

    const firstPromise = dispatchWithContext({
      context: createGroupContext(99, "@bot long adopted turn"),
      streamMode: "off",
    });
    await firstStartGate;
    await adoptTurn?.();
    expect(firstAbortSignal?.aborted).toBe(false);
    expect(coreRunController.signal.aborted).toBe(false);

    await dispatchWithContext({
      context: createGroupContext(100, "/stop"),
      streamMode: "off",
    });

    await firstPromise;
    expect(firstAbortSignal?.aborted).toBe(false);
    expect(coreRunController.signal.aborted).toBe(true);
  });

  it("keeps overlapping group deliveries non-superseded", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([[historyKey, []]]);
    let firstStarted: (() => void) | undefined;
    const firstStartGate = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted: (() => void) | undefined;
    const secondStartGate = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onTurnAdopted?.();
        firstStarted?.();
        await firstGate;
        await dispatcherOptions.deliver({ text: "earlier group answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
        };
      })
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onTurnAdopted?.();
        secondStarted?.();
        await dispatcherOptions.deliver({ text: "fresh group answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
        };
      });
    deliverReplies.mockResolvedValue({ delivered: true });

    const createGroupContext = (messageId: number, body: string) =>
      createContext({
        ctxPayload: {
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
          CommandAuthorized: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: messageId,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: undefined, scope: "none" },
      });

    const firstPromise = dispatchWithContext({
      context: createGroupContext(99, "@bot first request"),
      streamMode: "off",
    });
    await firstStartGate;
    const secondPromise = dispatchWithContext({
      context: createGroupContext(100, "@bot second request"),
      streamMode: "off",
    });
    await secondStartGate;
    releaseFirst?.();
    await Promise.all([firstPromise, secondPromise]);

    const deliveredTexts = deliverReplies.mock.calls.flatMap((call) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text,
      ),
    );
    expect(deliveredTexts).toContain("earlier group answer");
    expect(deliveredTexts).toContain("fresh group answer");
  });

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

    expect(answerDraftStream.update).toHaveBeenCalledWith("A".repeat(4000) + "B".repeat(4000));
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
    expectRecordFields(mockCallArg(emitInternalMessageSentHook), {
      content: "block-only answer",
      messageId: 2001,
    });
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
      telegramCfg: { streaming: { mode: "progress" } },
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
    expectRecordFields(mockCallArg(emitInternalMessageSentHook), {
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
    expectRecordFields(mockCallArg(emitInternalMessageSentHook), {
      content: "pending answer",
      messageId: 2001,
    });
  });
});
