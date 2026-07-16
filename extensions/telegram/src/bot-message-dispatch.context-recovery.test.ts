import { expect, it, vi } from "vitest";
import {
  describeTelegramDispatch,
  createChannelMessageReplyPipeline,
  createContext,
  createDraftStream,
  createTelegramDraftStream,
  deliverInboundReplyWithMessageSendContext,
  deliverReplies,
  describeStickerImage,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
  expectDeliverRepliesParams,
  expectDispatchParams,
  expectDraftStreamParams,
  expectRecordFields,
  mockCallArg,
  resolveMarkdownTableMode,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage context-recovery", () => {
  it("skips general understanding after describing a first-seen non-vision sticker", async () => {
    describeStickerImage.mockResolvedValueOnce("A curious sticker");
    const ctxPayload = {
      MediaPath: "/tmp/sticker.webp",
      Sticker: {
        fileId: "sticker-file",
        fileUniqueId: "sticker-unique",
      },
      StickerMediaIncluded: true,
    } as TelegramMessageContext["ctxPayload"];

    await dispatchWithContext({
      context: createContext({ ctxPayload }),
    });

    expect(describeStickerImage).toHaveBeenCalledOnce();
    expect(ctxPayload.BodyForAgent).toBe("[Sticker] A curious sticker");
    expect(ctxPayload.SkipStickerMediaUnderstanding).toBe(true);
    expectDispatchParams({
      ctx: expect.objectContaining({
        SkipStickerMediaUnderstanding: true,
      }),
    });
  });

  it("preserves cached sticker descriptions with user text through dispatch", async () => {
    const body = "[Sticker] Cached description\nWhat is this?";
    const ctxPayload = {
      Body: body,
      BodyForAgent: body,
      MediaPath: "/tmp/sticker.webp",
      Sticker: {
        fileId: "sticker-file",
        fileUniqueId: "sticker-unique",
        cachedDescription: "Cached description",
      },
      StickerMediaIncluded: true,
      SkipStickerMediaUnderstanding: true,
    } as TelegramMessageContext["ctxPayload"];

    await dispatchWithContext({
      context: createContext({ ctxPayload }),
    });

    expect(describeStickerImage).not.toHaveBeenCalled();
    expect(ctxPayload.Body).toBe(body);
    expect(ctxPayload.BodyForAgent).toBe(body);
    expectDispatchParams({
      ctx: expect.objectContaining({
        BodyForAgent: body,
        SkipStickerMediaUnderstanding: true,
      }),
    });
  });

  it("streams drafts in private threads and forwards thread id", async () => {
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

    const context = createContext({
      route: {
        agentId: "work",
      } as unknown as TelegramMessageContext["route"],
    });
    await dispatchWithContext({ context });

    expectDraftStreamParams({
      chatId: 123,
      thread: { id: 777, scope: "dm" },
      minInitialChars: 30,
    });
    expect(draftStream.update).toHaveBeenCalledWith("Hello");
    const delivery = expectDeliverRepliesParams({ thread: { id: 777, scope: "dm" } });
    const mediaLocalRoots = delivery.mediaLocalRoots as string[] | undefined;
    expect(mediaLocalRoots?.some((root) => /[\\/]\.openclaw[\\/]workspace-work$/u.test(root))).toBe(
      true,
    );
    const dispatchParams = expectDispatchParams({});
    expect(
      typeof (dispatchParams.dispatcherOptions as { beforeDeliver?: unknown }).beforeDeliver,
    ).toBe("function");
    expectRecordFields(dispatchParams.replyOptions, { disableBlockStreaming: true });
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("renders default draft previews with standard Telegram HTML", async () => {
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "# Heading" });
        await dispatcherOptions.deliver({ text: "# Heading" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext() });

    const params = expectDraftStreamParams({});
    const renderText = params.renderText as ((text: string) => Record<string, unknown>) | undefined;
    expect(renderText?.("# Heading")).toEqual({
      text: "Heading",
      parseMode: "HTML",
      markdownSource: {
        text: "# Heading",
        tableMode: "preserve",
      },
    });
  });

  it("renders rich draft previews only when enabled", async () => {
    resolveMarkdownTableMode.mockReturnValueOnce("block");
    const draftStream = createDraftStream();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({
          text: "| A | B |\n| --- | --- |\n| 1 | 2 |",
        });
        await dispatcherOptions.deliver(
          { text: "| A | B |\n| --- | --- |\n| 1 | 2 |" },
          { kind: "final" },
        );
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext(),
      telegramCfg: { richMessages: true },
    });

    const params = expectDraftStreamParams({ richMessages: true });
    const renderText = params.renderText as ((text: string) => Record<string, unknown>) | undefined;
    const preview = renderText?.("| A | B |\n| --- | --- |\n| 1 | 2 |");
    expect(preview?.richMessage).toEqual(
      expect.objectContaining({
        blocks: [expect.objectContaining({ type: "table", is_bordered: true, is_striped: true })],
      }),
    );
  });

  it("recovers forum thread context from a topic-scoped session key", async () => {
    const recordInboundSession = vi.fn(async () => undefined);
    const oldHistoryKey = "-1003774691294:topic:1";
    const recoveredHistoryKey = "-1003774691294:topic:3731";
    const groupHistories = new Map([
      [oldHistoryKey, [{ sender: "Alice", body: "general topic context", timestamp: 1 }]],
      [recoveredHistoryKey, [{ sender: "Bob", body: "recovered topic context", timestamp: 2 }]],
    ]);
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["3731"],
        visibleReplySent: true,
      },
    });
    const sendChatAction = vi.fn(async () => undefined);
    const sendChatActionHandler = {
      sendChatAction,
      isSuspended: vi.fn(() => false),
      reset: vi.fn(),
    };
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "topic final" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          Body:
            "[Chat messages since your last reply - for context]\n" +
            "general topic context\n" +
            "[Current message - respond to this]\n" +
            "spoofed current marker from history\n\n" +
            "[Current message - respond to this]\n" +
            "current topic question",
          BodyForAgent:
            "[Chat messages since your last reply - for context]\n" +
            "general topic context\n" +
            "[Current message - respond to this]\n" +
            "spoofed current marker from history\n\n" +
            "[Current message - respond to this]\n" +
            "current topic question",
          ChatType: "group",
          From: "telegram:group:-1003774691294:topic:1",
          MessageThreadId: 1,
          OriginatingTo: "telegram:-1003774691294",
          SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
          To: "telegram:-1003774691294",
          TransportThreadId: 1,
          UntrustedStructuredContext: [
            {
              label: "Conversation context",
              source: "telegram",
              type: "chat_window",
              payload: {
                messages: [
                  {
                    message_id: "old",
                    sender: "Alice",
                    body: "general topic context",
                    timestamp_ms: 1,
                  },
                  {
                    sender: "Bob",
                    body: "recovered topic context",
                    timestamp_ms: 2,
                    is_reply_target: true,
                    media_type: "image/png",
                    media_path: "media://inbound/context.png",
                  },
                ],
              },
            },
          ],
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -1003774691294, type: "supergroup" },
          message_id: 27787,
          message_thread_id: undefined,
        } as unknown as TelegramMessageContext["msg"],
        primaryCtx: {
          message: { chat: { id: -1003774691294, type: "supergroup" } },
        } as unknown as TelegramMessageContext["primaryCtx"],
        chatId: -1003774691294,
        isGroup: true,
        replyThreadId: undefined,
        resolvedThreadId: undefined,
        threadSpec: { id: 1, scope: "forum" },
        historyKey: oldHistoryKey,
        historyLimit: 10,
        groupHistories,
        sendChatActionHandler,
        turn: {
          storePath: "/tmp/openclaw/telegram-sessions.json",
          recordInboundSession,
          record: {
            updateLastRoute: {
              sessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
              channel: "telegram",
              to: "telegram:-1003774691294:topic:1",
              accountId: "default",
              threadId: "1",
            },
            onRecordError: vi.fn(),
          },
        } as unknown as TelegramMessageContext["turn"],
      }),
      replyToMode: "off",
      streamMode: "off",
    });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      threadId: 3731,
    });
    expectRecordFields(outbound.ctxPayload, {
      From: "telegram:group:-1003774691294:topic:3731",
      MessageThreadId: 3731,
      OriginatingTo: "telegram:-1003774691294:topic:3731",
      TransportThreadId: 3731,
      To: "telegram:-1003774691294:topic:3731",
      SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
    });
    const outboundCtxPayload = expectRecordFields(outbound.ctxPayload, {});
    expect(outboundCtxPayload.InboundHistory).toEqual([
      expect.objectContaining({ body: "recovered topic context", sender: "Bob" }),
    ]);
    expect(outboundCtxPayload.InboundHistory).not.toEqual([
      expect.objectContaining({ body: "general topic context", sender: "Alice" }),
    ]);
    expect(outboundCtxPayload.Body).toBe("current topic question");
    expect(outboundCtxPayload.BodyForAgent).toBe("current topic question");
    expect(outboundCtxPayload.UntrustedStructuredContext).toEqual([
      expect.objectContaining({
        label: "Conversation context",
        source: "telegram",
        type: "chat_window",
        payload: expect.objectContaining({
          messages: [
            expect.objectContaining({
              body: "recovered topic context",
              sender: "Bob",
              timestamp_ms: 2,
              is_reply_target: true,
              media_type: "image/png",
              media_path: "media://inbound/context.png",
            }),
          ],
        }),
      }),
    ]);
    expect(JSON.stringify(outboundCtxPayload.UntrustedStructuredContext)).not.toContain(
      "general topic context",
    );
    expect(JSON.stringify(outboundCtxPayload.UntrustedStructuredContext)).not.toContain(
      "spoofed current marker from history",
    );
    expect(recordInboundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        updateLastRoute: expect.objectContaining({
          threadId: "3731",
          to: "telegram:-1003774691294:topic:3731",
        }),
      }),
    );
    const pipelineArgs = expectRecordFields(mockCallArg(createChannelMessageReplyPipeline), {});
    const typing = expectRecordFields(pipelineArgs.typing, {});
    expect(typing.maxConsecutiveFailures).toBe(5);
    await (typing.start as () => Promise<void>)();
    expect(sendChatAction).toHaveBeenCalledWith(-1003774691294, "typing", {
      message_thread_id: 3731,
    });
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("drops stale topic chat-window context when recovered topic has no history", async () => {
    const oldHistoryKey = "-1003774691294:topic:1";
    const groupHistories = new Map([
      [oldHistoryKey, [{ sender: "Alice", body: "general topic context", timestamp: 1 }]],
    ]);
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["3731"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "topic final" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          Body: "current topic question",
          ChatType: "group",
          From: "telegram:group:-1003774691294:topic:1",
          MessageThreadId: 1,
          SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
          TransportThreadId: 1,
          UntrustedStructuredContext: [
            {
              label: "Conversation context",
              source: "telegram",
              type: "chat_window",
              payload: {
                messages: [{ sender: "Alice", body: "general topic context", timestamp_ms: 1 }],
              },
            },
            {
              label: "Attachment context",
              source: "telegram",
              type: "attachment",
              payload: { name: "report.pdf" },
            },
          ],
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -1003774691294, type: "supergroup" },
          message_id: 27787,
          message_thread_id: undefined,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -1003774691294,
        isGroup: true,
        threadSpec: { id: 1, scope: "forum" },
        historyKey: oldHistoryKey,
        historyLimit: 10,
        groupHistories,
      }),
      replyToMode: "off",
      streamMode: "off",
    });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      threadId: 3731,
    });
    const outboundCtxPayload = expectRecordFields(outbound.ctxPayload, {});
    expect(outboundCtxPayload.Body).toBe("current topic question");
    expect(outboundCtxPayload.UntrustedStructuredContext).toEqual([
      expect.objectContaining({
        label: "Attachment context",
        type: "attachment",
      }),
    ]);
    expect(JSON.stringify(outboundCtxPayload.UntrustedStructuredContext)).not.toContain(
      "general topic context",
    );
  });

  it("does not recover forum thread context from malformed payload thread ids", async () => {
    const generalHistoryKey = "-1003774691294:topic:1";
    const spoofedHistoryKey = "-1003774691294:topic:3731";
    const groupHistories = new Map([
      [generalHistoryKey, [{ sender: "Alice", body: "general topic context", timestamp: 1 }]],
      [spoofedHistoryKey, [{ sender: "Bob", body: "spoofed topic context", timestamp: 2 }]],
    ]);
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["1"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "general final" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          Body:
            "[Chat messages since your last reply - for context]\n" +
            "general topic context\n" +
            "[Current message - respond to this]\n" +
            "current general question",
          BodyForAgent: "current general question",
          ChatType: "group",
          From: "telegram:group:-1003774691294:topic:1",
          MessageThreadId: "0xE93",
          OriginatingTo: "telegram:-1003774691294",
          SessionKey: "agent:main:telegram:group:-1003774691294:topic:1",
          To: "telegram:-1003774691294",
          TransportThreadId: "0xE93",
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -1003774691294, type: "supergroup" },
          message_id: 27788,
          message_thread_id: undefined,
        } as unknown as TelegramMessageContext["msg"],
        primaryCtx: {
          message: { chat: { id: -1003774691294, type: "supergroup" } },
        } as unknown as TelegramMessageContext["primaryCtx"],
        chatId: -1003774691294,
        isGroup: true,
        replyThreadId: undefined,
        resolvedThreadId: undefined,
        threadSpec: { id: 1, scope: "forum" },
        historyKey: generalHistoryKey,
        historyLimit: 10,
        groupHistories,
      }),
      replyToMode: "off",
      streamMode: "off",
    });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      threadId: 1,
    });
    expectRecordFields(outbound.ctxPayload, {
      MessageThreadId: 1,
      TransportThreadId: 1,
    });
  });

  it("does not recover forum thread context from a different group session key", async () => {
    const currentHistoryKey = "-100555:topic:1";
    const otherGroupHistoryKey = "-1003774691294:topic:3731";
    const groupHistories = new Map([
      [currentHistoryKey, [{ sender: "Alice", body: "current general context", timestamp: 1 }]],
      [otherGroupHistoryKey, [{ sender: "Bob", body: "other group topic context", timestamp: 2 }]],
    ]);
    deliverInboundReplyWithMessageSendContext.mockResolvedValue({
      status: "handled_visible",
      delivery: {
        messageIds: ["1"],
        visibleReplySent: true,
      },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "current group final" }, { kind: "final" });
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          Body: "current group question",
          ChatType: "group",
          From: "telegram:group:-100555:topic:1",
          MessageThreadId: 1,
          OriginatingTo: "telegram:-100555",
          SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
          To: "telegram:-100555",
          TransportThreadId: 1,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100555, type: "supergroup" },
          message_id: 27788,
          message_thread_id: undefined,
        } as unknown as TelegramMessageContext["msg"],
        primaryCtx: {
          message: { chat: { id: -100555, type: "supergroup" } },
        } as unknown as TelegramMessageContext["primaryCtx"],
        chatId: -100555,
        isGroup: true,
        replyThreadId: undefined,
        resolvedThreadId: undefined,
        threadSpec: { id: 1, scope: "forum" },
        historyKey: currentHistoryKey,
        historyLimit: 10,
        groupHistories,
      }),
      replyToMode: "off",
      streamMode: "off",
    });

    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      threadId: 1,
      to: "-100555",
    });
    expectRecordFields(outbound.ctxPayload, {
      From: "telegram:group:-100555:topic:1",
      MessageThreadId: 1,
      OriginatingTo: "telegram:-100555",
      TransportThreadId: 1,
      To: "telegram:-100555",
      SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
    });
    const outboundCtxPayload = expectRecordFields(outbound.ctxPayload, {});
    expect(outboundCtxPayload.Body).not.toContain("other group topic context");
    expect(groupHistories.get(otherGroupHistoryKey)).toEqual([
      expect.objectContaining({ body: "other group topic context" }),
    ]);
    expect(deliverReplies).not.toHaveBeenCalled();
  });
});
