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
import type {
  DispatchReplyWithBufferedBlockDispatcherArgs,
  TelegramMessageContext,
} from "./bot-message-dispatch.test-harness.js";
import { telegramInboundEventDelivery } from "./inbound-event-delivery.js";

const GROUP_CHAT_ID = -100123;
const GROUP_SESSION_KEY = "agent:main:telegram:group:-100123";

const emptyDispatchResult = {
  queuedFinal: false,
  counts: { block: 0, final: 0, tool: 0 },
};

const messageToolOnlyDispatchResult = {
  ...emptyDispatchResult,
  sourceReplyDeliveryMode: "message_tool_only" as const,
};

function mockTurn(
  run: (params: DispatchReplyWithBufferedBlockDispatcherArgs) => Promise<void>,
  result: unknown = { queuedFinal: true },
) {
  dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async (params) => {
    await run(params);
    return result;
  });
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createGroupFixture(
  params: {
    commandAuthorized?: boolean;
    entries?: Array<{ sender: string; body: string; timestamp: number }>;
    topicId?: number;
  } = {},
) {
  const { commandAuthorized, topicId } = params;
  const entries = params.entries ?? [{ sender: "Alice", body: "lunch at two", timestamp: 1 }];
  const historyKey = `telegram:group:${GROUP_CHAT_ID}${topicId ? `:topic:${topicId}` : ""}`;
  const groupHistories = new Map([[historyKey, entries]]);
  const context = (
    messageId: number,
    body: string,
    kind: "user_request" | "room_event" = "room_event",
    overrides: Partial<TelegramMessageContext> = {},
  ) =>
    createContext({
      ...overrides,
      ctxPayload: {
        InboundEventKind: kind,
        SessionKey: GROUP_SESSION_KEY,
        ChatType: "group",
        MessageSid: String(messageId),
        RawBody: body,
        BodyForAgent: body,
        CommandBody: body,
        ...(commandAuthorized ? { CommandAuthorized: true } : {}),
      } as unknown as TelegramMessageContext["ctxPayload"],
      msg: {
        chat: { id: GROUP_CHAT_ID, type: "supergroup", ...(topicId ? { is_forum: true } : {}) },
        message_id: messageId,
        ...(topicId ? { message_thread_id: topicId } : {}),
      } as unknown as TelegramMessageContext["msg"],
      chatId: GROUP_CHAT_ID,
      isGroup: true,
      historyKey,
      historyLimit: 10,
      groupHistories,
      threadSpec: topicId ? { id: topicId, scope: "forum" } : { id: undefined, scope: "none" },
    });
  return { context, groupHistories, historyKey };
}

function mockSupersedingRoomEvents() {
  const firstStarted = createDeferred();
  const firstRelease = createDeferred();
  const secondStarted = createDeferred();
  dispatchReplyWithBufferedBlockDispatcher
    .mockImplementationOnce(async () => {
      firstStarted.resolve();
      await firstRelease.promise;
      return messageToolOnlyDispatchResult;
    })
    .mockImplementationOnce(async () => {
      secondStarted.resolve();
      return messageToolOnlyDispatchResult;
    });
  return {
    firstStarted: firstStarted.promise,
    releaseFirst: firstRelease.resolve,
    secondStarted: secondStarted.promise,
  };
}

