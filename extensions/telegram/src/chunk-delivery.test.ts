import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it } from "vitest";
import {
  isTelegramSkippableChunkSendError,
  mergeTelegramPartialDeliveryError,
} from "./chunk-delivery.js";

const telegramError = (errorCode: number, message: string) =>
  Object.assign(new Error(message), { error_code: errorCode });

describe("Telegram chunk delivery", () => {
  it("retains every album receipt part when the first accepted-message observer fails", () => {
    const receipt = createMessageReceiptFromOutboundResults({
      results: [{ messageId: "41" }, { messageId: "42" }],
      kind: "media",
      threadId: "7",
    });
    const error = createChannelPartialDeliveryError(new Error("observer failed"), {
      messageIds: ["41"],
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ messageId: "41" }],
        kind: "media",
        threadId: "7",
      }),
      visibleReplySent: true,
    });
    const merged = mergeTelegramPartialDeliveryError(error, {
      messageIds: ["41", "42"],
      receipt,
      visibleReplySent: true,
    });
    expect(merged.deliveryResult.messageIds).toEqual(["41", "42"]);
    expect(merged.deliveryResult.receipt?.platformMessageIds).toEqual(["41", "42"]);
    expect(merged.deliveryResult.receipt?.parts).toMatchObject([
      { platformMessageId: "41", kind: "media", index: 0, threadId: "7" },
      { platformMessageId: "42", kind: "media", index: 1, threadId: "7" },
    ]);
  });
  it.each([
    [telegramError(400, "content rejected"), true],
    [Object.assign(new Error("dns failed"), { code: "ENOTFOUND" }), true],
    [
      new PlatformMessageNotDispatchedError("request not started", {
        cause: new Error("transport unavailable"),
      }),
      true,
    ],
    [
      new PlatformMessageNotDispatchedError("payload rejected", {
        cause: new Error("invalid payload"),
        retryable: false,
      }),
      false,
    ],
    [telegramError(400, "message thread not found"), false],
    [telegramError(401, "unauthorized"), false],
    [telegramError(429, "rate limited"), false],
    [telegramError(500, "server error"), false],
    [new Error("ambiguous transport failure"), false],
  ])("classifies %s as skippable=%s", (error, expected) => {
    expect(isTelegramSkippableChunkSendError(error)).toBe(expected);
  });
});
