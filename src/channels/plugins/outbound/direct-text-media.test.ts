// Direct text media outbound tests cover text and media delivery payload normalization.
import { describe, expect, it, vi } from "vitest";
import {
  sendPayloadMediaSequenceAndFinalize,
  sendPayloadMediaSequenceOrFallback,
} from "./direct-text-media.js";

describe("sendPayloadMediaSequenceOrFallback", () => {
  it("uses the no-media sender when no media entries exist", async () => {
    const send = vi.fn();
    const sendNoMedia = vi.fn(async () => ({ messageId: "text-1" }));

    await expect(
      sendPayloadMediaSequenceOrFallback({
        text: "hello",
        mediaUrls: [],
        send,
        sendNoMedia,
        fallbackResult: { messageId: "" },
      }),
    ).resolves.toEqual({ messageId: "text-1" });

    expect(send).not.toHaveBeenCalled();
    expect(sendNoMedia).toHaveBeenCalledOnce();
  });

  it("returns the last media send result and clears text after the first media", async () => {
    const calls: Array<{ text: string; mediaUrl: string; isFirst: boolean }> = [];

    await expect(
      sendPayloadMediaSequenceOrFallback({
        text: "caption",
        mediaUrls: ["a", "b"],
        send: async ({ text, mediaUrl, isFirst }) => {
          calls.push({ text, mediaUrl, isFirst });
          return { messageId: mediaUrl };
        },
        fallbackResult: { messageId: "" },
      }),
    ).resolves.toEqual({ messageId: "b" });

    expect(calls).toEqual([
      { text: "caption", mediaUrl: "a", isFirst: true },
      { text: "", mediaUrl: "b", isFirst: false },
    ]);
  });
});

describe("sendPayloadMediaSequenceAndFinalize", () => {
  it("skips media sends and finalizes directly when no media entries exist", async () => {
    const send = vi.fn();
    const finalize = vi.fn(async () => ({ messageId: "final-1" }));

    await expect(
      sendPayloadMediaSequenceAndFinalize({
        text: "hello",
        mediaUrls: [],
        send,
        finalize,
      }),
    ).resolves.toEqual({ messageId: "final-1" });

    expect(send).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("sends the media sequence before the finalizing send", async () => {
    const send = vi.fn(async ({ mediaUrl }: { mediaUrl: string }) => ({ messageId: mediaUrl }));
    const finalize = vi.fn(async () => ({ messageId: "final-2" }));

    await expect(
      sendPayloadMediaSequenceAndFinalize({
        text: "",
        mediaUrls: ["a", "b"],
        send,
        finalize,
      }),
    ).resolves.toEqual({ messageId: "final-2" });

    expect(send).toHaveBeenCalledTimes(2);
    expect(finalize).toHaveBeenCalledOnce();
  });
});
