import { expect, it } from "vitest";
import { resolveDispatchTelegramContext } from "./bot-message-dispatch-context.js";
import {
  describeTelegramDispatch,
  createBot,
  createContext,
  createDraftStream,
  createTelegramDraftStream,
  deliverInboundReplyWithMessageSendContext,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  expectRecordFields,
  mockCallArg,
} from "./bot-message-dispatch.test-harness.js";
import type {
  DispatchReplyWithBufferedBlockDispatcherArgs,
  TelegramBotDeps,
  TelegramMessageContext,
} from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage context-history", () => {
  it("keeps the host-bound payload object while recovering forum routing", () => {
    const ctxPayload = {
      From: "telegram:group:-1003774691294:topic:1",
      MessageThreadId: 1,
      SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
      TransportThreadId: 1,
    } as TelegramMessageContext["ctxPayload"];
    const context = createContext({
      ctxPayload,
      chatId: -1003774691294,
      isGroup: true,
      threadSpec: { id: 1, scope: "forum" },
    });

    const recovered = resolveDispatchTelegramContext({ context });

    expect(recovered.ctxPayload).toBe(ctxPayload);
    expect(recovered.ctxPayload).toMatchObject({
      From: "telegram:group:-1003774691294:topic:3731",
      MessageThreadId: 3731,
      TransportThreadId: 3731,
    });
  });

  it("moves recovered room-event history out of the original topic", async () => {
    const oldHistoryKey = "-1003774691294:topic:1";
    const recoveredHistoryKey = "-1003774691294:topic:3731";
    const groupHistories = new Map([
      [
        oldHistoryKey,
        [
          { sender: "Alice", body: "general topic context", timestamp: 1 },
          { sender: "Cara", body: "ambient leak", timestamp: 2, messageId: "27787" },
        ],
      ],
      [recoveredHistoryKey, [{ sender: "Bob", body: "recovered topic context", timestamp: 3 }]],
    ]);
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          InboundEventKind: "room_event",
          ChatType: "group",
          From: "telegram:group:-1003774691294:topic:1",
          MessageSid: "27787",
          MessageThreadId: 1,
          RawBody: "ambient leak",
          SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
          TransportThreadId: 1,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -1003774691294, type: "supergroup" },
          message_id: 27787,
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

    expect(groupHistories.get(oldHistoryKey)).toEqual([
      expect.objectContaining({ body: "general topic context" }),
    ]);
    expect(groupHistories.get(recoveredHistoryKey)).toEqual([
      expect.objectContaining({ body: "recovered topic context" }),
      expect.objectContaining({ body: "ambient leak", messageId: "27787" }),
    ]);
  });

  it("omits transcript-owned ambient rows from recovered room-event prompt text", async () => {
    const oldHistoryKey = "-1003774691294:topic:1";
    const recoveredHistoryKey = "-1003774691294:topic:3731";
    const groupHistories = new Map([
      [
        oldHistoryKey,
        [{ sender: "Cara", body: "ambient current", timestamp: 3, messageId: "27787" }],
      ],
      [
        recoveredHistoryKey,
        [
          {
            sender: "Alice",
            body: "persisted recovered ambient one",
            timestamp: 1,
            messageId: "199",
          },
          {
            sender: "Bob",
            body: "persisted recovered ambient two",
            timestamp: 2,
            messageId: "200",
          },
        ],
      ],
    ]);
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          InboundEventKind: "room_event",
          BodyForAgent: "ambient current",
          ChatType: "group",
          From: "telegram:group:-1003774691294:topic:1",
          MessageSid: "27787",
          MessageThreadId: 1,
          RawBody: "ambient current",
          SenderName: "Cara",
          SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
          TransportThreadId: 1,
          AmbientTranscriptPreviousMessageId: "200",
          AmbientTranscriptPreviousTimestampMs: 2,
        } as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -1003774691294, type: "supergroup" },
          message_id: 27787,
        } as TelegramMessageContext["msg"],
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

    const dispatchParams = mockCallArg(
      dispatchReplyWithBufferedBlockDispatcher,
    ) as DispatchReplyWithBufferedBlockDispatcherArgs;
    expect(dispatchParams.ctx).toMatchObject({
      BodyForAgent: "ambient current",
      InboundEventKind: "room_event",
      MessageSid: "27787",
      SenderName: "Cara",
    });
    expect(dispatchParams.ctx.InboundHistory).toBeUndefined();
    expect(dispatchParams.ctx.ChannelStructuredContext).toBeUndefined();
  });

  it("moves recovered user-request history out of the original topic", async () => {
    const oldHistoryKey = "-1003774691294:topic:1";
    const recoveredHistoryKey = "-1003774691294:topic:3731";
    const currentBody = "quote [Current message - respond to this] literally";
    const groupHistories = new Map([
      [
        oldHistoryKey,
        [
          { sender: "Alice", body: "general topic context", timestamp: 1 },
          { sender: "Cara", body: currentBody, timestamp: 4, messageId: "27789" },
        ],
      ],
      [
        recoveredHistoryKey,
        [
          { sender: "Bob", body: "before self marker", timestamp: 2 },
          { sender: "OpenClaw (you)", body: "self marker", timestamp: 3 },
          { sender: "Dana", body: "after watermark", timestamp: 4 },
        ],
      ],
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
          InboundEventKind: "user_request",
          Body: currentBody,
          BodyForAgent: currentBody,
          CommandBody: currentBody,
          ChatType: "group",
          From: "telegram:group:-1003774691294:topic:1",
          MessageSid: "27789",
          MessageThreadId: 1,
          RawBody: currentBody,
          SessionKey: "agent:main:telegram:group:-1003774691294:topic:3731",
          TransportThreadId: 1,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -1003774691294, type: "supergroup" },
          message_id: 27789,
        } as unknown as TelegramMessageContext["msg"],
        primaryCtx: {
          message: { chat: { id: -1003774691294, type: "supergroup" } },
        } as unknown as TelegramMessageContext["primaryCtx"],
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

    expect(groupHistories.get(oldHistoryKey)).toEqual([
      expect.objectContaining({ body: "general topic context" }),
    ]);
    expect(groupHistories.get(recoveredHistoryKey)).toEqual([
      expect.objectContaining({ body: "before self marker" }),
      expect.objectContaining({ body: "self marker" }),
      expect.objectContaining({ body: "after watermark" }),
      expect.objectContaining({ body: currentBody, messageId: "27789" }),
    ]);
    const outbound = expectRecordFields(mockCallArg(deliverInboundReplyWithMessageSendContext), {
      threadId: 3731,
    });
    const outboundCtxPayload = expectRecordFields(outbound.ctxPayload, {});
    expect(outboundCtxPayload.InboundHistory).toEqual([
      expect.objectContaining({ body: "after watermark" }),
    ]);
    expect(outboundCtxPayload).toMatchObject({
      Body: currentBody,
      BodyForAgent: currentBody,
      CommandBody: currentBody,
      RawBody: currentBody,
    });
    expect(outboundCtxPayload.ChannelStructuredContext).toEqual([
      expect.objectContaining({
        label: "Conversation context",
        source: "telegram",
        type: "chat_window",
        payload: expect.objectContaining({
          messages: [
            expect.objectContaining({
              body: "after watermark",
              sender: "Dana",
              timestamp_ms: 4,
            }),
          ],
        }),
      }),
    ]);
    expect(JSON.stringify(outboundCtxPayload.ChannelStructuredContext)).not.toContain(
      "before self marker",
    );
    expect(JSON.stringify(outboundCtxPayload.ChannelStructuredContext)).not.toContain(
      "self marker",
    );
    expect(JSON.stringify(outboundCtxPayload.ChannelStructuredContext)).not.toContain(currentBody);
  });

  it("keeps retained overflow draft previews", async () => {
    const draftStream = createDraftStream();
    const bot = createBot();
    createTelegramDraftStream.mockReturnValue(draftStream);
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
      async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Hello" });
        await dispatcherOptions.deliver({ text: "Hello" }, { kind: "final" });
        return { queuedFinal: true };
      },
    );
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({ context: createContext(), bot });

    const streamParams = mockCallArg(createTelegramDraftStream) as Parameters<
      NonNullable<TelegramBotDeps["createTelegramDraftStream"]>
    >[0];
    streamParams.onRetainedPage?.({
      messageId: 17,
      textSnapshot: "first page",
    });
    expect(bot.api["deleteMessage"]).not.toHaveBeenCalled();
  });
});
