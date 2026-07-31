import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { describe, expect, it } from "vitest";
import { toFeishuSendResult } from "./send-result.js";

describe("toFeishuSendResult", () => {
  it.each([undefined, "", "   "])(
    "rejects an acknowledged send without a real message identifier: %s",
    (messageId) => {
      let caught: unknown;
      try {
        toFeishuSendResult({ code: 0, data: { message_id: messageId } }, "oc_chat", "text");
      } catch (error) {
        caught = error;
      }

      expect(isChannelPartialDeliveryError(caught)).toBe(true);
      if (!(caught instanceof Error) || !isChannelPartialDeliveryError(caught)) {
        throw new Error("expected an accepted Feishu delivery without an identity");
      }
      expect(caught.message).toBe("Feishu send failed: no message_id returned");
      expect(caught.deliveryResult).toEqual({ messageIds: [], visibleReplySent: true });
    },
  );

  it("normalizes the accepted platform identifier consistently across the result and receipt", () => {
    const result = toFeishuSendResult(
      { code: 0, data: { message_id: "  om_accepted  " } },
      "oc_chat",
      "card",
    );

    expect(result.messageId).toBe("om_accepted");
    expect(result.receipt.primaryPlatformMessageId).toBe("om_accepted");
  });
});
