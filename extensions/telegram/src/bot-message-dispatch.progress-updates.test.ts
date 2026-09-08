import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { expect, it } from "vitest";
import {
  appendAssistantMirrorMessageByIdentity,
  type DispatchReplyWithBufferedBlockDispatcherArgs,
  describeTelegramDispatch,
  createContext,
  createSequencedDraftStream,
  createTelegramDraftStream,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
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
  type TelegramMessageContext,
} from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage progress-updates", () => {
  it.each(["tool start", "command output"] as const)(
    "does not restart progress drafts for %s after final answer delivery",
    async (lateCallback) => {
      const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
        async ({ dispatcherOptions, replyOptions }) => {
          await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
          await dispatcherOptions.deliver({ text: "Branch is up to date" }, { kind: "final" });
          if (lateCallback === "tool start") {
            await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
          } else {
            await replyOptions?.onCommandOutput?.({
              phase: "end",
              title: "Exec",
              name: "exec",
              status: "failed",
              exitCode: 1,
            });
          }
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
    },
  );

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

  it.each(["partial", "block", "progress"] as const)(
    "keeps one exec row without forcing summaries in %s mode",
    async (mode) => {
      const draftStream = createSequencedDraftStream(2001);
      createTelegramDraftStream.mockReturnValue(draftStream);
      dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
        await replyOptions?.onReplyStart?.();
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onToolStart?.({ name: "exec", phase: "start", toolCallId: "exec-1" });
        await replyOptions?.onItemEvent?.({
          itemId: "command:exec-1",
          toolCallId: "exec-1",
          kind: "command",
          name: "exec",
          status: "running",
        });
        if (replyOptions?.forceToolResultProgress) {
          await replyOptions.onToolResult?.({ text: "🛠️ Exec" });
        }
        await replyOptions?.onCommandOutput?.({
          toolCallId: "exec-1",
          phase: "end",
          name: "exec",
          exitCode: 0,
        });
        return { queuedFinal: false };
      });

      await dispatchWithContext({
        context: createContext(),
        streamMode: mode,
        telegramCfg: {
          streaming: { mode, progress: { toolProgress: true, label: "Shelling" } },
        },
      });

      expect(draftStream.updatePreview).toHaveBeenLastCalledWith(
        telegramProgressPreview("Shelling\n\n🛠️ Exec", "<b>Shelling</b>\n<b>🛠️ Exec</b>"),
      );
      if (mode === "progress") {
        expect(draftStream.flush).toHaveBeenCalled();
      }
    },
  );

  it("keeps a dynamic tool lifecycle and formatted summary in one row", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolResult?.({
        text: "🧭 Agents",
        channelData: { openclawToolProgressId: "dynamic-1" },
      });
      await replyOptions?.onToolStart?.({
        name: "agents_list",
        phase: "start",
        itemId: "dynamic-1",
        toolCallId: "dynamic-1",
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Working" } },
      },
    });

    expect(draftStream.updatePreview).toHaveBeenLastCalledWith(
      telegramProgressPreview("Working\n\n🧭 Agents", "<b>Working</b>\n<b>🧭 Agents</b>"),
    );
  });

  it("keeps raw structured detail when its formatted summary arrives", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({
        name: "exec",
        phase: "start",
        itemId: "command-1",
        toolCallId: "command-1",
        args: { command: "echo private" },
        detailMode: "raw",
      });
      await replyOptions?.onToolResult?.({
        text: "🛠️ Bash",
        channelData: { openclawToolProgressId: "command-1" },
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { toolProgress: true, commandText: "raw", label: "Working" },
        },
      },
    });

    const previewText = draftStream.updatePreview.mock.calls.at(-1)?.[0]?.text;
    expect(previewText).toContain("echo private");
    expect(previewText?.match(/🛠️/gu)).toHaveLength(1);
  });

  it("reopens progress drafts for queued followups after the source dispatch settles", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    let queuedReplyOptions: DispatchReplyWithBufferedBlockDispatcherArgs["replyOptions"];
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      queuedReplyOptions = replyOptions;
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: { mode: "progress", progress: { toolProgress: true, label: "Shelling" } },
      },
    });

    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    await queuedReplyOptions?.onQueuedFollowupAdmitted?.();
    await queuedReplyOptions?.onToolStart?.({ name: "exec", phase: "start" });
    await queuedReplyOptions?.onToolResult?.({ text: "📄 Web Fetch: working" });

    expect(draftStream.forceNewMessage).toHaveBeenCalledTimes(1);
    expect(draftStream.updatePreview).toHaveBeenCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🛠️ Exec\n📄 Web Fetch: working",
        "<b>Shelling</b>\n<b>🛠️ Exec</b>\n📄 Web Fetch: working",
      ),
    );

    await queuedReplyOptions?.onQueuedFollowupSettled?.();
    expect(draftStream.clear).toHaveBeenCalledTimes(2);
  });

  it("keeps eight rolling tool rows beneath a preamble with verbose off", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onReplyStart?.();
        await replyOptions?.onAssistantMessageStart?.();
        await replyOptions?.onItemEvent?.({
          kind: "preamble",
          itemId: "preamble-1",
          progressText: "I'll make exactly 10 harmless, read-only tool calls.",
        });
        for (let index = 1; index <= 10; index += 1) {
          await replyOptions?.onToolStart?.({
            phase: "start",
            name: "exec",
            toolCallId: `exec-${index}`,
            args: { command: `command-${index}` },
          });
        }
        await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );

    await dispatchWithContext({
      context: createContext(),
      cfg: { agents: { defaults: { verboseDefault: "off" } } },
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { commandText: "raw", maxLines: 8, toolProgress: true },
        },
      },
    });

    const rollingPreview = draftStream.updatePreview.mock.calls.at(-1)?.[0];
    expect(rollingPreview?.text).toContain("I'll make exactly 10 harmless, read-only tool calls.");
    expect(rollingPreview?.text).not.toContain("<code>command-1</code>");
    expect(rollingPreview?.text).not.toContain("<code>command-2</code>");
    for (let index = 3; index <= 10; index += 1) {
      expect(rollingPreview?.text).toContain(`command-${index}`);
    }
    expectDeliveredReply(0, { text: "Done" });
  });

  it("renders command status without command output in Telegram progress draft previews", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({
        name: "exec",
        phase: "start",
        toolCallId: "exec-1",
        args: { command: "false" },
      });
      await replyOptions?.onCommandOutput?.({
        phase: "end",
        title: "command false",
        name: "exec",
        toolCallId: "exec-1",
        output: "No such file or directory",
        exitCode: 2,
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { toolProgress: true, label: "Shelling", commandText: "raw" },
        },
      },
    });

    expect(draftStream.updatePreview).toHaveBeenLastCalledWith(
      telegramProgressPreview(
        "Shelling\n\n🛠️ exit 2; command false",
        "<b>Shelling</b>\n<b>🛠️ Exec</b> command false <i>exit 2</i>",
      ),
    );
  });

  it("hides command titles in Telegram status-only progress draft previews", async () => {
    const draftStream = createSequencedDraftStream(2001);
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReplyStart?.();
      await replyOptions?.onAssistantMessageStart?.();
      await replyOptions?.onToolStart?.({
        name: "exec",
        phase: "start",
        toolCallId: "exec-1",
        args: { command: "curl -H 'Authorization: token' https://example.test" },
      });
      await replyOptions?.onCommandOutput?.({
        phase: "end",
        title: "curl -H 'Authorization: token' https://example.test",
        name: "exec",
        toolCallId: "exec-1",
        output: "secret response",
        exitCode: 2,
      });
      return { queuedFinal: false };
    });

    await dispatchWithContext({
      context: createContext(),
      streamMode: "progress",
      telegramCfg: {
        streaming: {
          mode: "progress",
          progress: { toolProgress: true, label: "Shelling", commandText: "status" },
        },
      },
    });

    expect(draftStream.updatePreview).toHaveBeenLastCalledWith(
      telegramProgressPreview("Shelling\n\n🛠️ exit 2", "<b>Shelling</b>\n<b>🛠️ Exec</b> exit 2"),
    );
  });
});
