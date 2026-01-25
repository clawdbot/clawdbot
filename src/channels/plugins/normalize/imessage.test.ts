import { describe, expect, it } from "vitest";

import { normalizeIMessageMessagingTarget } from "./imessage.js";

describe("imessage target normalization", () => {
  it("preserves service prefixes for handles", () => {
    expect(normalizeIMessageMessagingTarget("sms:+1 (555) 222-3333")).toBe("sms:+15552223333");
  });

  it("drops service prefixes for chat targets", () => {
    expect(normalizeIMessageMessagingTarget("sms:chat_id:123")).toBe("chat_id:123");
    expect(normalizeIMessageMessagingTarget("imessage:CHAT_GUID:abc")).toBe("chat_guid:abc");
    expect(normalizeIMessageMessagingTarget("auto:ChatIdentifier:foo")).toBe("chat_identifier:foo");
  });
});
