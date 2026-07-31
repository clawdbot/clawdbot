import { describe, expect, it } from "vitest";
import { toFeishuSendResult } from "./send-result.js";

describe("toFeishuSendResult", () => {
  it.each([undefined, "", "   "])(
    "rejects an acknowledged send without a real message identifier: %s",
    (messageId) => {
      expect(() =>
        toFeishuSendResult({ code: 0, data: { message_id: messageId } }, "oc_chat", "text"),
      ).toThrow("Feishu send failed: no message_id returned");
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
