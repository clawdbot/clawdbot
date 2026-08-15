// Telegram question callback envelope tests.
import { describe, expect, it } from "vitest";
import {
  buildTelegramQuestionCallbackData,
  parseTelegramQuestionCallbackData,
} from "./question-callback-data.js";

describe("question callback data", () => {
  const questionId = "ask_0123456789abcdef0123456789abcdef";

  it("round-trips a compact option index within Telegram's byte limit", () => {
    const data = buildTelegramQuestionCallbackData({ questionId, optionIndex: 3 });

    expect(data).toBe(`tgq1:${questionId}:3`);
    expect(Buffer.byteLength(data ?? "", "utf8")).toBe(43);
    expect(Buffer.byteLength(data ?? "", "utf8")).toBeLessThanOrEqual(64);
    expect(parseTelegramQuestionCallbackData(data)).toEqual({ questionId, optionIndex: 3 });
  });

  it.each([
    `tgq1:${questionId}:4`,
    `tgq2:${questionId}:0`,
    "tgq1:ask_short:0",
    `tgq1:${questionId}:0:extra`,
  ])("rejects malformed data: %s", (data) => {
    expect(parseTelegramQuestionCallbackData(data)).toBeNull();
  });
});
