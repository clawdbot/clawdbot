// Delivery result tests cover channel turn delivery result normalization.
import { describe, expect, it } from "vitest";
import {
  createChannelDeliveryResultFromReceipt,
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "./delivery-result.js";

describe("createChannelDeliveryResultFromReceipt", () => {
  it("keeps legacy messageIds while attaching the receipt", () => {
    const receipt = {
      primaryPlatformMessageId: "m1",
      platformMessageIds: ["m1", "m2"],
      parts: [],
      sentAt: 123,
    };

    expect(
      createChannelDeliveryResultFromReceipt({
        receipt,
        threadId: "thread-1",
        replyToId: "reply-1",
        visibleReplySent: true,
        deliveryIntent: {
          id: "intent-1",
          kind: "outbound_queue",
          queuePolicy: "required",
        },
      }),
    ).toEqual({
      messageIds: ["m1", "m2"],
      receipt,
      threadId: "thread-1",
      replyToId: "reply-1",
      visibleReplySent: true,
      deliveryIntent: {
        id: "intent-1",
        kind: "outbound_queue",
        queuePolicy: "required",
      },
    });
  });

  it("preserves suppressed receipt results without synthetic message ids", () => {
    const receipt = {
      platformMessageIds: [],
      parts: [],
      sentAt: 123,
    };

    expect(
      createChannelDeliveryResultFromReceipt({
        receipt,
        visibleReplySent: false,
      }),
    ).toEqual({
      receipt,
      visibleReplySent: false,
    });
  });
});

describe("channel partial delivery errors", () => {
  it("carries nested provider facts and top-level visibility markers", () => {
    const cause = new Error("final edit failed");
    const error = createChannelPartialDeliveryError(cause, {
      content: "accepted preview",
      messageIds: ["provider-1"],
      visibleReplySent: true,
    });

    expect(error).toMatchObject({
      cause,
      code: "CHANNEL_PARTIAL_DELIVERY",
      sentBeforeError: true,
      visibleReplySent: true,
      deliveryResult: {
        content: "accepted preview",
        messageIds: ["provider-1"],
        visibleReplySent: true,
      },
    });
    expect(isChannelPartialDeliveryError(error)).toBe(true);
  });

  it("recognizes the documented structural envelope", () => {
    expect(
      isChannelPartialDeliveryError({
        code: "CHANNEL_PARTIAL_DELIVERY",
        deliveryResult: { visibleReplySent: true },
      }),
    ).toBe(true);
    expect(
      isChannelPartialDeliveryError({
        code: "CHANNEL_PARTIAL_DELIVERY",
        deliveryResult: { visibleReplySent: false },
      }),
    ).toBe(false);
  });
});
