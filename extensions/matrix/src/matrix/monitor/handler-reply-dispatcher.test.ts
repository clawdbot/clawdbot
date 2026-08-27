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

function createDispatcher(reasoningDefault: "off" | "on" | "stream" = "stream") {
  return createMatrixReplyDispatcher({
    cfg: { agents: { defaults: { reasoningDefault } } },
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
    textLimit: 4000,
    replyToMode: "off",
    accountId: "default",
    mediaLocalRoots: [],
    tableMode: "code",
    logVerboseMessage: vi.fn(),
  });
}

describe("createMatrixReplyDispatcher", () => {
  beforeEach(() => {
    deliverMatrixRepliesMock.mockClear();
  });

  it("disables both reasoning lanes when visibility is off", () => {
    const dispatcher = createDispatcher("off");

    expect(dispatcher.reasoningPayloadsEnabled).toBe(false);
    expect(dispatcher.turnDispatcherOptions.onReasoningStream).toBeUndefined();
    expect(dispatcher.turnDispatcherOptions.onReasoningEnd).toBeUndefined();
  });

  it("enables only durable reasoning when visibility is on", () => {
    const dispatcher = createDispatcher("on");

    expect(dispatcher.reasoningPayloadsEnabled).toBe(true);
    expect(dispatcher.turnDispatcherOptions.onReasoningStream).toBeUndefined();
    expect(dispatcher.turnDispatcherOptions.onReasoningEnd).toBeUndefined();
  });

  it("delivers stream-mode reasoning when the reasoning block ends", async () => {
    const dispatcher = createDispatcher();

    expect(dispatcher.reasoningPayloadsEnabled).toBe(false);

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

  it("drains stream-mode reasoning notices before final replies", async () => {
    let resolveReasoning!: (value: { visibleReplySent: boolean }) => void;
    const reasoningDelivery = new Promise<{ visibleReplySent: boolean }>((resolve) => {
      resolveReasoning = resolve;
    });
    deliverMatrixRepliesMock
      .mockImplementationOnce(async () => await reasoningDelivery)
      .mockResolvedValueOnce({ visibleReplySent: true });
    const dispatcher = createDispatcher();

    dispatcher.turnDispatcherOptions.onReasoningStream?.({ text: "Check @room first" });
    const reasoningEnd = dispatcher.turnDispatcherOptions.onReasoningEnd?.();
    const finalDelivery = dispatcher.deliverReply({ text: "Final answer" }, { kind: "final" });
    await Promise.resolve();

    expect(deliverMatrixRepliesMock).toHaveBeenCalledTimes(1);

    resolveReasoning({ visibleReplySent: true });
    await expect(reasoningEnd).resolves.toBe(true);
    await expect(finalDelivery).resolves.toEqual({ visibleReplySent: true });

    expect(deliverMatrixRepliesMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ replies: [{ text: "Check @room first", isReasoning: true }] }),
    );
    expect(deliverMatrixRepliesMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ replies: [{ text: "Final answer" }] }),
    );
  });
});
