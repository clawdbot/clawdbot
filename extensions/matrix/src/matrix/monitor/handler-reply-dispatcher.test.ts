// Matrix reply dispatcher tests cover channel-owned reasoning stream delivery.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MatrixClient } from "../sdk.js";
import { createMatrixReplyDispatcher } from "./handler-reply-dispatcher.js";

const deliverMatrixRepliesMock = vi.hoisted(() => vi.fn(async () => ({ visibleReplySent: true })));

vi.mock("./replies.js", async () => {
  const actual = await vi.importActual<typeof import("./replies.js")>("./replies.js");
  return {
    ...actual,
    deliverMatrixReplies: deliverMatrixRepliesMock,
  };
});

function createDispatcher() {
  return createMatrixReplyDispatcher({
    cfg: {},
    prefixOptions: { responsePrefixContextProvider: () => ({ identityName: undefined }) },
    humanDelay: { mode: "off" },
    typingCallbacks: {
      onReplyStart: vi.fn(() => Promise.resolve()),
      onIdle: vi.fn(() => undefined),
    },
    streaming: "off",
    draftStream: undefined,
    draftController: {
      beginDraftGeneration: vi.fn(),
      advanceDraftBlockBoundary: vi.fn(),
      reset: vi.fn(),
      resetReplyToIdForNextBlock: vi.fn(),
      updateDraftFromLatestFullText: vi.fn(),
      cancelProgressDraft: vi.fn(),
      currentReplyToId: vi.fn(() => undefined),
      draftDisposition: vi.fn(() => "inactive"),
      buildPreviewToolProgressReplyOptions: vi.fn(() => ({})),
    } as never,
    client: {} as MatrixClient,
    roomId: "!room:example.org",
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    replyToMode: "off",
    accountId: "default",
    mediaLocalRoots: [],
    logVerboseMessage: vi.fn(),
  });
}

describe("createMatrixReplyDispatcher", () => {
  beforeEach(() => {
    deliverMatrixRepliesMock.mockReset().mockResolvedValue({ visibleReplySent: true });
  });

  it.each([
    { level: "off" as const, delivered: false },
    { level: "stream" as const, delivered: false },
    { level: "on" as const, delivered: true },
  ])(
    "delivers durable reasoning only when the resolved mode is $level",
    async ({ level, delivered }) => {
      const dispatcher = createDispatcher();
      dispatcher.setReasoningLevel(level);

      await dispatcher.deliverReply(
        { text: "Resolved thought", isReasoning: true },
        { kind: "final" },
      );

      expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(delivered ? 1 : 0);
    },
  );

  it("delivers stream-mode reasoning when the reasoning block ends", async () => {
    const dispatcher = createDispatcher();
    dispatcher.setReasoningLevel("stream");

    expect(dispatcher.turnDispatcherOptions.onReasoningStream?.({ text: "Checking tools" })).toBe(
      false,
    );
    expect(deliverMatrixRepliesMock).not.toHaveBeenCalled();

    await expect(dispatcher.turnDispatcherOptions.onReasoningEnd?.()).resolves.toBe(true);

    expect(deliverMatrixRepliesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        roomId: "!room:example.org",
        replies: [{ text: "Checking tools", isReasoning: true }],
      }),
    );
  });

  it("drains every reasoning window before the final reply", async () => {
    let resolveFirst!: (value: { visibleReplySent: boolean }) => void;
    const firstDelivery = new Promise<{ visibleReplySent: boolean }>((resolve) => {
      resolveFirst = resolve;
    });
    deliverMatrixRepliesMock
      .mockImplementationOnce(async () => await firstDelivery)
      .mockResolvedValue({ visibleReplySent: true });
    const dispatcher = createDispatcher();
    dispatcher.setReasoningLevel("stream");

    dispatcher.turnDispatcherOptions.onReasoningStream?.({ text: "First window" });
    const firstEnd = dispatcher.turnDispatcherOptions.onReasoningEnd?.();
    dispatcher.turnDispatcherOptions.onReasoningStream?.({ text: "Second window" });
    const secondEnd = dispatcher.turnDispatcherOptions.onReasoningEnd?.();
    const finalDelivery = dispatcher.deliverReply({ text: "Final answer" }, { kind: "final" });
    await Promise.resolve();

    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);
    resolveFirst({ visibleReplySent: true });
    await expect(firstEnd).resolves.toBe(true);
    await expect(secondEnd).resolves.toBe(true);
    await expect(finalDelivery).resolves.toEqual({ visibleReplySent: true });

    expect(deliverMatrixRepliesMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ replies: [{ text: "First window", isReasoning: true }] }),
    );
    expect(deliverMatrixRepliesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ replies: [{ text: "Second window", isReasoning: true }] }),
    );
    expect(deliverMatrixRepliesMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ replies: [{ text: "Final answer" }] }),
    );
  });
});
