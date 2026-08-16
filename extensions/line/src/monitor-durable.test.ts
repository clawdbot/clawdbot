// Line tests cover monitor durable plugin behavior.
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
      // Requiring reconciliation is what earns this send a durable intent id, so a
      // send interrupted mid-flight can be resolved instead of stranded.
      requiredCapabilities: {
        text: true,
        messageSendingHooks: true,
        reconcileUnknownSend: true,
      },
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

  it("keeps rich and media replies durable now that every part is keyed", () => {
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "hello", channelData: { line: { quickReplies: ["One"] } } },
        infoKind: "final",
        to: "U123",
        replyTokenUsed: true,
      }),
    ).toMatchObject({
      to: "U123",
      requiredCapabilities: { payload: true, reconcileUnknownSend: true },
    });
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "photo", mediaUrl: "https://example.com/image.png" },
        infoKind: "final",
        to: "U123",
        replyTokenUsed: true,
      }),
    ).toMatchObject({
      to: "U123",
      requiredCapabilities: { media: true, reconcileUnknownSend: true },
    });
  });

  it("keeps non-final and empty replies on the legacy path", () => {
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "hello" },
        infoKind: "block",
        to: "U123",
        replyTokenUsed: true,
      }),
    ).toBe(false);
    expect(
      resolveLineDurableReplyOptions({
        payload: { text: "" },
        infoKind: "final",
        to: "U123",
        replyTokenUsed: true,
      }),
    ).toBe(false);
  });
});
