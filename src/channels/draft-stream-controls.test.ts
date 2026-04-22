import { describe, expect, it, vi } from "vitest";
import {
  clearFinalizableDraftMessage,
  createFinalizableDraftLifecycle,
  createFinalizableDraftStreamControlsForState,
  takeMessageIdAfterStop,
} from "./draft-stream-controls.js";

describe("draft-stream-controls", () => {
  it("takeMessageIdAfterStop stops, reads, and clears message id", async () => {
    const events: string[] = [];
    let messageId: string | undefined = "m-1";

    const result = await takeMessageIdAfterStop({
      stopForClear: async () => {
        events.push("stop");
      },
      readMessageId: () => {
        events.push("read");
        return messageId;
      },
      clearMessageId: () => {
        events.push("clear");
        messageId = undefined;
      },
    });

    expect(result).toBe("m-1");
    expect(messageId).toBeUndefined();
    expect(events).toEqual(["stop", "read", "clear"]);
  });

  it("clearFinalizableDraftMessage deletes valid message ids", async () => {
    const deleteMessage = vi.fn(async () => {});
    const onDeleteSuccess = vi.fn();

    await clearFinalizableDraftMessage({
      stopForClear: async () => {},
      readMessageId: () => "m-2",
      clearMessageId: () => {},
      isValidMessageId: (value): value is string => typeof value === "string",
      deleteMessage,
      onDeleteSuccess,
      warnPrefix: "cleanup failed",
    });

    expect(deleteMessage).toHaveBeenCalledWith("m-2");
    expect(onDeleteSuccess).toHaveBeenCalledWith("m-2");
  });

  it("clearFinalizableDraftMessage skips invalid message ids", async () => {
    const deleteMessage = vi.fn(async () => {});

    await clearFinalizableDraftMessage<unknown>({
      stopForClear: async () => {},
      readMessageId: () => 123,
      clearMessageId: () => {},
      isValidMessageId: (value): value is string => typeof value === "string",
      deleteMessage,
      warnPrefix: "cleanup failed",
    });

    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it("clearFinalizableDraftMessage warns when delete fails", async () => {
    const warn = vi.fn();

    await clearFinalizableDraftMessage({
      stopForClear: async () => {},
      readMessageId: () => "m-3",
      clearMessageId: () => {},
      isValidMessageId: (value): value is string => typeof value === "string",
      deleteMessage: async () => {
        throw new Error("boom");
      },
      warn,
      warnPrefix: "cleanup failed",
    });

    expect(warn).toHaveBeenCalledWith("cleanup failed: boom");
  });

  it("controls ignore updates after final", async () => {
    const sendOrEditStreamMessage = vi.fn(async () => true);
    const controls = createFinalizableDraftStreamControlsForState({
      throttleMs: 250,
      state: { stopped: false, final: true },
      sendOrEditStreamMessage,
    });

    controls.update("ignored");
    await controls.loop.flush();

    expect(sendOrEditStreamMessage).not.toHaveBeenCalled();
  });

  it("lifecycle clear marks stopped, clears id, and deletes preview message", async () => {
    const state = { stopped: false, final: false };
    let messageId: string | undefined = "m-4";
    const deleteMessage = vi.fn(async () => {});

    const lifecycle = createFinalizableDraftLifecycle({
      throttleMs: 250,
      state,
      sendOrEditStreamMessage: async () => true,
      readMessageId: () => messageId,
      clearMessageId: () => {
        messageId = undefined;
      },
      isValidMessageId: (value): value is string => typeof value === "string",
      deleteMessage,
      warnPrefix: "cleanup failed",
    });

    await lifecycle.clear();

    expect(state.stopped).toBe(true);
    expect(messageId).toBeUndefined();
    expect(deleteMessage).toHaveBeenCalledWith("m-4");
  });

  it("lifecycle seal ignores late updates without clearing the preview id", async () => {
    const state = { stopped: false, final: false };
    let messageId: string | undefined = "m-5";
    const sendOrEditStreamMessage = vi.fn(async () => true);
    const deleteMessage = vi.fn(async () => {});

    const lifecycle = createFinalizableDraftLifecycle({
      throttleMs: 250,
      state,
      sendOrEditStreamMessage,
      readMessageId: () => messageId,
      clearMessageId: () => {
        messageId = undefined;
      },
      isValidMessageId: (value): value is string => typeof value === "string",
      deleteMessage,
      warnPrefix: "cleanup failed",
    });

    lifecycle.update("stale");
    await lifecycle.seal();
    lifecycle.update("late");
    await lifecycle.loop.flush();

    expect(state.final).toBe(true);
    expect(messageId).toBe("m-5");
    expect(sendOrEditStreamMessage).toHaveBeenCalledTimes(1);
    expect(sendOrEditStreamMessage).toHaveBeenCalledWith("stale");
    expect(deleteMessage).not.toHaveBeenCalled();
  });
});
