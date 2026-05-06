import { describe, expect, it } from "vitest";
import { deriveDurableFinalDeliveryRequirements } from "./capabilities.js";

describe("deriveDurableFinalDeliveryRequirements", () => {
  it("derives the default durable final text and hook requirements", () => {
    expect(deriveDurableFinalDeliveryRequirements({ payload: { text: "hello" } })).toEqual({
      text: true,
      messageSendingHooks: true,
    });
  });

  it("derives payload-dependent delivery requirements", () => {
    expect(
      deriveDurableFinalDeliveryRequirements({
        payload: {
          text: "caption",
          mediaUrls: ["https://example.com/a.png"],
          replyToId: "reply-1",
        },
        threadId: 42,
        silent: true,
        payloadTransport: true,
        batch: true,
        reconcileUnknownSend: true,
        afterSendSuccess: true,
        afterCommit: true,
      }),
    ).toEqual({
      text: true,
      media: true,
      replyTo: true,
      thread: true,
      silent: true,
      messageSendingHooks: true,
      payload: true,
      batch: true,
      reconcileUnknownSend: true,
      afterSendSuccess: true,
      afterCommit: true,
    });
  });

  it("applies channel-native extras without recording false requirements", () => {
    expect(
      deriveDurableFinalDeliveryRequirements({
        payload: { text: "hello" },
        extraCapabilities: {
          nativeQuote: false,
          thread: true,
        },
      }),
    ).toEqual({
      text: true,
      thread: true,
      messageSendingHooks: true,
    });
  });
});
