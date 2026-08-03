// Tests that isRetryableNoSendFailure (inside createReplyDispatcher) classifies
// an OutboundDeliveryError with sentBeforeError === false as failed-before-deliver
// so the pendingFinalDelivery marker is preserved (#117441).
import { describe, expect, it } from "vitest";
import { OutboundDeliveryError } from "../../infra/outbound/deliver-types.js";
import type { ReplyPayload } from "../types.js";
import { captureReplyDispatchDeliveryOutcome, createReplyDispatcher } from "./reply-dispatcher.js";

describe("reply dispatcher no-send failure classification", () => {
  it("classifies OutboundDeliveryError with no send as failed-before-deliver", async () => {
    const payload: ReplyPayload = { text: "final reply" };
    const error = new OutboundDeliveryError("No active WhatsApp Web listener", {
      cause: new Error("no listener"),
    });
    // sentBeforeError defaults to false (results is empty).

    const tracker = captureReplyDispatchDeliveryOutcome(payload);
    const dispatcher = createReplyDispatcher({
      deliver: async () => {
        throw error;
      },
    });

    dispatcher.sendFinalReply(payload);
    await dispatcher.waitForIdle();

    // The outcome must be failed-before-deliver (not failed-deliver) because
    // no recipient-visible send occurred — the marker should be preserved.
    await expect(tracker.promise).resolves.toBe("failed-before-deliver");
  });
});
