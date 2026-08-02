import { expect, it, vi } from "vitest";
import {
  describeTelegramDispatch,
  createContext,
  createDirectSessionPayload,
  createReasoningStreamContext,
  createTelegramDraftStream,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
  expectDeliveredReply,
  expectDeliverRepliesParams,
  expectWindowCollapsedTo,
  mockCallArg,
  requireInvocationOrder,
  setupDraftStreams,
  telegramProgressPreview,
} from "./bot-message-dispatch.test-harness.js";

const draftWarn = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "telegram/draft-stream" ? { ...logger, warn: draftWarn } : logger;
    },
  };
});

describeTelegramDispatch("dispatchTelegramMessage draft-failures-progress", () => {
  it("routes draft stream failures to the warn-level telegram logger with lane context", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    const draftParams = mockCallArg(createTelegramDraftStream) as {
      warn?: (message: string) => void;
    };
    expect(typeof draftParams.warn).toBe("function");
    draftWarn.mockClear();
    draftParams.warn?.("telegram stream preview failed: 400: Bad Request: chat not found");

    expect(draftWarn).toHaveBeenCalledWith(
      "telegram stream preview failed: 400: Bad Request: chat not found",
      { lane: "answer", chatId: 123, threadId: 777 },
    );
  });

  it("sends an error fallback when dispatch fails after only partial output", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "partial answer" }, { kind: "block" });
      throw new Error("dispatch failed after partial output");
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: createDirectSessionPayload(),
      }),
      streamMode: "off",
    });

    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expectDeliveredReply(0, { text: "partial answer" });
    expectDeliveredReply(
      0,
      {
        text: "Something went wrong while processing your request. Please try again.",
      },
      1,
    );
  });

  it("returns retryable when dispatch fails after partial output and the fallback is not delivered", async () => {
    deliverReplies.mockResolvedValueOnce({ delivered: true });
    deliverReplies.mockResolvedValueOnce({ delivered: false });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "partial answer" }, { kind: "block" });
      throw new Error("dispatch failed after partial output");
    });

    const result = await dispatchWithContext({
      context: createContext({
        ctxPayload: createDirectSessionPayload(),
      }),
      retryDispatchErrors: true,
      streamMode: "off",
    });

    expect(result).toMatchObject({ kind: "failed-retryable" });
    expect((result as { error?: unknown }).error).toBeInstanceOf(Error);
    expect(deliverReplies).toHaveBeenCalledTimes(2);
    expectDeliveredReply(0, { text: "partial answer" });
    expectDeliveredReply(
      0,
      {
        text: "Something went wrong while processing your request. Please try again.",
      },
      1,
    );
  });

  it("returns retryable when spooled replay suppresses fallback after non-silent delivery skip", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      dispatcherOptions.onSkip?.({ text: "final answer" }, { kind: "final", reason: "empty" });
      return { queuedFinal: false };
    });

    const result = await dispatchWithContext({
      context: createContext(),
      retryDispatchErrors: true,
      suppressFailureFallback: true,
    });

    expect(result).toMatchObject({ kind: "failed-retryable" });
    expect((result as { error?: unknown }).error).toBeInstanceOf(Error);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not return retryable after spooled replay already showed visible output", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "partial answer" }, { kind: "block" });
      dispatcherOptions.onSkip?.({ text: "final answer" }, { kind: "final", reason: "empty" });
      return { queuedFinal: false };
    });

    const result = await dispatchWithContext({
      context: createContext(),
      retryDispatchErrors: true,
      suppressFailureFallback: true,
    });

    expect(result).toEqual({ kind: "completed" });
    expect(answerDraftStream.update).toHaveBeenCalledWith("partial answer");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("keeps tool progress visible after a partial-streamed intermediate block", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Site A shows X." });
        await dispatcherOptions.deliver({ text: "Site A shows X." }, { kind: "block" });
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update.mock.calls).toEqual([["Site A shows X."], ["Final answer"]]);
    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/🛠️ Exec<\/b>$/) }),
    );
    // The tool-progress window repositions before the final (deferred delete),
    // never an immediate clear/delete.
    expect(answerDraftStream.rotateToNewMessageDeferringDelete).toHaveBeenCalledTimes(1);
    // The reposition rewinds the stream BEFORE any deliverer cleanup clear(),
    // so that clear finds no live message id and never deletes the window.
    if (answerDraftStream.clear.mock.invocationCallOrder.length > 0) {
      expect(
        requireInvocationOrder(
          answerDraftStream.rotateToNewMessageDeferringDelete,
          0,
          "first deferred answer draft rotation",
        ),
      ).toBeLessThan(
        requireInvocationOrder(answerDraftStream.clear, 0, "first answer draft clear"),
      );
    }
    const progressResetOrder = requireInvocationOrder(
      answerDraftStream.forceNewMessage,
      0,
      "first answer draft rotation",
    );
    const progressUpdateOrder = requireInvocationOrder(
      answerDraftStream.updatePreview,
      0,
      "first answer preview update",
    );
    expect(progressResetOrder).toBeLessThan(progressUpdateOrder);
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("preserves streamed text blocks that follow tool progress before the final answer", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await dispatcherOptions.deliver({ text: "Site A shows X." }, { kind: "block" });
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Site B shows Y." }, { kind: "block" });
        await dispatcherOptions.deliver({ text: "Final answer" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Site A shows X.");
    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/🛠️ Exec<\/b>$/) }),
    );
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Site B shows Y.");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(3, "Final answer");
    // The tool-progress window repositions (deferred delete) rather than an
    // immediate clear when the following text block takes over the lane.
    expect(answerDraftStream.rotateToNewMessageDeferringDelete).toHaveBeenCalledTimes(1);
    // The reposition rewinds the stream BEFORE any deliverer cleanup clear(),
    // so that clear finds no live message id and never deletes the window.
    if (answerDraftStream.clear.mock.invocationCallOrder.length > 0) {
      expect(
        requireInvocationOrder(
          answerDraftStream.rotateToNewMessageDeferringDelete,
          0,
          "first deferred answer draft rotation",
        ),
      ).toBeLessThan(
        requireInvocationOrder(answerDraftStream.clear, 0, "first answer draft clear"),
      );
    }
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("keeps compaction replay on the same answer stream", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Partial before compaction" });
        await replyOptions?.onCompactionStart?.();
        await replyOptions?.onPartialReply?.({ text: "Partial before compaction" });
        await dispatcherOptions.deliver({ text: "Final after compaction" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.forceNewMessage).not.toHaveBeenCalled();
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Partial before compaction");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Final after compaction");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("rotates a tool-progress-only answer draft before streaming the final answer", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Branch is up to date" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/🛠️ Exec<\/b>$/) }),
    );
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Branch is up to date");
    // Reposition, not delete-then-repost: the tool-progress window is rewound
    // for a new message and its delete deferred until after the replacement
    // lands. clear() (immediate delete) must NOT run — that scroll-jumps.
    expect(answerDraftStream.rotateToNewMessageDeferringDelete).toHaveBeenCalledTimes(1);
    // The reposition rewinds the stream BEFORE any deliverer cleanup clear(),
    // so that clear finds no live message id and never deletes the window.
    if (answerDraftStream.clear.mock.invocationCallOrder.length > 0) {
      expect(
        requireInvocationOrder(
          answerDraftStream.rotateToNewMessageDeferringDelete,
          0,
          "first deferred answer draft rotation",
        ),
      ).toBeLessThan(
        requireInvocationOrder(answerDraftStream.clear, 0, "first answer draft clear"),
      );
    }
    const rotationOrder = requireInvocationOrder(
      answerDraftStream.rotateToNewMessageDeferringDelete,
      0,
      "first deferred answer draft rotation",
    );
    const finalUpdateOrder = requireInvocationOrder(
      answerDraftStream.update,
      0,
      "first answer draft update",
    );
    expect(rotationOrder).toBeLessThan(finalUpdateOrder);
  });

  it("clears a tool-progress-only draft across assistant boundaries before final text", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions?.onAssistantMessageStart?.();
        await dispatcherOptions.deliver({ text: "Branch is up to date" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringMatching(/🛠️ Exec<\/b>$/) }),
    );
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "Branch is up to date");
    // Across an assistant boundary the tool-progress window still repositions
    // (new message first, deferred delete) rather than deleting immediately.
    expect(answerDraftStream.rotateToNewMessageDeferringDelete).toHaveBeenCalledTimes(1);
    // The reposition rewinds the stream BEFORE any deliverer cleanup clear(),
    // so that clear finds no live message id and never deletes the window.
    if (answerDraftStream.clear.mock.invocationCallOrder.length > 0) {
      expect(
        requireInvocationOrder(
          answerDraftStream.rotateToNewMessageDeferringDelete,
          0,
          "first deferred answer draft rotation",
        ),
      ).toBeLessThan(
        requireInvocationOrder(answerDraftStream.clear, 0, "first answer draft clear"),
      );
    }
    const rotationOrder = requireInvocationOrder(
      answerDraftStream.rotateToNewMessageDeferringDelete,
      0,
      "first deferred answer draft rotation",
    );
    const finalUpdateOrder = requireInvocationOrder(
      answerDraftStream.update,
      0,
      "first answer draft update",
    );
    expect(rotationOrder).toBeLessThan(finalUpdateOrder);
  });

  it("rotates a verbose tool result draft before streaming the final answer", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "🛠️ Exec: pnpm test" }, { kind: "tool" });
      await dispatcherOptions.deliver({ text: "Tests passed" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "🛠️ Exec: pnpm test");
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(2, "Tests passed");
    // Verbose tool result window repositions before the final: new message
    // first, superseded delete deferred (no immediate clear/delete).
    expect(answerDraftStream.rotateToNewMessageDeferringDelete).toHaveBeenCalledTimes(1);
    // The reposition rewinds the stream BEFORE any deliverer cleanup clear(),
    // so that clear finds no live message id and never deletes the window.
    if (answerDraftStream.clear.mock.invocationCallOrder.length > 0) {
      expect(
        requireInvocationOrder(
          answerDraftStream.rotateToNewMessageDeferringDelete,
          0,
          "first deferred answer draft rotation",
        ),
      ).toBeLessThan(
        requireInvocationOrder(answerDraftStream.clear, 0, "first answer draft clear"),
      );
    }
    const rotationOrder = requireInvocationOrder(
      answerDraftStream.rotateToNewMessageDeferringDelete,
      0,
      "first deferred answer draft rotation",
    );
    const finalUpdateOrder = requireInvocationOrder(
      answerDraftStream.update,
      1,
      "second answer draft update",
    );
    expect(rotationOrder).toBeLessThan(finalUpdateOrder);
  });

  it("keeps progress updates in a draft and sends the final answer normally", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    answerDraftStream.hasConsumedReplyTarget.mockReturnValue(true);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions?.onItemEvent?.({
          kind: "command",
          name: "exec",
          progressText: "git rev-parse --abbrev-ref HEAD",
        });
        await dispatcherOptions.deliver({ text: "Branch is up to date" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Cracking" } } },
    });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview(
        "Cracking\n\n🛠️ Exec\n🛠️ git rev-parse --abbrev-ref HEAD",
        "<b>Cracking</b>\n<b>🛠️ Exec</b>\n<b>🛠️ Exec</b> <code>git rev-parse --abbrev-ref HEAD</code>",
      ),
    );
    expect(answerDraftStream.update).not.toHaveBeenCalledWith("Branch is up to date");
    expect(answerDraftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    // The window collapses IN PLACE into the one-line activity summary (edit,
    // not delete + repost — Discord parity), so clear() is never called on it.
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
    expectDeliveredReply(0, { text: "Branch is up to date" });
    expectDeliverRepliesParams({ replyToMode: "off" });
    // The final answer is SENT before the window collapses into the bar: sending
    // first keeps the final at the bottom of the anchored viewport, so shrinking
    // the tall window above it never drops the final off screen.
    expect(requireInvocationOrder(deliverReplies, 0, "first reply delivery")).toBeLessThan(
      requireInvocationOrder(
        answerDraftStream.finalizeToPreview,
        0,
        "first answer draft finalization",
      ),
    );
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("delivers a block-only progress turn as the terminal answer", async () => {
    const { answerDraftStream } = setupDraftStreams();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "Terminal block answer" },
        { kind: "block", assistantMessageIndex: 0 },
      );
      return { queuedFinal: false, counts: { block: 1, final: 0, tool: 0 } };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Cracking" } } },
    });

    expect(answerDraftStream.update).not.toHaveBeenCalledWith("Terminal block answer");
    expect(answerDraftStream.finalizeToPreview).not.toHaveBeenCalled();
    expectDeliveredReply(0, { text: "Terminal block answer" });
  });

  it("uses a block-only terminal answer instead of prior tool-progress text", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver(
          { text: "Terminal block after tool" },
          { kind: "block", assistantMessageIndex: 0 },
        );
        return { queuedFinal: false, counts: { block: 1, final: 0, tool: 1 } };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress", progress: { label: "Cracking" } } },
    });

    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining("Exec") }),
    );
    expectDeliveredReply(0, { text: "Terminal block after tool" });
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
    expect(requireInvocationOrder(deliverReplies, 0, "first reply delivery")).toBeLessThan(
      requireInvocationOrder(
        answerDraftStream.finalizeToPreview,
        0,
        "first answer draft finalization",
      ),
    );
  });

  function allDeliveredReplyTexts(): string[] {
    return deliverReplies.mock.calls.flatMap((call: unknown[]) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text ?? "",
      ),
    );
  }

  it("sends the final answer before collapsing the window into the bar", async () => {
    // Edit-shrink anchor loss: shrinking the tall window to a one-line bar BEFORE
    // the final is sent breaks the client's at-bottom follow and drops the final
    // off screen. The final must be sent FIRST, then the window edited down.
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "All done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    // Final delivered, then the window edited into the bar — final send precedes
    // the collapse edit.
    expectDeliveredReply(0, { text: "All done" });
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
    expect(requireInvocationOrder(deliverReplies, 0, "first reply delivery")).toBeLessThan(
      requireInvocationOrder(
        answerDraftStream.finalizeToPreview,
        0,
        "first answer draft finalization",
      ),
    );
    // The bar counters are snapshotted before the final send, so the count is
    // stable (one tool call — the final's own delivery does not perturb it).
    expect(answerDraftStream.finalizeToPreview).toHaveBeenCalledTimes(1);
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
  });

  it("still collapses the window when the final answer send is skipped", async () => {
    // Failure path: if the final send skips/fails, the window must not be left
    // stale — it still collapses to the bar (once-guard already consumed).
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    deliverReplies.mockResolvedValue({ delivered: false });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver({ text: "Answer that fails to send" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    // The bar still edits the window in place even though the final send failed.
    expectWindowCollapsedTo(answerDraftStream, "🛠️ 1 tool call · ⏱️ 1s");
  });

  it("tallies reasoning bursts and tool calls into the collapse summary", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        // burst 1 → tool → burst 2 → tool, then a trailing burst flushed at the
        // summary: 3 thoughts, 2 tool calls.
        await replyOptions?.onReasoningStream?.({ text: "thinking a" });
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions?.onReasoningStream?.({ text: "thinking b" });
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await replyOptions?.onReasoningStream?.({ text: "thinking c" });
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      // Reasoning must resolve to "stream" so thoughts route into the progress
      // window — only window-streamed reasoning feeds the collapse summary.
      context: createReasoningStreamContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    expectWindowCollapsedTo(answerDraftStream, "🧠 3 thoughts · 🛠️ 2 tool calls · ⏱️ 1s");
    expectDeliveredReply(0, { text: "Done" });
  });

  it("does not post a collapse summary when no progress draft started", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      // No tools, thoughts, or notes — nothing collapses; just a final answer.
      await dispatcherOptions.deliver({ text: "Just an answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    const texts = allDeliveredReplyTexts();
    expect(texts.some((text) => text.includes("⏱️"))).toBe(false);
    expect(texts).toContain("Just an answer");
  });

  it("does not post a collapse summary before an error final", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        await dispatcherOptions.deliver(
          { text: "Something went wrong", isError: true },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    const texts = allDeliveredReplyTexts();
    expect(texts.some((text) => text.includes("tool call · ⏱️"))).toBe(false);
  });
});
