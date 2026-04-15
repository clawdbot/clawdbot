import { describe, expect, it } from "vitest";
import { looksLikeIMessageTargetId, normalizeIMessageMessagingTarget } from "./normalize.js";

describe("normalizeIMessageMessagingTarget", () => {
  it("normalizes blank inputs to undefined", () => {
    expect(normalizeIMessageMessagingTarget("   ")).toBeUndefined();
  });

  it("preserves service prefixes for handles", () => {
    expect(normalizeIMessageMessagingTarget("sms:+1 (555) 222-3333")).toBe("sms:+15552223333");
  });

  it("drops service prefixes for chat targets", () => {
    expect(normalizeIMessageMessagingTarget("sms:chat_id:123")).toBe("chat_id:123");
    expect(normalizeIMessageMessagingTarget("imessage:CHAT_GUID:abc")).toBe("chat_guid:abc");
    expect(normalizeIMessageMessagingTarget("auto:ChatIdentifier:foo")).toBe("chatidentifier:foo");
  });
});

describe("looksLikeIMessageTargetId", () => {
  it("detects common iMessage target forms", () => {
    expect(looksLikeIMessageTargetId("sms:+15555550123")).toBe(true);
    expect(looksLikeIMessageTargetId("chat_id:123")).toBe(true);
    expect(looksLikeIMessageTargetId("user@example.com")).toBe(true);
    expect(looksLikeIMessageTargetId("+15555550123")).toBe(true);
    expect(looksLikeIMessageTargetId("")).toBe(false);
  });
});
