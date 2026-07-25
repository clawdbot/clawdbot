import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import { expect, it } from "vitest";
import {
  describeTelegramDispatch,
  createContext,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
  expectDraftStreamParams,
  mockCallArg,
  requireInvocationOrder,
  setupDraftStreams,
  trailingFinalStatusText,
} from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage draft-rotation", () => {
  it("streams block and final text through the same answer message", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Working" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Working");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Done");
    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("sends trailing verbose status after streamed final answer without replacing the answer draft", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Normal reply" });
        await dispatcherOptions.deliver({ text: "Normal reply" }, { kind: "final" });
        await dispatcherOptions.deliver({ text: trailingFinalStatusText }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update.mock.calls).toEqual([
      ["Normal reply"],
      [trailingFinalStatusText],
    ]);
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(
      requireInvocationOrder(answerDraftStream.forceNewMessage, 0, "first answer draft rotation"),
    ).toBeLessThan(
      requireInvocationOrder(answerDraftStream.update, 1, "second answer draft update"),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("applies partial deltas while preserving the first-preview debounce", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "Streaming ",
          delta: "Streaming ",
        });
        await replyOptions?.onPartialReply?.({
          text: "Streaming previews ",
          delta: "previews ",
        });
        await replyOptions?.onPartialReply?.({
          text: "Streaming previews are useful because they show progress.",
          delta: "are useful because they show progress.",
        });
        await dispatcherOptions.deliver(
          { text: "Streaming previews are useful because they show progress." },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expectDraftStreamParams({ minInitialChars: 30 });
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Streaming ");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Streaming previews ");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(
      3,
      "Streaming previews are useful because they show progress.",
    );
    expect(answerDraftStream.update).toHaveBeenLastCalledWith(
      "Streaming previews are useful because they show progress.",
    );
    expect(answerDraftStream.stop).toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("replaces non-prefix partial snapshots instead of appending them", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "Working...",
          delta: "Working...",
        });
        await replyOptions?.onPartialReply?.({
          text: "Done.",
          delta: "",
          replace: true,
        });
        await dispatcherOptions.deliver({ text: "Done." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Working...");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Done.");
    expect(answerDraftStream.update).toHaveBeenLastCalledWith("Done.");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not coalesce answer partial fragments with tool progress drafts", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions?.onPartialReply?.({ text: "Done ", delta: "Done " });
        await replyOptions?.onPartialReply?.({ text: "Done answer", delta: "answer" });
        await dispatcherOptions.deliver({ text: "Done answer." }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(mockCallArg(answerDraftStream.updatePreview).text).toContain("Exec");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Done ");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Done answer");
    expect(answerDraftStream.update).toHaveBeenLastCalledWith("Done answer.");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not hide text-only tool output after answer streaming starts", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Partial answer" });
        await dispatcherOptions.deliver({ text: "Tool result after partial" }, { kind: "tool" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "partial",
      telegramCfg: {
        streaming: { mode: "partial" },
      },
    });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Partial answer");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Tool result after partial");
  });

  it("rotates the answer stream only after a finalized assistant message", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await dispatcherOptions.deliver({ text: "Message A final" }, { kind: "final" });
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: "Message B partial" });
        await dispatcherOptions.deliver({ text: "Message B final" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Message A final");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Message B partial");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(3, "Message B final");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("keeps same-message block chunks in one answer preview until final", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onBlockReplyQueued?.(
          { text: "First chunk. " },
          { assistantMessageIndex: 0 },
        );
        await dispatcherOptions.deliver({ text: "First chunk. " }, { kind: "block" });
        await replyOptions?.onBlockReplyQueued?.(
          { text: "Second chunk." },
          { assistantMessageIndex: 0 },
        );
        await dispatcherOptions.deliver({ text: "Second chunk." }, { kind: "block" });
        await dispatcherOptions.deliver(
          { text: "First chunk. \nSecond chunk." },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "First chunk.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Second chunk.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(3, "First chunk. \nSecond chunk.");
    expect(answerDraftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not leak inline reply directives into block draft previews", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        const payload = { text: "[[reply_to: 123]] Visible chunk." };
        await replyOptions?.onBlockReplyQueued?.(payload, { assistantMessageIndex: 0 });
        await dispatcherOptions.deliver(payload, { kind: "block", assistantMessageIndex: 0 });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.update).toHaveBeenCalledWith("Visible chunk.");
    expect(answerDraftStream.update).not.toHaveBeenCalledWith("[[reply_to: 123]] Visible chunk.");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("rotates answer previews when queued block assistant index changes", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onBlockReplyQueued?.(
          { text: "Site A shows X." },
          { assistantMessageIndex: 0 },
        );
        await dispatcherOptions.deliver({ text: "Site A shows X." }, { kind: "block" });
        await replyOptions?.onBlockReplyQueued?.(
          { text: "Site B shows Y." },
          { assistantMessageIndex: 1 },
        );
        await dispatcherOptions.deliver({ text: "Site B shows Y." }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Site A shows X.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Site B shows Y.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(3, "Final answer");
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    const rotationOrder = requireInvocationOrder(
      answerDraftStream.forceNewMessage,
      0,
      "first answer draft rotation",
    );
    const secondBlockUpdateOrder = requireInvocationOrder(
      answerDraftStream.update,
      1,
      "second answer draft update",
    );
    expect(rotationOrder).toBeLessThan(secondBlockUpdateOrder);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("falls back to normal delivery before rotating a stale queued block preview", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    let firstBlockPreviewWentStale = false;
    answerDraftStream.lastDeliveredText.mockImplementation(() =>
      firstBlockPreviewWentStale ? "stale draft still visible" : "",
    );
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        const firstPayload = setReplyPayloadMetadata(
          { text: "Site A shows X." },
          { assistantMessageIndex: 0 },
        );
        const secondPayload = setReplyPayloadMetadata(
          { text: "Site B shows Y." },
          { assistantMessageIndex: 1 },
        );
        await replyOptions?.onBlockReplyQueued?.(firstPayload, { assistantMessageIndex: 0 });
        await dispatcherOptions.deliver(firstPayload, { kind: "block" });
        firstBlockPreviewWentStale = true;
        await replyOptions?.onBlockReplyQueued?.(secondPayload, { assistantMessageIndex: 1 });
        await dispatcherOptions.deliver(secondPayload, { kind: "block" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Site A shows X.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Site A shows X.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(3, "Site B shows Y.");
    expect(answerDraftStream.clear).toHaveBeenCalled();
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    const fallbackDelivery = mockCallArg(deliverReplies) as {
      replies?: Array<{ text?: string }>;
      transcriptMirror?: unknown;
    };
    expect(fallbackDelivery.replies?.[0]?.text).toBe("Site A shows X.");
    expect(fallbackDelivery.transcriptMirror).toBeUndefined();
    const clearOrder = requireInvocationOrder(
      answerDraftStream.clear,
      0,
      "first answer draft clear",
    );
    const fallbackDeliveryOrder = requireInvocationOrder(deliverReplies, 0, "first reply delivery");
    const rotationOrder = requireInvocationOrder(
      answerDraftStream.forceNewMessage,
      0,
      "first answer draft rotation",
    );
    const secondBlockUpdateOrder = requireInvocationOrder(
      answerDraftStream.update,
      2,
      "third answer draft update",
    );
    expect(clearOrder).toBeLessThan(fallbackDeliveryOrder);
    expect(fallbackDeliveryOrder).toBeLessThan(rotationOrder);
    expect(rotationOrder).toBeLessThan(secondBlockUpdateOrder);
  });

  it("does not rotate a partial preview before queued block delivery drains", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Site A shows X." });
        await replyOptions?.onBlockReplyQueued?.(
          { text: "Site A shows X." },
          { assistantMessageIndex: 0 },
        );
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onBlockReplyQueued?.(
          { text: "Site B shows Y." },
          { assistantMessageIndex: 1 },
        );
        await dispatcherOptions.deliver({ text: "Site A shows X." }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "Site B shows Y." }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update.mock.calls).toEqual([
      ["Site A shows X."],
      ["Site B shows Y."],
      ["Final answer"],
    ]);
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    const firstBlockFlushOrder = requireInvocationOrder(
      answerDraftStream.flush,
      0,
      "first answer draft flush",
    );
    const rotationOrder = requireInvocationOrder(
      answerDraftStream.forceNewMessage,
      0,
      "first answer draft rotation",
    );
    const secondBlockUpdateOrder = requireInvocationOrder(
      answerDraftStream.update,
      1,
      "second answer draft update",
    );
    expect(firstBlockFlushOrder).toBeLessThan(rotationOrder);
    expect(rotationOrder).toBeLessThan(secondBlockUpdateOrder);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("drains unindexed queued blocks after delivery text rewrites", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Existing preview" });
        await replyOptions?.onBlockReplyQueued?.({ text: "Original block text" });
        await replyOptions?.onAssistantMessageStart?.();
        await dispatcherOptions.deliver({ text: "PFX Original block text" }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Existing preview");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "PFX Original block text");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(3, "Final answer");
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    const blockUpdateOrder = requireInvocationOrder(
      answerDraftStream.update,
      1,
      "second answer draft update",
    );
    const rotationOrder = requireInvocationOrder(
      answerDraftStream.forceNewMessage,
      0,
      "first answer draft rotation",
    );
    const finalUpdateOrder = requireInvocationOrder(
      answerDraftStream.update,
      2,
      "third answer draft update",
    );
    expect(blockUpdateOrder).toBeLessThan(rotationOrder);
    expect(rotationOrder).toBeLessThan(finalUpdateOrder);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("preserves boundary rotation after a queued prior block is canceled", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Site A partial" });
        const priorPayload = setReplyPayloadMetadata(
          { text: "Site A final" },
          { assistantMessageIndex: 0 },
        );
        await replyOptions?.onBlockReplyQueued?.(priorPayload, { assistantMessageIndex: 0 });
        await replyOptions?.onAssistantMessageStart?.();
        await dispatcherOptions.onBeforeDeliverCancelled?.(priorPayload, { kind: "block" });
        const visiblePayload = setReplyPayloadMetadata(
          { text: "Site B final" },
          { assistantMessageIndex: 1 },
        );
        await replyOptions?.onBlockReplyQueued?.(visiblePayload, { assistantMessageIndex: 1 });
        await dispatcherOptions.deliver(visiblePayload, { kind: "block" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Site A partial");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Site B final");
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    const firstPartialUpdateOrder = requireInvocationOrder(
      answerDraftStream.update,
      0,
      "first answer draft update",
    );
    const rotationOrder = requireInvocationOrder(
      answerDraftStream.forceNewMessage,
      0,
      "first answer draft rotation",
    );
    const visibleBlockUpdateOrder = requireInvocationOrder(
      answerDraftStream.update,
      1,
      "second answer draft update",
    );
    expect(firstPartialUpdateOrder).toBeLessThan(rotationOrder);
    expect(rotationOrder).toBeLessThan(visibleBlockUpdateOrder);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("expires skipped queued block rotations before later partial previews", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        const payload = setReplyPayloadMetadata({ text: "NO_REPLY" }, { assistantMessageIndex: 0 });
        await replyOptions?.onPartialReply?.({ text: "Site A shows X." });
        await replyOptions?.onBlockReplyQueued?.(payload, { assistantMessageIndex: 0 });
        await replyOptions?.onAssistantMessageStart?.();
        dispatcherOptions.onSkip?.(payload, { kind: "block", reason: "silent" });
        await replyOptions?.onPartialReply?.({ text: "Site B shows Y." });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Site A shows X.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Site B shows Y.");
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    const rotationOrder = requireInvocationOrder(
      answerDraftStream.forceNewMessage,
      0,
      "first answer draft rotation",
    );
    const secondPartialUpdateOrder = requireInvocationOrder(
      answerDraftStream.update,
      1,
      "second answer draft update",
    );
    expect(rotationOrder).toBeLessThan(secondPartialUpdateOrder);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("preserves earlier queued rotations when a later block is skipped first", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        const priorPayload = setReplyPayloadMetadata(
          { text: "Site A shows X." },
          { assistantMessageIndex: 0 },
        );
        const skippedPayload = setReplyPayloadMetadata(
          { text: "NO_REPLY" },
          { assistantMessageIndex: 1 },
        );
        const visiblePayload = setReplyPayloadMetadata(
          { text: "Site B shows Y." },
          { assistantMessageIndex: 1 },
        );
        await replyOptions?.onBlockReplyQueued?.(priorPayload, { assistantMessageIndex: 0 });
        await replyOptions?.onBlockReplyQueued?.(skippedPayload, { assistantMessageIndex: 1 });
        dispatcherOptions.onSkip?.(skippedPayload, { kind: "block", reason: "silent" });
        await dispatcherOptions.deliver(priorPayload, { kind: "block" });
        await replyOptions?.onBlockReplyQueued?.(visiblePayload, { assistantMessageIndex: 1 });
        await dispatcherOptions.deliver(visiblePayload, { kind: "block" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Site A shows X.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Site B shows Y.");
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    const rotationOrder = requireInvocationOrder(
      answerDraftStream.forceNewMessage,
      0,
      "first answer draft rotation",
    );
    const visibleBlockUpdateOrder = requireInvocationOrder(
      answerDraftStream.update,
      1,
      "second answer draft update",
    );
    expect(rotationOrder).toBeLessThan(visibleBlockUpdateOrder);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("clears queued rotations when block delivery loses answer text", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Site A partial" });
        const queuedPayload = setReplyPayloadMetadata(
          { text: "Site A final" },
          { assistantMessageIndex: 0 },
        );
        await replyOptions?.onBlockReplyQueued?.(queuedPayload, { assistantMessageIndex: 0 });
        await replyOptions?.onAssistantMessageStart?.();
        await dispatcherOptions.deliver(
          setReplyPayloadMetadata(
            { mediaUrls: ["https://example.test/site-a.png"] },
            { assistantMessageIndex: 0 },
          ),
          { kind: "block", assistantMessageIndex: 0 },
        );
        await replyOptions?.onPartialReply?.({ text: "Site B partial" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Site A partial");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Site B partial");
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    const firstPartialUpdateOrder = requireInvocationOrder(
      answerDraftStream.update,
      0,
      "first answer draft update",
    );
    const rotationOrder = requireInvocationOrder(
      answerDraftStream.forceNewMessage,
      0,
      "first answer draft rotation",
    );
    const nextPartialUpdateOrder = requireInvocationOrder(
      answerDraftStream.update,
      1,
      "second answer draft update",
    );
    expect(firstPartialUpdateOrder).toBeLessThan(rotationOrder);
    expect(rotationOrder).toBeLessThan(nextPartialUpdateOrder);
    expect(deliverReplies).toHaveBeenCalledTimes(1);
  });
});
