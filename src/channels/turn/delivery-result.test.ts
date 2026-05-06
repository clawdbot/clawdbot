import { describe, expect, it } from "vitest";
import { createChannelDeliveryResultFromReceipt } from "./delivery-result.js";

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
