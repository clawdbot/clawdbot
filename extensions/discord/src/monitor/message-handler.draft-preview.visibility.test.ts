import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const draftStream = vi.hoisted(() => ({
  update: vi.fn(),
  flush: vi.fn(async () => {}),
  messageId: vi.fn<() => string | undefined>(() => undefined),
  clear: vi.fn(async () => {}),
  deleteCurrentMessage: vi.fn(async () => {}),
  discardPending: vi.fn(async () => {}),
  seal: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  retarget: vi.fn(async () => {}),
  cleanupPendingMessages: vi.fn(async () => {}),
  forceNewMessage: vi.fn(),
}));

vi.mock("../draft-stream.js", () => ({
  createDiscordDraftStream: () => draftStream,
}));

import { createDiscordDraftPreviewController } from "./message-handler.draft-preview.js";

describe("Discord progress visibility", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of Object.values(draftStream)) {
      mock.mockClear();
    }
    draftStream.messageId.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries identical progress until Discord acknowledges a draft message", async () => {
    const controller = createDiscordDraftPreviewController({
      cfg: {},
      discordConfig: { streaming: { mode: "progress" } },
      accountId: "default",
      sourceRepliesAreToolOnly: false,
      textLimit: 2_000,
      deliveryRest: {} as never,
      deliverChannelId: "channel-1",
      replyReference: { peek: () => undefined },
      tableMode: "off",
      maxLinesPerMessage: undefined,
      chunkMode: "length",
      log: vi.fn(),
    });
    const progress = { itemId: "item-1", progressText: "still working" };

    expect(await controller.pushItemEvent(progress)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(draftStream.update).toHaveBeenCalledTimes(1);

    expect(await controller.pushItemEvent(progress)).toBe(false);
    expect(draftStream.update).toHaveBeenCalledTimes(2);

    draftStream.messageId.mockReturnValue("message-1");
    expect(await controller.pushItemEvent(progress)).toBe(true);
    expect(draftStream.update).toHaveBeenCalledTimes(3);
    await controller.cleanup();
  });
});
