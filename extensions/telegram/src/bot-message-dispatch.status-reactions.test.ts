import { expect, it, vi } from "vitest";
import {
  describeTelegramDispatch,
  createContext,
  createStatusReactionController,
  deliverReplies,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  requireInvocationOrder,
} from "./bot-message-dispatch.test-harness.js";
import type { TelegramMessageContext } from "./bot-message-dispatch.test-harness.js";

describeTelegramDispatch("dispatchTelegramMessage status-reactions", () => {
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
