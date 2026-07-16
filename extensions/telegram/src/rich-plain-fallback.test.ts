import { describe, expect, it } from "vitest";
import { buildTelegramPlainFallbackPlan } from "./rich-plain-fallback.js";

function planFor(message: string) {
  return buildTelegramPlainFallbackPlan({
    plainText: "fallback body",
    err: new Error(message),
    context: "test",
    warn: () => {},
  });
}

describe("buildTelegramPlainFallbackPlan", () => {
  // Live-verified Bot API 10.2 structural rejections (2026-07-15).
  it.each([
    "Bad Request: RICH_MESSAGE_BLOCKS_TOO_MANY",
    "Bad Request: RICH_MESSAGE_DEPTH_INVALID",
    "Bad Request: RICH_MESSAGE_TEXT_TOO_LONG",
    "Bad Request: RICH_MESSAGE_MEDIA_TOO_MANY",
    "Bad Request: RICH_MESSAGE_TABLE_COLS_TOO_MANY",
  ])("degrades structural rejection %s to plain text", (message) => {
    expect(planFor(message)?.chunks).toEqual(["fallback body"]);
  });

  it("degrades wire-shape parse rejections to plain text", () => {
    expect(
      planFor(
        'Bad Request: can\'t parse InputRichBlock: Field "custom_emoji_id" must be a valid Number',
      )?.chunks,
    ).toEqual(["fallback body"]);
  });

  it("rethrows unrelated errors", () => {
    expect(planFor("Bad Request: chat not found")).toBeUndefined();
  });
});
