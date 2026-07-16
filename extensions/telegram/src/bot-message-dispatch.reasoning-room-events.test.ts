import { expect, it } from "vitest";
import {
  describeTelegramDispatch,
  createContext,
  createReasoningStreamContext,
  createStatusReactionController,
  createTelegramDraftStream,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
  expectDeliveredReply,
  loadSessionStore,
  mockCallArg,
  sendMessageTelegram,
  setupDraftStreams,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";
import { notifyTelegramInboundEventOutboundSuccess } from "./inbound-event-delivery.js";

describeTelegramDispatch("dispatchTelegramMessage reasoning-room-events", () => {
  it("keeps shared durable reasoning payloads disabled when reasoning is off", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });

    await dispatchWithContext({ context: createContext() });

    const dispatchParams = mockCallArg(dispatchReplyWithBufferedBlockDispatcher) as {
      replyOptions?: { reasoningPayloadsEnabled?: boolean };
    };
    expect(dispatchParams.replyOptions?.reasoningPayloadsEnabled).toBe(false);
  });

  it("opts shared dispatch into durable reasoning payload delivery when reasoning streams", async () => {
    setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });

    await dispatchWithContext({ context: createReasoningStreamContext() });

    const dispatchParams = mockCallArg(dispatchReplyWithBufferedBlockDispatcher) as {
      replyOptions?: { reasoningPayloadsEnabled?: boolean };
    };
    expect(dispatchParams.replyOptions?.reasoningPayloadsEnabled).toBe(true);
  });

  it("keeps shared durable reasoning payloads disabled in progress stream mode", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
    });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
    });

    const dispatchParams = mockCallArg(dispatchReplyWithBufferedBlockDispatcher) as {
      replyOptions?: { reasoningPayloadsEnabled?: boolean };
    };
    expect(dispatchParams.replyOptions?.reasoningPayloadsEnabled).toBe(false);
  });

  it("suppresses typed reasoning-only finals without raw text fallback", async () => {
    setupDraftStreams({ answerMessageId: 2001, reasoningMessageId: 3001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("routes typed reasoning-only finals to the reasoning lane when reasoning streams", async () => {
    const { reasoningDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createReasoningStreamContext() });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith("🧠 _hidden_");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("routes typed reasoning-only finals to durable delivery when reasoning is persistent", async () => {
    loadSessionStore.mockReturnValue({
      s1: { reasoningLevel: "on" },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: { SessionKey: "s1" } as unknown as TelegramMessageContext["ctxPayload"],
      }),
    });

    const delivered = expectDeliveredReply(0, { text: "🧠 _hidden_" });
    expect(delivered).not.toHaveProperty("isReasoning");
  });

  it("does not persist typed reasoning-only finals in progress stream mode", async () => {
    const { answerDraftStream } = setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({
      context: createReasoningStreamContext(),
      streamMode: "progress",
    });

    expect(deliverReplies).not.toHaveBeenCalled();
    expect(answerDraftStream.update).not.toHaveBeenCalled();
  });

  it("keeps unflagged angle-bracket text visible on the answer lane", async () => {
    const { answerDraftStream } = setupDraftStreams({
      answerMessageId: 2001,
      reasoningMessageId: 3001,
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "Before <think>literal tag text after" },
        { kind: "final" },
      );
      return { queuedFinal: true };
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith("Before <think>literal tag text after");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not add silent fallback when source delivery is message-tool-only", async () => {
    setupDraftStreams({ answerMessageId: 2001, reasoningMessageId: 3001 });
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue({
      queuedFinal: false,
      counts: { block: 0, final: 0, tool: 0 },
      sourceReplyDeliveryMode: "message_tool_only",
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "agent:main:telegram:direct:123",
        } as unknown as TelegramMessageContext["ctxPayload"],
      }),
      cfg: {
        agents: {
          defaults: {
            silentReply: {
              group: "allow",
              internal: "allow",
            },
          },
        },
      },
    });

    expect(deliverReplies).not.toHaveBeenCalled();
    expect(editMessageTelegram).not.toHaveBeenCalled();
    expect(sendMessageTelegram).not.toHaveBeenCalled();
  });

  it("runs ambient room events as tool-only invisible turns", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([
      [historyKey, [{ sender: "Alice", body: "side chatter", timestamp: 1 }]],
    ]);
    const statusReactionController = createStatusReactionController();
    loadSessionStore.mockReturnValue({
      "agent:main:telegram:group:-100123": { reasoningLevel: "stream" },
    });
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onReasoningStream?.({ text: "<think>ambient reasoning</think>" });
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onCompactionStart?.();
      await replyOptions?.onCompactionEnd?.();
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
        sourceReplyDeliveryMode: "message_tool_only",
      };
    });

    await dispatchWithContext({
      context: createContext({
        statusReactionController: statusReactionController as never,
        ctxPayload: {
          InboundEventKind: "room_event",
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: "99",
          RawBody: "ambient",
          BodyForAgent: "ambient",
          CommandBody: "ambient",
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: 99,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: undefined, scope: "none" },
      }),
      streamMode: "partial",
    });

    const dispatchParams = mockCallArg(dispatchReplyWithBufferedBlockDispatcher) as {
      replyOptions?: {
        sourceReplyDeliveryMode?: string;
        suppressTyping?: boolean;
        allowProgressCallbacksWhenSourceDeliverySuppressed?: boolean;
        onReasoningStream?: unknown;
        onCompactionStart?: unknown;
        onCompactionEnd?: unknown;
      };
    };
    expect(dispatchParams.replyOptions?.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(dispatchParams.replyOptions?.suppressTyping).toBe(true);
    expect(dispatchParams.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(
      false,
    );
    expect(dispatchParams.replyOptions?.onReasoningStream).toBeUndefined();
    expect(dispatchParams.replyOptions?.onCompactionStart).toBeUndefined();
    expect(dispatchParams.replyOptions?.onCompactionEnd).toBeUndefined();
    expect(createTelegramDraftStream).not.toHaveBeenCalled();
    expect(statusReactionController.setTool).not.toHaveBeenCalled();
    expect(statusReactionController.setCompacting).not.toHaveBeenCalled();
    expect(statusReactionController.setThinking).not.toHaveBeenCalled();
    expect(deliverReplies).not.toHaveBeenCalled();
    expect(groupHistories.get(historyKey)).toHaveLength(1);
  });

  it("keeps room-event history when a newer turn supersedes dispatch", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([
      [historyKey, [{ sender: "Alice", body: "lunch at two", timestamp: 1 }]],
    ]);
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted: (() => void) | undefined;
    const secondStartGate = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async () => {
        await firstGate;
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      })
      .mockImplementationOnce(async () => {
        secondStarted?.();
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      });

    const createRoomContext = (messageId: number, body: string) =>
      createContext({
        ctxPayload: {
          InboundEventKind: "room_event",
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
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
      context: createRoomContext(99, "ambient one"),
      streamMode: "partial",
    });
    const secondPromise = dispatchWithContext({
      context: createRoomContext(100, "ambient two"),
      streamMode: "partial",
    });

    await secondStartGate;
    releaseFirst?.();
    await Promise.all([firstPromise, secondPromise]);

    expect(groupHistories.get(historyKey)).toHaveLength(1);
  });

  it("keeps delivered room-event history when a newer turn supersedes dispatch", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([
      [historyKey, [{ sender: "Alice", body: "lunch at two", timestamp: 1 }]],
    ]);
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
      .mockImplementationOnce(async () => {
        firstStarted?.();
        await firstGate;
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      })
      .mockImplementationOnce(async () => {
        secondStarted?.();
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      });

    const createRoomContext = (messageId: number, body: string) =>
      createContext({
        ctxPayload: {
          InboundEventKind: "room_event",
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
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
      context: createRoomContext(99, "ambient one"),
      streamMode: "partial",
    });
    await firstStartGate;
    notifyTelegramInboundEventOutboundSuccess({
      sessionKey: "agent:main:telegram:group:-100123",
      to: "telegram:-100123",
      inboundEventKind: "room_event",
    });
    const secondPromise = dispatchWithContext({
      context: createRoomContext(100, "ambient two"),
      streamMode: "partial",
    });

    await secondStartGate;
    releaseFirst?.();
    await Promise.all([firstPromise, secondPromise]);

    expect(groupHistories.get(historyKey)).toHaveLength(1);
  });

  it("keeps topic room-event history for a send to another topic", async () => {
    const historyKey = "telegram:group:-100123:topic:77";
    const groupHistories = new Map([
      [historyKey, [{ sender: "Alice", body: "topic 77 context", timestamp: 1 }]],
    ]);
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
      .mockImplementationOnce(async () => {
        firstStarted?.();
        await firstGate;
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      })
      .mockImplementationOnce(async () => {
        secondStarted?.();
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      });

    const createRoomContext = (messageId: number, body: string) =>
      createContext({
        ctxPayload: {
          InboundEventKind: "room_event",
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup", is_forum: true },
          message_id: messageId,
          message_thread_id: 77,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: 77, scope: "forum" },
      });

    const firstPromise = dispatchWithContext({
      context: createRoomContext(99, "ambient one"),
      streamMode: "partial",
    });
    await firstStartGate;
    notifyTelegramInboundEventOutboundSuccess({
      sessionKey: "agent:main:telegram:group:-100123",
      to: "telegram:group:-100123:topic:88",
      inboundEventKind: "room_event",
    });
    const secondPromise = dispatchWithContext({
      context: createRoomContext(100, "ambient two"),
      streamMode: "partial",
    });

    await secondStartGate;
    releaseFirst?.();
    await Promise.all([firstPromise, secondPromise]);

    expect(groupHistories.get(historyKey)).toHaveLength(1);
  });

  it("does not let room events supersede active user-request dispatch", async () => {
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
    let roomEventStarted: (() => void) | undefined;
    const roomEventStartGate = new Promise<void>((resolve) => {
      roomEventStarted = resolve;
    });
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        firstStarted?.();
        await firstGate;
        await dispatcherOptions.deliver({ text: "visible request answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
        };
      })
      .mockImplementationOnce(async () => {
        roomEventStarted?.();
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      });

    const createGroupContext = (
      kind: "user_request" | "room_event",
      messageId: number,
      body: string,
    ) =>
      createContext({
        ctxPayload: {
          InboundEventKind: kind,
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

    const userRequestPromise = dispatchWithContext({
      context: createGroupContext("user_request", 99, "@bot answer this"),
      streamMode: "off",
    });
    await firstStartGate;
    const roomEventPromise = dispatchWithContext({
      context: createGroupContext("room_event", 100, "ambient chatter"),
      streamMode: "off",
    });
    await roomEventStartGate;
    releaseFirst?.();
    await Promise.all([userRequestPromise, roomEventPromise]);

    const deliveredTexts = deliverReplies.mock.calls.flatMap((call) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text,
      ),
    );
    expect(deliveredTexts).toContain("visible request answer");
  });
});
