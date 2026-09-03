// Slack tests cover thread ts plugin behavior.
import { describe, expect, it } from "vitest";
import {
  normalizeSlackThreadTsCandidate,
  resolveSlackReplyThreadTs,
  resolveSlackThreadTsValue,
} from "./thread-ts.js";

describe("Slack reply target selection", () => {
  it("prefers explicit reply targets when reply tags are enabled", () => {
    expect(
      resolveSlackReplyThreadTs({
        replyToMode: "first",
        replyToId: "explicit-thread",
        threadId: "planned-thread",
      }),
    ).toBe("explicit-thread");
  });

  it("ignores explicit reply tags when replyToMode is off", () => {
    expect(
      resolveSlackReplyThreadTs({
        replyToMode: "off",
        replyToId: "explicit-thread",
        threadId: "planned-thread",
      }),
    ).toBe("planned-thread");
  });

  it("uses the planned thread when no explicit reply tag exists", () => {
    expect(resolveSlackReplyThreadTs({ replyToMode: "batched", threadId: "planned-thread" })).toBe(
      "planned-thread",
    );
  });

  it("keeps a current reply target when there is no existing thread", () => {
    expect(resolveSlackReplyThreadTs({ replyToCurrent: true, replyToId: "current-message" })).toBe(
      "current-message",
    );
  });
});

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
