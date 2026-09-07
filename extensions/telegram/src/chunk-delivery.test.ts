import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { describe, expect, it } from "vitest";
import { isTelegramSkippableChunkSendError } from "./chunk-delivery.js";

const telegramError = (errorCode: number, message: string) =>
  Object.assign(new Error(message), { error_code: errorCode });

describe("Telegram chunk delivery", () => {
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
