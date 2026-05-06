import { describe, expect, it } from "vitest";
import { resolveLineDurableReplyOptions } from "./monitor-durable.js";

describe("resolveLineDurableReplyOptions", () => {
  it("enables durable final delivery for push-only text replies", () => {
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "hello" },
        infoKind: "final",
        to: "U123",
        replyToken: "reply-token",
        replyTokenUsed: true,
      }),
    ).toEqual({
      to: "U123",
    });
  });

  it("keeps unused reply-token delivery on the legacy path", () => {
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "hello" },
        infoKind: "final",
        to: "U123",
        replyToken: "reply-token",
        replyTokenUsed: false,
      }),
    ).toBe(false);
  });

  it("keeps rich, media, and non-final replies on the legacy path", () => {
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "hello", channelData: { line: { quickReplies: ["One"] } } },
        infoKind: "final",
        to: "U123",
        replyTokenUsed: true,
      }),
    ).toBe(false);
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "photo", mediaUrl: "https://example.com/image.png" },
        infoKind: "final",
        to: "U123",
        replyTokenUsed: true,
      }),
    ).toBe(false);
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "hello" },
        infoKind: "block",
        to: "U123",
        replyTokenUsed: true,
      }),
    ).toBe(false);
  });
});
