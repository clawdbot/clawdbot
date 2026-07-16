import { expect, it, vi } from "vitest";
import {
  describeTelegramDispatch,
  createContext,
  createDraftStream,
  createStatusReactionController,
  createTelegramDraftStream,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  editMessageTelegram,
  observeDeliveredReply,
  requireInvocationOrder,
} from "./bot-message-dispatch.test-harness.js";
import type {
  DispatchReplyWithBufferedBlockDispatcherArgs,
  TelegramMessageContext,
} from "./bot-message-dispatch.test-harness.js";
import { createTestDraftStream } from "./draft-stream.test-helpers.js";

describeTelegramDispatch("dispatchTelegramMessage lifecycle-status", () => {
  it("keeps queued room events abortable after their source dispatch returns", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([[historyKey, []]]);
    let roomEventAbortSignal: AbortSignal | undefined;
    let queuedLifecycle:
      | {
          onEnqueued?: () => void;
          onAdmitted?: () => Promise<void> | void;
          onComplete?: () => void;
        }
      | undefined;
    let deliverQueuedRoomEvent:
      | DispatchReplyWithBufferedBlockDispatcherArgs["dispatcherOptions"]["deliver"]
      | undefined;
    let adoptionStarted: (() => void) | undefined;
    const adoptionStartGate = new Promise<void>((resolve) => {
      adoptionStarted = resolve;
    });
    let releaseAdoption: (() => void) | undefined;
    const adoptionGate = new Promise<void>((resolve) => {
      releaseAdoption = resolve;
    });
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        roomEventAbortSignal = replyOptions?.abortSignal;
        queuedLifecycle = replyOptions?.queuedFollowupLifecycle;
        deliverQueuedRoomEvent = dispatcherOptions.deliver;
        queuedLifecycle?.onEnqueued?.();
        return {
          queuedFinal: false,
          counts: { block: 0, final: 0, tool: 0 },
          sourceReplyDeliveryMode: "message_tool_only",
        };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
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

    await dispatchWithContext({
      context: createGroupContext("room_event", 99, "ambient chatter"),
      streamMode: "off",
      onTurnAdopted: async () => {
        adoptionStarted?.();
        await adoptionGate;
      },
    });
    expect(roomEventAbortSignal?.aborted).toBe(false);

    const admissionPromise = queuedLifecycle?.onAdmitted?.();
    await adoptionStartGate;

    await dispatchWithContext({
      context: createGroupContext("user_request", 100, "@bot answer now"),
      streamMode: "off",
    });

    expect(roomEventAbortSignal?.aborted).toBe(true);
    releaseAdoption?.();
    await admissionPromise;
    await deliverQueuedRoomEvent?.({ text: "stale ambient answer" }, { kind: "final" });
    expect(deliverReplies).toHaveBeenCalledTimes(1);
    queuedLifecycle?.onComplete?.();
  });

  it("holds queued request fence authority until admission", async () => {
    type QueuedLifecycle = {
      onEnqueued?: () => void;
      onAdmitted?: () => Promise<void> | void;
      onComplete?: () => void;
    };
    const captures: Array<{ abortSignal?: AbortSignal; lifecycle?: QueuedLifecycle }> = [];
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      const capture = {
        abortSignal: replyOptions?.abortSignal,
        lifecycle: replyOptions?.queuedFollowupLifecycle,
      };
      captures.push(capture);
      capture.lifecycle?.onEnqueued?.();
      return {
        queuedFinal: false,
        counts: { block: 0, final: 0, tool: 0 },
      };
    });
    const createQueuedContext = (sessionKey: string, messageId: number) =>
      createContext({
        ctxPayload: {
          SessionKey: sessionKey,
          ChatType: "direct",
          MessageSid: String(messageId),
          RawBody: "queued request",
          BodyForAgent: "queued request",
          CommandBody: "queued request",
          CommandAuthorized: true,
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: 123, type: "private" },
          message_id: messageId,
          text: "queued request",
        } as unknown as TelegramMessageContext["msg"],
        chatId: 123,
        isGroup: false,
        threadSpec: { id: undefined, scope: "none" },
      });
    const { supersedeTelegramReplyFence } = await import("./telegram-reply-fence.js");

    await dispatchWithContext({
      context: createQueuedContext("agent:main:telegram:direct:pre-adopt", 101),
      streamMode: "off",
      onTurnDeferred: vi.fn(),
      onTurnAbandoned: vi.fn(),
    });
    expect(captures[0]?.abortSignal?.aborted).toBe(false);
    expect(supersedeTelegramReplyFence("agent:main:telegram:direct:pre-adopt")).toBe(true);
    expect(captures[0]?.abortSignal?.aborted).toBe(true);
    captures[0]?.lifecycle?.onComplete?.();

    const onTurnAdopted = vi.fn();
    await dispatchWithContext({
      context: createQueuedContext("agent:main:telegram:direct:adopted", 102),
      streamMode: "off",
      onTurnAdopted,
      onTurnDeferred: vi.fn(),
      onTurnAbandoned: vi.fn(),
    });
    await captures[1]?.lifecycle?.onAdmitted?.();
    expect(onTurnAdopted).toHaveBeenCalledTimes(1);
    expect(supersedeTelegramReplyFence("agent:main:telegram:direct:adopted")).toBe(false);
    expect(captures[1]?.abortSignal?.aborted).toBe(false);
    captures[1]?.lifecycle?.onComplete?.();

    const rejectedKey = "agent:main:telegram:direct:rejected-adoption";
    const onRejectedTurnAbandoned = vi.fn();
    await dispatchWithContext({
      context: createQueuedContext(rejectedKey, 103),
      streamMode: "off",
      onTurnAdopted: vi.fn(async () => {
        throw new Error("durable adoption failed");
      }),
      onTurnDeferred: vi.fn(),
      onTurnAbandoned: onRejectedTurnAbandoned,
    });
    await expect(captures[2]?.lifecycle?.onAdmitted?.()).rejects.toThrow("durable adoption failed");
    expect(supersedeTelegramReplyFence(rejectedKey)).toBe(true);
    expect(captures[2]?.abortSignal?.aborted).toBe(true);
    captures[2]?.lifecycle?.onComplete?.();
    expect(onRejectedTurnAbandoned).toHaveBeenCalledTimes(1);
    expect(supersedeTelegramReplyFence(rejectedKey)).toBe(false);
  });

  it("does not send visible error fallbacks for room events", async () => {
    const historyKey = "telegram:group:-100123";
    const groupHistories = new Map([
      [historyKey, [{ sender: "Alice", body: "quiet failure", timestamp: 1 }]],
    ]);
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error("provider down"));

    await dispatchWithContext({
      context: createContext({
        ctxPayload: {
          InboundEventKind: "room_event",
          SessionKey: "agent:main:telegram:group:-100123",
          ChatType: "group",
          MessageSid: "101",
          RawBody: "ambient failure",
          BodyForAgent: "ambient failure",
          CommandBody: "ambient failure",
        } as unknown as TelegramMessageContext["ctxPayload"],
        msg: {
          chat: { id: -100123, type: "supergroup" },
          message_id: 101,
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

    expect(deliverReplies).not.toHaveBeenCalled();
    expect(groupHistories.get(historyKey)).toHaveLength(1);
  });

  it("shows compacting reaction during auto-compaction and resumes thinking", async () => {
    const statusReactionController = {
      setThinking: vi.fn(async () => {}),
      setCompacting: vi.fn(async () => {}),
      setTool: vi.fn(async () => {}),
      setDone: vi.fn(async () => {}),
      setError: vi.fn(async () => {}),
      setQueued: vi.fn(async () => {}),
      cancelPending: vi.fn(() => {}),
      clear: vi.fn(async () => {}),
      restoreInitial: vi.fn(async () => {}),
    };
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ replyOptions }) => {
      await replyOptions?.onCompactionStart?.();
      await replyOptions?.onCompactionEnd?.();
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        statusReactionController: statusReactionController as never,
      }),
      streamMode: "off",
    });

    expect(statusReactionController.setCompacting).toHaveBeenCalledTimes(1);
    expect(statusReactionController.cancelPending).toHaveBeenCalledTimes(1);
    expect(statusReactionController.setThinking).toHaveBeenCalledTimes(2);
    expect(
      requireInvocationOrder(
        statusReactionController.setCompacting,
        0,
        "first compacting status reaction",
      ),
    ).toBeLessThan(
      requireInvocationOrder(
        statusReactionController.cancelPending,
        0,
        "first pending status reaction cancellation",
      ),
    );
    expect(
      requireInvocationOrder(
        statusReactionController.cancelPending,
        0,
        "first pending status reaction cancellation",
      ),
    ).toBeLessThan(
      requireInvocationOrder(
        statusReactionController.setThinking,
        1,
        "second thinking status reaction",
      ),
    );
  });

  it("does not supersede the same session for unauthorized abort-looking commands", async () => {
    let releaseFirstFinal: (() => void) | undefined;
    const firstFinalGate = new Promise<void>((resolve) => {
      releaseFirstFinal = resolve;
    });
    let resolveStreamVisible: (() => void) | undefined;
    const streamVisible = new Promise<void>((resolve) => {
      resolveStreamVisible = resolve;
    });

    const firstAnswerDraft = createTestDraftStream({
      messageId: 1001,
      onUpdate: (text) => {
        if (text === "Old reply partial") {
          if (!resolveStreamVisible) {
            throw new Error("Expected Telegram stream-visible resolver to be initialized");
          }
          resolveStreamVisible();
        }
      },
    });
    const firstReasoningDraft = createDraftStream();
    const unauthorizedAnswerDraft = createDraftStream();
    const unauthorizedReasoningDraft = createDraftStream();
    createTelegramDraftStream
      .mockImplementationOnce(() => firstAnswerDraft)
      .mockImplementationOnce(() => firstReasoningDraft)
      .mockImplementationOnce(() => unauthorizedAnswerDraft)
      .mockImplementationOnce(() => unauthorizedReasoningDraft);
    dispatchReplyWithBufferedBlockDispatcher
      .mockImplementationOnce(async ({ dispatcherOptions, replyOptions }) => {
        await replyOptions?.onPartialReply?.({ text: "Old reply partial" });
        await firstFinalGate;
        await dispatcherOptions.deliver({ text: "Old reply final" }, { kind: "final" });
        return { queuedFinal: true };
      })
      .mockImplementationOnce(async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "Unauthorized stop" }, { kind: "final" });
        return { queuedFinal: true };
      });
    const unauthorizedReplyDelivered = observeDeliveredReply("Unauthorized stop");
    const firstPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "earlier request",
          RawBody: "earlier request",
        } as never,
      }),
    });

    await streamVisible;

    const unauthorizedPromise = dispatchWithContext({
      context: createContext({
        ctxPayload: {
          SessionKey: "s1",
          Body: "/stop",
          RawBody: "/stop",
          CommandBody: "/stop",
          CommandAuthorized: false,
        } as never,
      }),
    });

    await unauthorizedReplyDelivered;

    if (!releaseFirstFinal) {
      throw new Error("Expected first Telegram final release callback to be initialized");
    }
    releaseFirstFinal();
    await Promise.all([firstPromise, unauthorizedPromise]);

    expect(firstAnswerDraft.update).toHaveBeenCalledWith("Old reply final");
    expect(editMessageTelegram).not.toHaveBeenCalled();
  });

  it("uses configured doneHoldMs when clearing Telegram status reactions after reply", async () => {
    vi.useFakeTimers();
    const reactionApi = vi.fn(async () => true);
    const statusReactionController = createStatusReactionController();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    try {
      await dispatchWithContext({
        context: createContext({
          reactionApi: reactionApi as never,
          removeAckAfterReply: true,
          statusReactionController: statusReactionController as never,
        }),
        cfg: {
          messages: {
            statusReactions: {
              timing: {
                doneHoldMs: 250,
              },
            },
          },
        },
        streamMode: "off",
      });

      expect(statusReactionController.setDone).toHaveBeenCalledTimes(1);
      expect(statusReactionController.restoreInitial).not.toHaveBeenCalled();
      expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);

      await vi.advanceTimersByTimeAsync(249);
      expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);

      await vi.advanceTimersByTimeAsync(1);
      expect(reactionApi).toHaveBeenCalledWith(123, 456, []);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the initial Telegram status reaction after reply when removeAckAfterReply is disabled", async () => {
    const reactionApi = vi.fn(async () => true);
    const statusReactionController = createStatusReactionController();
    dispatchReplyWithBufferedBlockDispatcher.mockImplementation(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "Done" }, { kind: "final" });
      return { queuedFinal: true };
    });
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        reactionApi: reactionApi as never,
        removeAckAfterReply: false,
        statusReactionController: statusReactionController as never,
      }),
      streamMode: "off",
    });

    await vi.waitFor(() => {
      expect(statusReactionController.setDone).toHaveBeenCalledTimes(1);
      expect(statusReactionController.restoreInitial).toHaveBeenCalledTimes(1);
    });
    expect(statusReactionController.setError).not.toHaveBeenCalled();
    expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);
  });

  it("uses configured errorHoldMs to clear Telegram status reactions after an error fallback", async () => {
    vi.useFakeTimers();
    const reactionApi = vi.fn(async () => true);
    const statusReactionController = createStatusReactionController();
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error("dispatcher exploded"));
    deliverReplies.mockResolvedValue({ delivered: true });

    try {
      await dispatchWithContext({
        context: createContext({
          reactionApi: reactionApi as never,
          removeAckAfterReply: true,
          statusReactionController: statusReactionController as never,
        }),
        cfg: {
          messages: {
            statusReactions: {
              timing: {
                errorHoldMs: 320,
              },
            },
          },
        },
        streamMode: "off",
      });

      expect(statusReactionController.setError).toHaveBeenCalledTimes(1);
      expect(statusReactionController.setDone).not.toHaveBeenCalled();
      expect(statusReactionController.restoreInitial).not.toHaveBeenCalled();
      expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);

      await vi.advanceTimersByTimeAsync(319);
      expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);

      await vi.advanceTimersByTimeAsync(1);
      expect(reactionApi).toHaveBeenCalledWith(123, 456, []);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the initial Telegram status reaction after an error when no final reply is sent", async () => {
    vi.useFakeTimers();
    const reactionApi = vi.fn(async () => true);
    const statusReactionController = createStatusReactionController();
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error("dispatcher exploded"));
    deliverReplies.mockResolvedValue({ delivered: false });

    try {
      await dispatchWithContext({
        context: createContext({
          reactionApi: reactionApi as never,
          removeAckAfterReply: true,
          statusReactionController: statusReactionController as never,
        }),
        cfg: {
          messages: {
            statusReactions: {
              timing: {
                errorHoldMs: 320,
              },
            },
          },
        },
        streamMode: "off",
      });

      expect(statusReactionController.setError).toHaveBeenCalledTimes(1);
      expect(statusReactionController.restoreInitial).not.toHaveBeenCalled();
      expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);

      await vi.advanceTimersByTimeAsync(319);
      expect(statusReactionController.restoreInitial).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(statusReactionController.restoreInitial).toHaveBeenCalledTimes(1);
      expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the initial Telegram status reaction after an error fallback when removeAckAfterReply is disabled", async () => {
    const reactionApi = vi.fn(async () => true);
    const statusReactionController = createStatusReactionController();
    dispatchReplyWithBufferedBlockDispatcher.mockRejectedValue(new Error("dispatcher exploded"));
    deliverReplies.mockResolvedValue({ delivered: true });

    await dispatchWithContext({
      context: createContext({
        reactionApi: reactionApi as never,
        removeAckAfterReply: false,
        statusReactionController: statusReactionController as never,
      }),
      streamMode: "off",
    });

    await vi.waitFor(() => {
      expect(statusReactionController.setError).toHaveBeenCalledTimes(1);
      expect(statusReactionController.restoreInitial).toHaveBeenCalledTimes(1);
    });
    expect(statusReactionController.setDone).not.toHaveBeenCalled();
    expect(reactionApi).not.toHaveBeenCalledWith(123, 456, []);
  });
});
