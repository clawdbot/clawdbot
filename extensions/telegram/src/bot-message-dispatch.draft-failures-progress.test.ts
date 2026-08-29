import { dispatchReplyWithBufferedBlockDispatcher as dispatchReplyWithBufferedBlockDispatcherRuntime } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { expect, it, vi } from "vitest";
import { expectWindowRetiredAfterFinal } from "./bot-message-dispatch.progress-window.test-helpers.js";
import {
  allDeliveredReplyTexts,
  describeTelegramDispatch,
  createContext,
  createBot,
  createDirectSessionPayload,
  createStatusReactionController,
  createTelegramDraftStream,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
  emitTelegramMessageSentHooks,
  expectDeliveredReply,
  expectDeliverRepliesParams,
  expectRecordFields,
  mockCallArg,
  requireInvocationOrder,
  setupDraftStreams,
  telegramProgressPreview,
} from "./bot-message-dispatch.test-harness.js";
import { createTestDraftStream } from "./draft-stream.test-helpers.js";

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

  it.each([
    {
      label: "direct chat",
      createMessageContext: () =>
        createContext({
          ctxPayload: createDirectSessionPayload(),
        }),
    },
    {
      label: "group chat",
      createMessageContext: () =>
        createContext({
          chatId: -100123,
          isGroup: true,
          ctxPayload: {
            ...createDirectSessionPayload(),
            SessionKey: "agent:test:telegram:group:-100123",
            ChatType: "group",
          },
          primaryCtx: {
            ...createContext().primaryCtx,
            message: {
              chat: { id: -100123, type: "supergroup", title: "Test group" },
              date: 0,
              message_id: 456,
            },
          },
          msg: {
            chat: { id: -100123, type: "supergroup", title: "Test group" },
            date: 0,
            message_id: 456,
            message_thread_id: undefined,
          },
          threadSpec: { id: undefined, scope: "none" },
          replyThreadId: undefined,
        }),
    },
  ])(
    "finalizes the default streamed draft in place after an unexpected reply failure in a $label",
    async ({ createMessageContext }) => {
      const statusReactionController = createStatusReactionController();
      const answerDraftStream = createTestDraftStream({
        onWaitForInFlight: () => answerDraftStream.setMessageId(2001),
      });
      const reasoningDraftStream = createTestDraftStream();
      createTelegramDraftStream
        .mockImplementationOnce(() => answerDraftStream)
        .mockImplementationOnce(() => reasoningDraftStream);
      let partialAccepted: boolean | void = undefined;
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async (params) => {
        expect(params.replyOptions?.disableBlockStreaming).toBe(true);
        return await dispatchReplyWithBufferedBlockDispatcherRuntime({
          ...params,
          replyResolver: async (_ctx, opts) => {
            opts?.onAgentRunStart?.("failed-run");
            partialAccepted = await opts?.onPartialReply?.({ text: "partial answer" });
            throw new Error("unexpected model failure");
          },
        });
      });
      const messageContext = createMessageContext();
      messageContext.statusReactionController = statusReactionController as never;

      await dispatchWithContext({
        context: messageContext,
        streamMode: "partial",
        telegramCfg: { streaming: { mode: "partial" } },
      });

      expect(partialAccepted).toBeUndefined();
      expect(answerDraftStream.waitForInFlight).toHaveBeenCalledOnce();
      expect(answerDraftStream.update).toHaveBeenNthCalledWith(1, "partial answer");
      expect(answerDraftStream.update).toHaveBeenCalledTimes(2);
      expect(answerDraftStream.update).toHaveBeenLastCalledWith(
        expect.stringMatching(
          /^partial answer\n\n.*Something went wrong while processing your request\. Please try again, or use \/new to start a fresh session\.$/,
        ),
        expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
      );
      expect(answerDraftStream.clear).not.toHaveBeenCalled();
      expect(deliverReplies).not.toHaveBeenCalled();
      expect(emitTelegramMessageSentHooks).toHaveBeenCalledTimes(1);
      expectRecordFields(mockCallArg(emitTelegramMessageSentHooks), { success: true });
      await vi.waitFor(() => {
        expect(statusReactionController.restoreInitial).toHaveBeenCalledTimes(1);
      });
      expect(statusReactionController.setError).toHaveBeenCalledTimes(1);
      expect(statusReactionController.setDone).not.toHaveBeenCalled();
      expect(
        requireInvocationOrder(
          statusReactionController.setThinking,
          0,
          "initial thinking status reaction",
        ),
      ).toBeLessThan(
        requireInvocationOrder(
          statusReactionController.setError,
          0,
          "terminal error status reaction",
        ),
      );
      expect(
        requireInvocationOrder(
          statusReactionController.setError,
          0,
          "terminal error status reaction",
        ),
      ).toBeLessThan(
        requireInvocationOrder(
          statusReactionController.restoreInitial,
          0,
          "initial status reaction restoration",
        ),
      );
    },
  );

  it("keeps a retried partial and its terminal failure in one Telegram message", async () => {
    const actualDraft =
      await vi.importActual<typeof import("./draft-stream.js")>("./draft-stream.js");
    createTelegramDraftStream.mockImplementation(actualDraft.createTelegramDraftStream);
    const bot = createBot();
    const partialText = "A visible partial answer before the provider failed";
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: partialText });
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onPartialReply?.({ text: partialText });
        await dispatcherOptions.deliver(
          { text: "The model failed. Please try again.", isError: true },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      bot,
      context: createContext({
        ctxPayload: createDirectSessionPayload(),
        threadSpec: { id: undefined, scope: "none" },
        replyThreadId: undefined,
      }),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(bot.api.sendMessage).toHaveBeenCalledOnce();
    expect(bot.api.editMessageText).toHaveBeenLastCalledWith(
      123,
      1001,
      `${partialText}\n\nThe model failed. Please try again.`,
      expect.anything(),
    );
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(bot.api.deleteMessage).not.toHaveBeenCalled();
  });

  it("clears a pending partial and sends one fallback after an unexpected reply failure", async () => {
    const { answerDraftStream } = setupDraftStreams();
    let partialAccepted: boolean | void = undefined;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async (params) => {
      return await dispatchReplyWithBufferedBlockDispatcherRuntime({
        ...params,
        replyResolver: async (_ctx, opts) => {
          partialAccepted = await opts?.onPartialReply?.({ text: "partial answer" });
          throw new Error("unexpected model failure");
        },
      });
    });

    await dispatchWithContext({
      context: createContext({ ctxPayload: createDirectSessionPayload() }),
      streamMode: "partial",
      telegramCfg: { streaming: { mode: "partial" } },
    });

    expect(partialAccepted).toBe(false);
    expect(answerDraftStream.update).toHaveBeenCalledOnce();
    expect(answerDraftStream.update).toHaveBeenCalledWith("partial answer");
    expect(answerDraftStream.clear).toHaveBeenCalledOnce();
    expect(deliverReplies).toHaveBeenCalledOnce();
    expectDeliveredReply(0, {
      text: "Something went wrong while processing your request. Please try again.",
    });
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

    expect(answerDraftStream.update.mock.calls).toEqual([
      ["Site A shows X."],
      ["Final answer", expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) })],
    ]);
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
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(
      3,
      "Final answer",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
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
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(
      2,
      "Final after compaction",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
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
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(
      1,
      "Branch is up to date",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
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
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(
      1,
      "Branch is up to date",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
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
    expect(answerDraftStream.update).toHaveBeenNthCalledWith(
      2,
      "Tests passed",
      expect.objectContaining({ onPlatformSendDispatch: expect.any(Function) }),
    );
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

    // #121600: default command progress is status-only — raw command text stays
    // out of chat previews (`/verbose full` / commandText: "raw" retain it).
    expect(answerDraftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview("Cracking\n\n🛠️ Exec", "<b>Cracking</b>\n<b>🛠️ Exec</b>"),
    );
    expect(answerDraftStream.update).not.toHaveBeenCalledWith("Branch is up to date");
    expect(answerDraftStream.forceNewMessage).not.toHaveBeenCalled();
    // A tool-only window retires by repositioning in place (not delete + repost
    // — Discord parity), so clear() is never called on it.
    expect(answerDraftStream.clear).not.toHaveBeenCalled();
    expectDeliveredReply(0, { text: "Branch is up to date" });
    expectDeliverRepliesParams({ replyToMode: "off" });
    // The final answer is SENT before the window retires: sending first keeps
    // the final at the bottom of the anchored viewport, so retiring the tall
    // window above it never drops the final off screen.
    expectWindowRetiredAfterFinal(answerDraftStream, deliverReplies);
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
    expectWindowRetiredAfterFinal(answerDraftStream, deliverReplies);
  });

  it("sends the final answer before retiring the progress window", async () => {
    // Deliver first so removing the progress window cannot move the final off screen.
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

    expectDeliveredReply(0, { text: "All done" });
    expectWindowRetiredAfterFinal(answerDraftStream, deliverReplies);
  });

  it("retires the progress window when the final answer send is skipped", async () => {
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

    expect(answerDraftStream.rotateToNewMessageDeferringDelete).toHaveBeenCalledTimes(1);
  });

  it("delivers only the final answer when no progress draft started", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Just an answer" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: { streaming: { mode: "progress" } },
    });

    expect(allDeliveredReplyTexts()).toEqual(["Just an answer"]);
  });

  it("delivers only the error final after tool progress", async () => {
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

    expect(allDeliveredReplyTexts()).toEqual(["Something went wrong"]);
  });
});
