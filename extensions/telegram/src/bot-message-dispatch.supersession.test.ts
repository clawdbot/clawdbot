import { expect, it, vi } from "vitest";
import {
  describeTelegramDispatch,
  createChannelMessageReplyPipeline,
  createContext,
  createRuntime,
  createStatusReactionController,
  createTelegramDraftStream,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";
import { notifyTelegramInboundEventOutboundSuccess } from "./inbound-event-delivery.js";

describeTelegramDispatch("dispatchTelegramMessage supersession", () => {
  it("lets user requests supersede active room-event dispatch", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([[historyKey, []]]);
    let roomEventStarted: (() => void) | undefined;
    const roomEventStartGate = new Promise<void>((resolve) => {
      roomEventStarted = resolve;
    });
    let releaseRoomEvent: (() => void) | undefined;
    const roomEventGate = new Promise<void>((resolve) => {
      releaseRoomEvent = resolve;
    });
    let userRequestStarted: (() => void) | undefined;
    const userRequestStartGate = new Promise<void>((resolve) => {
      userRequestStarted = resolve;
    });
    let roomEventAbortSignal: AbortSignal | undefined;
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        roomEventAbortSignal = replyOptions?.abortSignal;
        roomEventStarted?.();
        await roomEventGate;
        await dispatcherOptions.deliver({ text: "stale ambient answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        userRequestStarted?.();
        await dispatcherOptions.deliver({ text: "fresh request answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
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

    const roomEventPromise = dispatchWithContext({
      context: createGroupContext("room_event", 99, "ambient chatter"),
      streamMode: "off",
    });
    await roomEventStartGate;
    const userRequestPromise = dispatchWithContext({
      context: createGroupContext("user_request", 100, "@bot answer now"),
      streamMode: "off",
    });
    await userRequestStartGate;
    expect(roomEventAbortSignal?.aborted).toBe(true);
    releaseRoomEvent?.();
    await Promise.all([roomEventPromise, userRequestPromise]);

    const deliveredTexts = deliverReplies.mock.calls.flatMap((call) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text,
      ),
    );
    expect(deliveredTexts).toContain("fresh request answer");
    expect(deliveredTexts).not.toContain("stale ambient answer");
  });

  it("keeps newer group requests from aborting active same-session dispatch", async () => {
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
    let firstAbortSignal: AbortSignal | undefined;
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        firstAbortSignal = replyOptions?.abortSignal;
        firstStarted?.();
        await firstGate;
        await dispatcherOptions.deliver({ text: "earlier group answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
        };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
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

    expect(firstAbortSignal?.aborted).toBe(false);
    releaseFirst?.();
    await Promise.all([firstPromise, secondPromise]);

    const deliveredTexts = deliverReplies.mock.calls.flatMap((call) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text,
      ),
    );
    expect(deliveredTexts).toContain("fresh group answer");
    expect(deliveredTexts).toContain("earlier group answer");
  });

  it("keeps newer DM requests from aborting active same-session dispatch", async () => {
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
    let firstAbortSignal: AbortSignal | undefined;
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        firstAbortSignal = replyOptions?.abortSignal;
        firstStarted?.();
        await firstGate;
        await dispatcherOptions.deliver({ text: "earlier DM answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
        };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        secondStarted?.();
        await dispatcherOptions.deliver({ text: "fresh DM answer" }, { kind: "final" });
        return {
          queuedFinal: true,
          counts: { block: 0, final: 1, tool: 0 },
        };
      });
    deliverReplies.mockResolvedValue({ delivered: true });

    const createDirectContext = (messageId: number, body: string) =>
      createContext({
        ctxPayload: {
          SessionKey: "agent:main:main",
          ChatType: "direct",
          MessageSid: String(messageId),
          RawBody: body,
          BodyForAgent: body,
          CommandBody: body,
          CommandAuthorized: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: 123, type: "private" },
          message_id: messageId,
        } as unknown as TelegramMessageContext["msg"],
        chatId: 123,
        isGroup: false,
        historyKey: "telegram:123",
        historyLimit: 10,
        groupHistories: new Map(),
        threadSpec: { id: undefined, scope: "none" },
      });

    const firstPromise = dispatchWithContext({
      context: createDirectContext(99, "first request"),
      streamMode: "off",
    });
    await firstStartGate;
    const secondPromise = dispatchWithContext({
      context: createDirectContext(100, "second request"),
      streamMode: "off",
    });
    await secondStartGate;

    expect(firstAbortSignal?.aborted).toBe(false);
    releaseFirst?.();
    await Promise.all([firstPromise, secondPromise]);

    const deliveredTexts = deliverReplies.mock.calls.flatMap((call) =>
      ((call[0] as { replies?: Array<{ text?: string }> }).replies ?? []).map(
        (reply) => reply.text,
      ),
    );
    expect(deliveredTexts).toContain("fresh DM answer");
    expect(deliveredTexts).toContain("earlier DM answer");
  });

  it("keeps /btw side questions from aborting an active same-session dispatch", async () => {
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
    let sideStarted: (() => void) | undefined;
    const sideStartGate = new Promise<void>((resolve) => {
      sideStarted = resolve;
    });
    let releaseSide: (() => void) | undefined;
    const sideGate = new Promise<void>((resolve) => {
      releaseSide = resolve;
    });
    let firstAbortSignal: AbortSignal | undefined;
    let sideAbortSignal: AbortSignal | undefined;
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ replyOptions }) => {
        firstAbortSignal = replyOptions?.abortSignal;
        firstStarted?.();
        await firstGate;
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        };
      })
      .mockImplementationOnce(async ({ replyOptions }) => {
        sideAbortSignal = replyOptions?.abortSignal;
        sideStarted?.();
        await sideGate;
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
      context: createGroupContext(99, "@bot first request"),
      streamMode: "off",
    });
    await firstStartGate;
    const sidePromise = dispatchWithContext({
      context: createGroupContext(100, "/btw what changed?"),
      streamMode: "off",
    });
    await sideStartGate;

    expect(firstAbortSignal?.aborted).toBe(false);
    const { buildTelegramReplyFenceLaneKey, supersedeTelegramReplyFenceLane } =
      await import("./telegram-reply-fence.js");
    supersedeTelegramReplyFenceLane(
      buildTelegramReplyFenceLaneKey({
        accountId: "default",
        sequentialKey: "telegram:-100123:btw:100",
      }),
    );
    expect(sideAbortSignal?.aborted).toBe(true);
    expect(firstAbortSignal?.aborted).toBe(false);
    releaseSide?.();
    releaseFirst?.();
    await Promise.all([firstPromise, sidePromise]);
  });

  it("lets authorized /stop abort active non-interrupting side dispatch", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([[historyKey, []]]);
    let sideStarted: (() => void) | undefined;
    const sideStartGate = new Promise<void>((resolve) => {
      sideStarted = resolve;
    });
    let releaseSide: (() => void) | undefined;
    const sideGate = new Promise<void>((resolve) => {
      releaseSide = resolve;
    });
    let sideAbortSignal: AbortSignal | undefined;
    dispatchReplyWithBufferedBlockDispatcher.mockImplementationOnce(async ({ replyOptions }) => {
      sideAbortSignal = replyOptions?.abortSignal;
      sideStarted?.();
      await sideGate;
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
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
          text: body,
        } as unknown as TelegramMessageContext["msg"],
        chatId: -100123,
        isGroup: true,
        historyKey,
        historyLimit: 10,
        groupHistories,
        threadSpec: { id: undefined, scope: "none" },
      });

    const sidePromise = dispatchWithContext({
      context: createGroupContext(100, "/btw what changed?"),
      streamMode: "off",
    });
    await sideStartGate;
    expect(sideAbortSignal?.aborted).toBe(false);

    await dispatchWithContext({
      context: createGroupContext(101, "/stop"),
      streamMode: "off",
    });

    expect(sideAbortSignal?.aborted).toBe(true);
    releaseSide?.();
    await sidePromise;
  });

  it("does not acquire reply-fence ownership when draft initialization fails", async () => {
    const sessionKey = "agent:main:telegram:direct:draft-init-failure";
    createTelegramDraftStream.mockImplementationOnce(() => {
      throw new Error("draft initialization failed");
    });

    await expect(
      dispatchWithContext({
        context: createContext({
          ctxPayload: {
            SessionKey: sessionKey,
            ChatType: "direct",
          } as TelegramMessageContext["ctxPayload"],
        }),
      }),
    ).rejects.toThrow("draft initialization failed");

    const { supersedeTelegramReplyFence } = await import("./telegram-reply-fence.js");
    expect(supersedeTelegramReplyFence(sessionKey)).toBe(false);
  });

  it("cleans delivery correlation when reply-pipeline initialization fails", async () => {
    const sessionKey = "agent:main:telegram:direct:pipeline-init-failure";
    const statusReactionController = createStatusReactionController();
    const reactionApi = vi.fn(async () => undefined);
    const runtime = createRuntime();
    runtime.error = vi.fn(() => {
      notifyTelegramInboundEventOutboundSuccess({
        sessionKey,
        to: "123",
        accountId: "default",
      });
    });
    createChannelMessageReplyPipeline.mockImplementationOnce(() => {
      throw new Error("pipeline initialization failed");
    });

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: sessionKey,
          ChatType: "direct",
        } as TelegramMessageContext["ctxPayload"],
        statusReactionController: statusReactionController as never,
        reactionApi,
        removeAckAfterReply: true,
      }),
      cfg: {
        messages: {
          statusReactions: {
            timing: { errorHoldMs: 0 },
          },
        },
      },
      runtime,
      suppressFailureFallback: true,
    });

    await vi.waitFor(() => expect(statusReactionController.restoreInitial).toHaveBeenCalled());
    expect(reactionApi).not.toHaveBeenCalled();
  });

  it("releases fence abort authority at turn adoption", async () => {
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
    let firstAbortSignal: AbortSignal | undefined;
    let adoptTurn: (() => void | Promise<void>) | undefined;
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ replyOptions }) => {
        firstAbortSignal = replyOptions?.abortSignal;
        adoptTurn = replyOptions?.onTurnAdopted;
        firstStarted?.();
        await firstGate;
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
        };
      })
      .mockImplementationOnce(async () => ({
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
      }));

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
      context: createGroupContext(99, "@bot long turn"),
      streamMode: "off",
    });
    await firstStartGate;
    expect(firstAbortSignal?.aborted).toBe(false);
    expect(adoptTurn).toEqual(expect.any(Function));

    // Before adoption, fence supersede still aborts the live controller.
    const { beginTelegramReplyFence, endTelegramReplyFence, supersedeTelegramReplyFence } =
      await import("./telegram-reply-fence.js");
    const preAdoptController = new AbortController();
    beginTelegramReplyFence({
      key: "agent:main:telegram:group:pre-adopt",
      supersede: false,
      abortController: preAdoptController,
    });
    expect(supersedeTelegramReplyFence("agent:main:telegram:group:pre-adopt")).toBe(true);
    expect(preAdoptController.signal.aborted).toBe(true);
    endTelegramReplyFence("agent:main:telegram:group:pre-adopt");

    // After adoption, the dispatch controller is released from the fence set so
    // a later superseding peer (authorized explicit command) cannot abort it.
    await adoptTurn?.();
    expect(firstAbortSignal?.aborted).toBe(false);
    expect(supersedeTelegramReplyFence("agent:main:telegram:group:-100123")).toBe(false);

    await dispatchWithContext({
      context: createGroupContext(100, "/export-trajectory bundle"),
      streamMode: "off",
    });
    expect(firstAbortSignal?.aborted).toBe(false);
    releaseFirst?.();
    await firstPromise;
  });
});
