import { describe, expect, it } from "vitest";
import { normalizeSlackThreadTsCandidate, resolveSlackThreadTsValue } from "./thread-ts.js";

describe("Slack thread_ts resolution", () => {
  it("accepts trimmed Slack timestamp strings", () => {
    expect(normalizeSlackThreadTsCandidate(" 1712345678.123456 ")).toBe("1712345678.123456");
  });

  it("rejects internal reply ids", () => {
    expect(normalizeSlackThreadTsCandidate("msg-internal-1")).toBeUndefined();
  });

  it("rejects numeric thread ids instead of stringifying them", () => {
    expect(normalizeSlackThreadTsCandidate(1712345678.123456)).toBeUndefined();
  });

  it("falls back from invalid replyToId to valid threadId", () => {
    expect(
      resolveSlackThreadTsValue({
        replyToId: "msg-internal-1",
        threadId: "1712345678.123456",
      }),
    ).toBe("1712345678.123456");
  });

  it("validates fallback threadId before using it", () => {
    expect(
      resolveSlackThreadTsValue({
        replyToId: "msg-internal-1",
        threadId: "thread-root",
      }),
    ).toBeUndefined();
  });
});
