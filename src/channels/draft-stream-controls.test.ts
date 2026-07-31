// Draft stream control tests cover pause, resume, and cancellation handling for channel drafts.
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../shared/deferred.js";
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

  it("clearFinalizableDraftMessage claims a failed delete and reports its retry target", async () => {
    const warn = vi.fn();
    let messageId: string | undefined = "m-3";
    const onDeleteFailure = vi.fn();
    const deleteMessage = vi.fn(async () => {
      throw new Error("boom");
    });

    await clearFinalizableDraftMessage({
      stopForClear: async () => {},
      readMessageId: () => messageId,
      clearMessageId: () => {
        messageId = undefined;
      },
      isValidMessageId: (value): value is string => typeof value === "string",
      deleteMessage,
      onDeleteFailure,
      warn,
      warnPrefix: "cleanup failed",
    });

    expect(messageId).toBeUndefined();
    expect(onDeleteFailure).toHaveBeenCalledWith("m-3");
    expect(warn).toHaveBeenCalledWith("cleanup failed: boom");
  });

  it("clearFinalizableDraftMessage claims an id before concurrent clears", async () => {
    let messageId: string | undefined = "m-3";
    const pendingDelete = createDeferred();
    const deleteMessage = vi.fn(() => pendingDelete.promise);
    const clear = () =>
      clearFinalizableDraftMessage({
        stopForClear: async () => {},
        readMessageId: () => messageId,
        clearMessageId: () => {
          messageId = undefined;
        },
        isValidMessageId: (value): value is string => typeof value === "string",
        deleteMessage,
        warnPrefix: "cleanup failed",
      });

    const firstClear = clear();
    await vi.waitFor(() => expect(deleteMessage).toHaveBeenCalledWith("m-3"));
    await clear();
    pendingDelete.resolve();
    await firstClear;

    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it("clearFinalizableDraftMessage preserves a replacement id while delete is in flight", async () => {
    let messageId: string | undefined = "preview-old";
    const pendingDelete = createDeferred();
    const deleteMessage = vi.fn(() => pendingDelete.promise);

    const clearPromise = clearFinalizableDraftMessage({
      stopForClear: async () => {},
      readMessageId: () => messageId,
      clearMessageId: () => {
        messageId = undefined;
      },
      isValidMessageId: (value): value is string => typeof value === "string",
      deleteMessage,
      warnPrefix: "cleanup failed",
    });
    await vi.waitFor(() => expect(deleteMessage).toHaveBeenCalledWith("preview-old"));

    messageId = "preview-new";
    pendingDelete.resolve();
    await clearPromise;

    expect(messageId).toBe("preview-new");
  });

  it("clearFinalizableDraftMessage reports the failed target after its id is replaced", async () => {
    let messageId: string | undefined = "preview-old";
    const pendingDelete = createDeferred();
    const onDeleteFailure = vi.fn();
    const deleteMessage = vi.fn(() => pendingDelete.promise);
    const clearPromise = clearFinalizableDraftMessage({
      stopForClear: async () => {},
      readMessageId: () => messageId,
      clearMessageId: () => {
        messageId = undefined;
      },
      isValidMessageId: (value): value is string => typeof value === "string",
      deleteMessage,
      onDeleteFailure,
      warnPrefix: "cleanup failed",
    });
    await vi.waitFor(() => expect(deleteMessage).toHaveBeenCalledWith("preview-old"));

    messageId = "preview-new";
    pendingDelete.reject(new Error("boom"));
    await clearPromise;

    expect(onDeleteFailure).toHaveBeenCalledWith("preview-old");
    expect(messageId).toBe("preview-new");
  });

  it("lifecycle retries a failed old deletion after the current id is replaced", async () => {
    const state = { stopped: false, final: false };
    let messageId: string | undefined = "preview-old";
    const pendingDelete = createDeferred();
    const warn = vi.fn();
    const deleteMessage = vi
      .fn<(messageId: string) => Promise<void>>()
      .mockImplementationOnce(() => pendingDelete.promise)
      .mockResolvedValue(undefined);
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
      warn,
      warnPrefix: "cleanup failed",
    });

    const firstClear = lifecycle.clear();
    await vi.waitFor(() => expect(deleteMessage).toHaveBeenCalledWith("preview-old"));
    messageId = "preview-new";
    pendingDelete.reject(new Error("boom"));
    await firstClear;

    expect(messageId).toBe("preview-new");
    expect(warn).toHaveBeenCalledWith("cleanup failed: boom");

    await lifecycle.clear();

    expect(deleteMessage.mock.calls.map(([id]) => id)).toEqual([
      "preview-old",
      "preview-old",
      "preview-new",
    ]);
    expect(messageId).toBeUndefined();
  });

  it("lifecycle does not retry a successful delete when its success callback fails", async () => {
    const state = { stopped: false, final: false };
    let messageId: string | undefined = "preview-old";
    const deleteMessage = vi.fn(async () => {});
    const warn = vi.fn();
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
      onDeleteSuccess: () => {
        throw new Error("callback boom");
      },
      warn,
      warnPrefix: "cleanup failed",
    });

    await lifecycle.clear();
    await lifecycle.clear();

    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(messageId).toBeUndefined();
    expect(warn).toHaveBeenCalledWith("cleanup failed after delete: callback boom");
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
