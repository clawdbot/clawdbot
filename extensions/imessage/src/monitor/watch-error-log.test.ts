import { describe, expect, it } from "vitest";
import { sanitizeIMessageWatchErrorPayload } from "./watch-error-log.js";

describe("sanitizeIMessageWatchErrorPayload", () => {
  it("keeps only code and a sanitized truncated message", () => {
    expect(
      sanitizeIMessageWatchErrorPayload({
        code: 500,
        message: `boom\n\t\u001b[2K${"x".repeat(250)}`,
        chatId: "chat-123",
        participants: ["+15555550123"],
        path: "/Users/me/Library/Messages/chat.db",
      }),
    ).toEqual({
      code: 500,
      message: `boom\\n\\t${"x".repeat(191)}…`,
    });
  });

  it("drops non-object payloads and unsupported fields", () => {
    expect(sanitizeIMessageWatchErrorPayload("boom")).toStrictEqual({});
    expect(
      sanitizeIMessageWatchErrorPayload({
        code: Number.POSITIVE_INFINITY,
        message: 123,
        data: { sender: "+15555550123" },
      }),
    ).toStrictEqual({});
  });
});
