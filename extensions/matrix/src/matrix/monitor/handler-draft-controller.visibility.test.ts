import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const draftStream = vi.hoisted(() => ({
  setKind: vi.fn(),
  update: vi.fn(),
  flush: vi.fn(async () => {}),
  stop: vi.fn(async () => undefined),
  discardPending: vi.fn(async () => {}),
  finalizeLive: vi.fn(async () => true),
  reset: vi.fn(),
  eventId: vi.fn<() => string | undefined>(() => undefined),
  content: vi.fn(() => undefined),
  matchesPreparedText: vi.fn(() => false),
  mustDeliverFinalNormally: vi.fn(() => false),
}));

vi.mock("./handler-runtime.js", () => ({
  loadMatrixDraftStream: async () => ({
    createMatrixDraftStream: () => draftStream,
  }),
}));

import { createMatrixDraftController } from "./handler-draft-controller.js";

describe("Matrix progress visibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of Object.values(draftStream)) {
      mock.mockClear();
    }
    draftStream.eventId.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries identical progress until Matrix acknowledges a draft event", async () => {
    const controller = await createMatrixDraftController({
      streaming: "progress",
      previewToolProgressEnabled: true,
      replyToMode: "off",
      messageId: "$inbound",
      cfg: {},
      accountId: "default",
      roomId: "!room:example.org",
      client: {} as never,
      logVerboseMessage: vi.fn(),
    });
    const options = controller.buildPreviewToolProgressReplyOptions();
    const progress = { itemId: "item-1", progressText: "still working" };

    expect(await options.onItemEvent?.(progress)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(draftStream.update).toHaveBeenCalledTimes(1);

    expect(await options.onItemEvent?.(progress)).toBe(false);
    expect(draftStream.update).toHaveBeenCalledTimes(2);

    draftStream.eventId.mockReturnValue("$draft");
    expect(await options.onItemEvent?.(progress)).toBe(true);
    expect(draftStream.update).toHaveBeenCalledTimes(3);
    controller.cancelProgressDraft();
  });
});
