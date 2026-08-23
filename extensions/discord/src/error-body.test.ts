// Discord tests cover error body summary behavior.
import { describe, expect, it } from "vitest";
import { summarizeDiscordResponseBody } from "./error-body.js";

describe("summarizeDiscordResponseBody", () => {
  it("keeps truncated summaries on a UTF-16 boundary", () => {
    const summary = summarizeDiscordResponseBody(`${"a".repeat(239)}😀tail`);

    expect(summary).toBe("a".repeat(239));
  });
});
