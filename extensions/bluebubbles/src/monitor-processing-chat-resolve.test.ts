import { describe, expect, it } from "vitest";
import {
  _sanitizeBlueBubblesLogValueForTest,
  buildBlueBubblesInboundChatResolveTarget,
} from "./monitor-processing.js";

describe("buildBlueBubblesInboundChatResolveTarget", () => {
  it("uses chat_id for group inbound when chatId is present", () => {
    const target = buildBlueBubblesInboundChatResolveTarget({
      isGroup: true,
      chatId: 42,
      chatIdentifier: undefined,
      senderId: "+15551234567",
    });
    expect(target).toEqual({ kind: "chat_id", chatId: 42 });
  });

  it("uses chat_identifier for group inbound when chatId missing but identifier present", () => {
    const target = buildBlueBubblesInboundChatResolveTarget({
      isGroup: true,
      chatId: undefined,
      chatIdentifier: "iMessage;+;chat-abc",
      senderId: "+15551234567",
    });
    expect(target).toEqual({
      kind: "chat_identifier",
      chatIdentifier: "iMessage;+;chat-abc",
    });
  });

  it("prefers chat_id over chat_identifier when both are present for a group", () => {
    const target = buildBlueBubblesInboundChatResolveTarget({
      isGroup: true,
      chatId: 7,
      chatIdentifier: "iMessage;+;chat-abc",
      senderId: "+15551234567",
    });
    expect(target).toEqual({ kind: "chat_id", chatId: 7 });
  });

  it("REFUSES sender-handle fallback for group inbound with no chat identifiers", () => {
    // This is the candidate-4 regression: BlueBubbles webhooks for tapbacks
    // and certain reaction/updated-message events arrive without chatGuid/
    // chatId/chatIdentifier. Falling through to { kind: "handle",
    // address: senderId } would resolve the sender's DM chatGuid and
    // poison every action keyed off it (ack reaction, mark-read, outbound
    // reply cache), making group reactions land in DMs.
    const target = buildBlueBubblesInboundChatResolveTarget({
      isGroup: true,
      chatId: undefined,
      chatIdentifier: undefined,
      senderId: "+15551234567",
    });
    expect(target).toBeNull();
  });

  it("treats blank chatIdentifier as missing for group inbound", () => {
    const target = buildBlueBubblesInboundChatResolveTarget({
      isGroup: true,
      chatId: undefined,
      chatIdentifier: "   ",
      senderId: "+15551234567",
    });
    expect(target).toBeNull();
  });

  it("treats non-finite chatId as missing for group inbound", () => {
    const target = buildBlueBubblesInboundChatResolveTarget({
      isGroup: true,
      chatId: Number.NaN,
      chatIdentifier: undefined,
      senderId: "+15551234567",
    });
    expect(target).toBeNull();
  });

  it("treats null chatId/chatIdentifier as missing for group inbound", () => {
    const target = buildBlueBubblesInboundChatResolveTarget({
      isGroup: true,
      chatId: null,
      chatIdentifier: null,
      senderId: "+15551234567",
    });
    expect(target).toBeNull();
  });

  it("uses sender handle for DM inbound (the chat IS the conversation with that sender)", () => {
    const target = buildBlueBubblesInboundChatResolveTarget({
      isGroup: false,
      chatId: undefined,
      chatIdentifier: undefined,
      senderId: "+15551234567",
    });
    expect(target).toEqual({ kind: "handle", address: "+15551234567" });
  });

  it("uses sender handle for DM inbound even when chatId is present (preserves prior behavior)", () => {
    const target = buildBlueBubblesInboundChatResolveTarget({
      isGroup: false,
      chatId: 99,
      chatIdentifier: "iMessage;-;+15551234567",
      senderId: "+15551234567",
    });
    expect(target).toEqual({ kind: "handle", address: "+15551234567" });
  });

  it("returns null for DM inbound with empty senderId", () => {
    const target = buildBlueBubblesInboundChatResolveTarget({
      isGroup: false,
      chatId: undefined,
      chatIdentifier: undefined,
      senderId: "   ",
    });
    expect(target).toBeNull();
  });
});

describe("BlueBubbles monitor log sanitization", () => {
  it("redacts BlueBubbles query auth and Authorization headers", () => {
    const input =
      "GET /api/v1/attachment?password=secret&guid=socket-secret&token=api-token Authorization: Bearer abc123";

    const sanitized = _sanitizeBlueBubblesLogValueForTest(input);

    expect(sanitized).toContain("password=<redacted>");
    expect(sanitized).toContain("guid=<redacted>");
    expect(sanitized).toContain("token=<redacted>");
    expect(sanitized).toContain("Authorization: Bearer <redacted>");
    expect(sanitized).not.toContain("secret");
    expect(sanitized).not.toContain("api-token");
    expect(sanitized).not.toContain("abc123");
  });

  it("strips control characters before logging", () => {
    expect(_sanitizeBlueBubblesLogValueForTest("one\ntwo\tt\u0000hree")).toBe("one two t hree");
  });
});
