import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { expect, it, vi } from "vitest";
import {
  describeTelegramDispatch,
  appendAssistantMirrorMessageByIdentity,
  createContext,
  createDraftStream,
  createReasoningDefaultContext,
  createReasoningForumTopicContext,
  createReasoningStreamContext,
  createSequencedDraftStream,
  createStatusReactionController,
  createTelegramDraftStream,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
  emitInternalMessageSentHook,
  expectDeliveredReply,
  expectDraftStreamParams,
  expectRecordFields,
  loadSessionStore,
  mockCallArg,
  readLatestAssistantTextByIdentity,
  recordOutboundMessageForPromptContext,
  requireInvocationOrder,
  setupDraftStreams,
  telegramProgressPreview,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage progress-rendering", () => {
  it("renders the headline immediately when the preamble arrives after tool progress", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      // The first valid preamble after the draft opened must render as the
      // status headline in the same push, not wait for another progress event.
      await replyOptions?.onItemEvent?.({
        kind: "preamble",
        itemId: "preamble-1",
        progressText: "Checking recent context",
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { label: "Shelling" } },
      },
    });

    expect(draftStream.updatePreview).toHaveBeenLastCalledWith(
      telegramProgressPreview(
        "Shelling\n\nChecking recent context",
        "<b>Shelling</b>\nChecking recent context",
      ),
    );
  });

  it("keeps the progress draft label when tool progress lines are hidden", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { label: "Shelling", toolProgress: false },
        },
      },
    });

    expect(draftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Shelling", "<b>Shelling</b>"),
    );
    expect(draftStream.flush).toHaveBeenCalled();
  });

  it("keeps streamed reasoning visible when tool progress lines are hidden", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onReasoningStream?.({ text: "<think>Checking files</think>" });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { label: "Shelling", toolProgress: false },
        },
      },
    });

    expect(draftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🧠 Checking files",
        "<b>Shelling</b>\n🧠 <i>Checking files</i>",
      ),
    );
  });

  it.each([{ label: false }, { label: "Shelling", maxLines: 1 }] as const)(
    "does not duplicate Telegram progress HTML rows without a visible label",
    async (progress) => {
      const draftStream = createSequencedDraftStream(2001);
      createTelegramDraftStream.mockReturnValue(draftStream);
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
        await replyOptions?.onReplyStart?.();
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        return { queuedFinal: false };
      });

      await dispatchWithContext({
        context: createContext(),
        streamMode: "progress",
        telegramCfg: {
          streaming: {
            mode: "progress",
            progress,
          },
        },
      });

      expect(draftStream.updatePreview).toHaveBeenCalledWith(
        telegramProgressPreview("🛠️ Exec", "<b>🛠️ Exec</b>"),
      );
    },
  );

  it("keeps progress draft labels static while the draft is active", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    let finishRun: (() => void) | undefined;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      return { queuedFinal: false };
    });

    const run = dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { label: "Working", toolProgress: false },
        },
      },
    });

    await vi.waitFor(() =>
      expect(draftStream.updatePreview).toHaveBeenCalledWith(
        telegramProgressPreview("Working", "<b>Working</b>"),
      ),
    );
    expect(draftStream.updatePreview).not.toHaveBeenCalledWith({ text: "Working." });
    expect(draftStream.updatePreview).not.toHaveBeenCalledWith({ text: "Working.." });
    expect(draftStream.updatePreview).not.toHaveBeenCalledWith({ text: "Working..." });
    finishRun?.();
    await run;
  });

  it("renders Telegram progress drafts before slow status reactions resolve", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    let releaseSetTool: (() => void) | undefined;
    const statusReactionController = createStatusReactionController();
    statusReactionController.setTool.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseSetTool = resolve;
        }),
    );
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      const pendingToolStart = replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await Promise.resolve();
      await Promise.resolve();
      const updateBeforeStatusReaction = draftStream.updatePreview.mock.calls.at(-1)?.[0]?.text;
      releaseSetTool?.();
      await pendingToolStart;
      expect(updateBeforeStatusReaction).toBe("<b>Shelling</b><br><b>🛠️ Exec</b>");
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext({
        statusReactionController: statusReactionController as never,
      }),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
    });

    expect(statusReactionController.setTool).toHaveBeenCalledWith("exec");
  });

  it("keeps non-command Telegram progress draft lines across post-tool assistant boundaries", async () => {
    vi.useFakeTimers();
    try {
      const draftStream = createSequencedDraftStream(2001);
      createTelegramDraftStream.mockReturnValue(draftStream);
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onReplyStart?.();
          await replyOptions?.onAssistantMessageStart?.();
          await replyOptions?.onItemEvent?.({ kind: "search", progressText: "docs lookup" });
          await vi.advanceTimersByTimeAsync(5_000);
          await replyOptions?.onItemEvent?.({ progressText: "tests passed" });
          await replyOptions?.onAssistantMessageStart?.();
          await dispatcherOptions.deliver({ text: "Final after tool" }, { kind: "final" });
          return { queuedFinal: true };
        },
      );

      await dispatchWithContext({
        context: createContext(),
        streamMode: "progress",
        telegramCfg: { streaming: { mode: "progress", progress: { label: "Shelling" } } },
      });

      expect(draftStream.updatePreview).toHaveBeenCalledWith(
        telegramProgressPreview(
          "Shelling\n\n🔎 Web Search: docs lookup\n• tests passed",
          "<b>Shelling</b>\n<b>🔎 Web Search</b> <code>docs lookup</code>\n<b>Update</b> <code>tests passed</code>",
        ),
      );
      // A tool-progress-only window with nothing to summarize is torn down via the
      // deferred-delete reposition (new content first, delete later), not a bare
      // immediate clear/delete or forceNewMessage.
      expect(draftStream.rotateToNewMessageDeferringDelete).toHaveBeenCalledTimes(1);
      expect(draftStream.forceNewMessage).not.toHaveBeenCalled();
      expect(draftStream.clear).not.toHaveBeenCalled();
      expectDeliveredReply(0, { text: "Final after tool" });
      expect(editMessageTelegram).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to normal send for error payloads and clears the pending stream", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Boom", isError: true }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.clear).toHaveBeenCalled();
    expectDeliveredReply(0, { text: "Boom" });
  });

  it("suppresses failed tool payloads after the final reply", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      await dispatcherOptions.deliver(
        { text: "Tool failed after final", isError: true },
        { kind: "tool" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext(), streamMode: "off" });

    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expectDeliveredReply(0, { text: "Final answer" });
  });

  it("preserves final error warnings after the final reply", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      await dispatcherOptions.deliver({ text: "Write failed", isError: true }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext(), streamMode: "off" });

    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expectDeliveredReply(0, { text: "Final answer" });
    expectDeliveredReply(0, { text: "Write failed", isError: true }, 1);
  });

  it("suppresses non-terminal final error warnings after the final reply", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      await dispatcherOptions.deliver(
        setReplyPayloadMetadata(
          { text: "Post-processing failed", isError: true },
          { nonTerminalToolErrorWarning: true },
        ),
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext(), streamMode: "off" });

    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expectDeliveredReply(0, { text: "Final answer" });
  });

  it("preserves non-terminal final error warnings before any final reply is delivered", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        setReplyPayloadMetadata(
          { text: "Post-processing failed", isError: true },
          { nonTerminalToolErrorWarning: true },
        ),
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext(), streamMode: "off" });

    expect(deliverReplies).toHaveBeenCalledTimes(1);
    expectDeliveredReply(0, { text: "Post-processing failed", isError: true });
  });

  it("streams button-bearing text into the same message", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    const buttons = [[{ text: "OK", callback_data: "ok" }]];
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "Choose", channelData: { telegram: { buttons } } },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith("Choose");
    expect(mockCallArg(editMessageTelegram)).toBe(123);
    expect(mockCallArg(editMessageTelegram, 0, 1)).toBe(2001);
    expect(mockCallArg(editMessageTelegram, 0, 2)).toBe("Choose");
    expectRecordFields(mockCallArg(editMessageTelegram, 0, 3), { buttons });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("streams interactive buttons into the same message", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        {
          text: "Choose",
          interactive: {
            blocks: [{ type: "buttons", buttons: [{ label: "OK", value: "ok" }] }],
          },
        },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith("Choose");
    expectRecordFields(mockCallArg(editMessageTelegram, 0, 3), {
      buttons: [[{ text: "OK", callback_data: "ok" }]],
    });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("streams reasoning and answer text on separate lanes", async () => {
    const { answerDraftStream, reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "<think>Thinking</think>" });
        await dispatcherOptions.deliver({ text: "Answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createReasoningStreamContext() });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith("🧠 _Thinking_");
    expect(answerDraftStream.update).toHaveBeenCalledWith("Answer");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("emits final hooks when a buffered answer flushes after reasoning delivery", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    loadSessionStore.mockReturnValue({
      s1: { reasoningLevel: "stream", sessionId: "reasoning-session" },
    });
    readLatestAssistantTextByIdentity.mockResolvedValue({
      id: "assistant-buffered-final",
      text: "Buffered answer",
      timestamp: Date.now() + 1_000,
    });
    deliverReplies
      .mockResolvedValueOnce({ delivered: false })
      .mockResolvedValueOnce({ delivered: true });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>first attempt</think>", isReasoning: true },
        { kind: "block" },
      );
      await dispatcherOptions.deliver({ text: "Buffered answer" }, { kind: "final" });
      await dispatcherOptions.deliver(
        { text: "<think>second attempt</think>", isReasoning: true },
        { kind: "block" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expect(answerDraftStream.update).toHaveBeenCalledWith("Buffered answer");
    expectRecordFields(mockCallArg(emitInternalMessageSentHook), {
      content: "Buffered answer",
      messageId: 2001,
    });
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext), {
      messageId: 2001,
      text: "Buffered answer",
      promptContextProjection: {
        transcriptMessageId: "assistant-buffered-final",
        partIndex: 0,
        finalPart: true,
      },
    });
    await vi.waitFor(() => expect(appendAssistantMirrorMessageByIdentity).toHaveBeenCalledOnce());
  });

  it("preserves forum topic message_thread_id across streamed reasoning and final answer", async () => {
    const { answerDraftStream, reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "<think>Thinking</think>" });
        await dispatcherOptions.deliver({ text: "Answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createReasoningForumTopicContext() });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith("🧠 _Thinking_");
    expect(answerDraftStream.update).toHaveBeenCalledWith("Answer");
    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    expectRecordFields(mockCallArg(emitInternalMessageSentHook), {
      content: "Answer",
      messageId: 2001,
    });
    expectRecordFields(mockCallArg(recordOutboundMessageForPromptContext), {
      chatId: "-100123",
      messageId: 2001,
      text: "Answer",
      messageThreadId: 88,
    });
    expectDraftStreamParams({ thread: { id: 88, scope: "forum" } });
    expectRecordFields(mockCallArg(createTelegramDraftStream, 1), {
      thread: { id: 88, scope: "forum" },
    });
  });

  it("replaces reasoning snapshots on the reasoning lane", async () => {
    const { reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      const onReasoningStream = replyOptions?.onReasoningStream as
        | ((payload: {
            text?: string;
            delta?: string;
            isReasoningSnapshot?: boolean;
          }) => Promise<void> | void)
        | undefined;
      await onReasoningStream?.({
        text: "<think>Checking</think>",
        delta: "Checking",
        isReasoningSnapshot: true,
      });
      await onReasoningStream?.({
        text: "<think>Reading\n\nChecking</think>",
        delta: "Reading\n\nChecking",
        isReasoningSnapshot: true,
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({ context: createReasoningStreamContext() });

    expect(reasoningDraftStream.update).toHaveBeenLastCalledWith("🧠 _Reading_\n\n_Checking_");
    const updates = reasoningDraftStream.update.mock.calls.map((call) => call[0]);
    expect(updates.join("\n")).not.toContain("CheckingReading");
  });

  it("repositions split reasoning before deleting the prior preview", async () => {
    const answerDraftStream = createDraftStream(2001);
    const reasoningDraftStream = createSequencedDraftStream(3001);
    createTelegramDraftStream
      .mockImplementationOnce(() => answerDraftStream)
      .mockImplementationOnce(() => reasoningDraftStream);
    let replacementMessageId: number | undefined;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReasoningStream?.({ text: "<think>First thought</think>" });
      await replyOptions?.onReasoningEnd?.();
      await replyOptions?.onReasoningStream?.({ text: "<think>Second thought</think>" });
      replacementMessageId = reasoningDraftStream.messageId();
      return { queuedFinal: false };
    });

    await dispatchWithContext({ context: createReasoningStreamContext() });

    expect(reasoningDraftStream.update).toHaveBeenNthCalledWith(1, "🧠 _First thought_");
    expect(reasoningDraftStream.update).toHaveBeenNthCalledWith(2, "🧠 _Second thought_");
    expect(reasoningDraftStream.rotateToNewMessageDeferringDelete).toHaveBeenCalledTimes(1);
    expect(reasoningDraftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(reasoningDraftStream.clear).toHaveBeenCalledTimes(1);
    expect(
      requireInvocationOrder(
        reasoningDraftStream.rotateToNewMessageDeferringDelete,
        0,
        "first deferred reasoning draft rotation",
      ),
    ).toBeLessThan(
      requireInvocationOrder(reasoningDraftStream.update, 1, "second reasoning draft update"),
    );
    expect(
      requireInvocationOrder(reasoningDraftStream.update, 1, "second reasoning draft update"),
    ).toBeLessThan(
      requireInvocationOrder(reasoningDraftStream.clear, 0, "first reasoning draft clear"),
    );
    expect(replacementMessageId).toBe(3002);
  });

  it("streams reasoning from configured defaults", async () => {
    const { answerDraftStream, reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReasoningStream?.({ text: "<think>Thinking</think>" });
        await dispatcherOptions.deliver({ text: "Answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createReasoningDefaultContext(),
      cfg: {
        agents: {
          defaults: { reasoningDefault: "off" },
          list: [{ id: "Ops", reasoningDefault: "stream" }],
        },
      },
    });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith("🧠 _Thinking_");
    expect(answerDraftStream.update).toHaveBeenCalledWith("Answer");
  });

  it("keeps reasoning draft labels static while the reasoning lane is active", async () => {
    const { reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    let finishRun: (() => void) | undefined;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReasoningStream?.({ text: "<think>Thinking</think>" });
      await new Promise<void>((resolve) => {
        finishRun = resolve;
      });
      return { queuedFinal: false };
    });

    const run = dispatchWithContext({ context: createReasoningStreamContext() });

    await vi.waitFor(() =>
      expect(reasoningDraftStream.update).toHaveBeenCalledWith("🧠 _Thinking_"),
    );
    // Durable thoughts render behind the 🧠 marker; the literal "Thinking"
    // header (and its streaming dot-variants) must never leak back into a lane.
    expect(reasoningDraftStream.update).not.toHaveBeenCalledWith("Thinking\n\n_Thinking_");
    expect(reasoningDraftStream.update).not.toHaveBeenCalledWith("Thinking.\n\n_Thinking_");
    expect(reasoningDraftStream.update).not.toHaveBeenCalledWith("Thinking...\n\n_Thinking_");
    finishRun?.();
    await run;
  });
});