describeTelegramDispatch("dispatchTelegramMessage reasoning-room-events", () => {
  it("keeps shared durable reasoning payloads disabled when reasoning is off", async () => {
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue(emptyDispatchResult);

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
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue(emptyDispatchResult);

    await dispatchWithContext({ context: createReasoningStreamContext() });

    const dispatchParams = mockCallArg(dispatchReplyWithBufferedBlockDispatcher) as {
      replyOptions?: { reasoningPayloadsEnabled?: boolean };
    };
    expect(dispatchParams.replyOptions?.reasoningPayloadsEnabled).toBe(true);
  });

  it("keeps shared durable reasoning payloads disabled in progress stream mode", async () => {
    setupDraftStreams({ answerMessageId: 2001 });
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue(emptyDispatchResult);

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
    mockTurn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
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
    mockTurn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
    });

    await dispatchWithContext({ context: createReasoningStreamContext() });

    expect(reasoningDraftStream.update).toHaveBeenCalledWith("🧠 _hidden_");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("routes typed reasoning-only finals to durable delivery when reasoning is persistent", async () => {
    loadSessionStore.mockReturnValue({
      s1: { reasoningLevel: "on" },
    });
    mockTurn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
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
    mockTurn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "<think>hidden</think>", isReasoning: true },
        { kind: "final" },
      );
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
    mockTurn(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver(
        { text: "Before <think>literal tag text after" },
        { kind: "final" },
      );
    });

    await dispatchWithContext({ context: createContext() });

    expect(answerDraftStream.update).toHaveBeenCalledWith("Before <think>literal tag text after");
    expect(deliverReplies).not.toHaveBeenCalled();
  });

  it("does not add silent fallback when source delivery is message-tool-only", async () => {
    setupDraftStreams({ answerMessageId: 2001, reasoningMessageId: 3001 });
    dispatchReplyWithBufferedBlockDispatcher.mockResolvedValue(messageToolOnlyDispatchResult);

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
    const { context, groupHistories, historyKey } = createGroupFixture({
      entries: [{ sender: "Alice", body: "side chatter", timestamp: 1 }],
    });
    const statusReactionController = createStatusReactionController();
    loadSessionStore.mockReturnValue({
      [GROUP_SESSION_KEY]: { reasoningLevel: "stream" },
    });
    mockTurn(async ({ replyOptions }) => {
      await replyOptions?.onReasoningStream?.({ text: "<think>ambient reasoning</think>" });
      await replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
      await replyOptions?.onCompactionStart?.();
      await replyOptions?.onCompactionEnd?.();
    }, messageToolOnlyDispatchResult);

    await dispatchWithContext({
      context: context(99, "ambient", "room_event", {
        statusReactionController: statusReactionController as never,
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
    const { context, groupHistories, historyKey } = createGroupFixture();
    const { releaseFirst, secondStarted } = mockSupersedingRoomEvents();

    const firstPromise = dispatchWithContext({
      context: context(99, "ambient one"),
      streamMode: "partial",
    });
    const secondPromise = dispatchWithContext({
      context: context(100, "ambient two"),
      streamMode: "partial",
    });

    await secondStarted;
    releaseFirst();
    await Promise.all([firstPromise, secondPromise]);

    expect(groupHistories.get(historyKey)).toHaveLength(1);
  });

  it("keeps delivered room-event history when a newer turn supersedes dispatch", async () => {
    const { context, groupHistories, historyKey } = createGroupFixture();
    const { firstStarted, releaseFirst, secondStarted } = mockSupersedingRoomEvents();

    const firstPromise = dispatchWithContext({
      context: context(99, "ambient one"),
      streamMode: "partial",
    });
    await firstStarted;
    telegramInboundEventDelivery.notify({
      sessionKey: GROUP_SESSION_KEY,
      to: "telegram:-100123",
      inboundEventKind: "room_event",
    });
    const secondPromise = dispatchWithContext({
      context: context(100, "ambient two"),
      streamMode: "partial",
    });

    await secondStarted;
    releaseFirst();
    await Promise.all([firstPromise, secondPromise]);

    expect(groupHistories.get(historyKey)).toHaveLength(1);
  });

  it("keeps topic room-event history for a send to another topic", async () => {
    const { context, groupHistories, historyKey } = createGroupFixture({
      entries: [{ sender: "Alice", body: "topic 77 context", timestamp: 1 }],
      topicId: 77,
    });
    const { firstStarted, releaseFirst, secondStarted } = mockSupersedingRoomEvents();

    const firstPromise = dispatchWithContext({
      context: context(99, "ambient one"),
      streamMode: "partial",
    });
    await firstStarted;
    telegramInboundEventDelivery.notify({
      sessionKey: GROUP_SESSION_KEY,
      to: "telegram:group:-100123:topic:88",
      inboundEventKind: "room_event",
    });
    const secondPromise = dispatchWithContext({
      context: context(100, "ambient two"),
      streamMode: "partial",
    });

    await secondStarted;
    releaseFirst();
    await Promise.all([firstPromise, secondPromise]);

    expect(groupHistories.get(historyKey)).toHaveLength(1);
  });

  it("does not let room events supersede active user-request dispatch", async () => {
    const { context } = createGroupFixture({ commandAuthorized: true, entries: [] });
    const firstStarted = createDeferred();
    const firstRelease = createDeferred();
    const roomEventStarted = createDeferred();
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        firstStarted.resolve();
        await firstRelease.promise;
        await dispatcherOptions.deliver({ text: "visible request answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
        };
      })
      .mockImplementationOnce(async () => {
        roomEventStarted.resolve();
        return messageToolOnlyDispatchResult;
      });

    const userRequestPromise = dispatchWithContext({
      context: context(99, "@bot answer this", "user_request"),
      streamMode: "off",
    });
    await firstStarted.promise;
    const roomEventPromise = dispatchWithContext({
      context: context(100, "ambient chatter"),
      streamMode: "off",
    });
    await roomEventStarted.promise;
    firstRelease.resolve();
    await Promise.all([userRequestPromise, roomEventPromise]);

    const deliveredTexts = deliverReplies.mock.calls.flatMap((call) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text,
      ),
    );
    expect(deliveredTexts).toContain("visible request answer");
  });
});
