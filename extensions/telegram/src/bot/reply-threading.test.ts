import { describe, expect, it, vi } from "vitest";
import { isTelegramEmptyContentError } from "../rich-plain-fallback.js";
import { sendChunkedTelegramReplyText } from "./reply-threading.js";

describe("sendChunkedTelegramReplyText", () => {
  it("carries first-send state past an empty skipped chunk", async () => {
    const progress = { hasReplied: false, hasDelivered: false };
    const replyMarkup = { inline_keyboard: [] };
    const seenMarkup: Array<typeof replyMarkup | undefined> = [];
    const recordChunk = vi.fn(async () => {});
    const sendChunk = vi.fn(async (params: { replyMarkup?: typeof replyMarkup }) => {
      seenMarkup.push(params.replyMarkup);
      if (sendChunk.mock.calls.length === 1) {
        throw new Error("Bad Request: text must be non-empty");
      }
      return 301;
    });

    await sendChunkedTelegramReplyText({
      chunks: ["empty", "visible"],
      progress,
      replyToId: 555,
      replyToMode: "all",
      replyMarkup,
      invalidate: vi.fn(),
      onRejected: vi.fn(),
      isSilentSkip: isTelegramEmptyContentError,
      onSilentSkip: vi.fn(),
      sendChunk,
      recordChunk,
    });

    expect(seenMarkup).toEqual([replyMarkup, replyMarkup]);
    expect(recordChunk).toHaveBeenCalledOnce();
    expect(recordChunk).toHaveBeenCalledWith(301, "visible");
    expect(progress).toEqual({ hasReplied: true, hasDelivered: true });
  });
});
