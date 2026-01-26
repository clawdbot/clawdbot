import { describe, expect, it } from "vitest";

import {
  formatIMessageChatTarget,
  isAllowedIMessageSender,
  normalizeIMessageHandle,
  parseIMessageTarget,
} from "./targets.js";

describe("imessage targets", () => {
  it("parses chat_id targets", () => {
    const target = parseIMessageTarget("chat_id:123");
    expect(target).toEqual({ kind: "chat_id", chatId: 123 });
  });

  it("parses chat targets", () => {
    const target = parseIMessageTarget("chat:456");
    expect(target).toEqual({ kind: "chat_id", chatId: 456 });
  });

  it("parses sms handles with service", () => {
    const target = parseIMessageTarget("sms:+1555");
    expect(target).toEqual({ kind: "handle", to: "+1555", service: "sms" });
  });

  it("normalizes handles", () => {
    expect(normalizeIMessageHandle("Name@Example.com")).toBe("name@example.com");
    expect(normalizeIMessageHandle(" +1 (555) 222-3333 ")).toBe("+15552223333");
  });

  it("normalizes chat_id prefixes case-insensitively", () => {
    expect(normalizeIMessageHandle("CHAT_ID:123")).toBe("chat_id:123");
    expect(normalizeIMessageHandle("Chat_Id:456")).toBe("chat_id:456");
    expect(normalizeIMessageHandle("chatid:789")).toBe("chat_id:789");
    expect(normalizeIMessageHandle("CHAT:42")).toBe("chat_id:42");
  });

  it("normalizes chat_guid prefixes case-insensitively", () => {
    expect(normalizeIMessageHandle("CHAT_GUID:abc-def")).toBe("chat_guid:abc-def");
    expect(normalizeIMessageHandle("ChatGuid:XYZ")).toBe("chat_guid:XYZ");
    expect(normalizeIMessageHandle("GUID:test-guid")).toBe("chat_guid:test-guid");
  });

  it("normalizes chat_identifier prefixes case-insensitively", () => {
    expect(normalizeIMessageHandle("CHAT_IDENTIFIER:iMessage;-;chat123")).toBe(
      "chat_identifier:iMessage;-;chat123",
    );
    expect(normalizeIMessageHandle("ChatIdentifier:test")).toBe("chat_identifier:test");
    expect(normalizeIMessageHandle("CHATIDENT:foo")).toBe("chat_identifier:foo");
  });

  it("checks allowFrom against chat_id", () => {
    const ok = isAllowedIMessageSender({
      allowFrom: ["chat_id:9"],
      sender: "+1555",
      chatId: 9,
    });
    expect(ok).toBe(true);
  });

  it("checks allowFrom against handle", () => {
    const ok = isAllowedIMessageSender({
      allowFrom: ["user@example.com"],
      sender: "User@Example.com",
    });
    expect(ok).toBe(true);
  });

  it("formats chat targets", () => {
    expect(formatIMessageChatTarget(42)).toBe("chat_id:42");
    expect(formatIMessageChatTarget(undefined)).toBe("");
  });
});
