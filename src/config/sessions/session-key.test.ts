// Session key tests cover session key generation and normalization.
import { describe, expect, it } from "vitest";
import { resolveSessionKey } from "./session-key.js";
import { installDiscordSessionKeyNormalizerFixture, makeCtx } from "./session-key.test-helpers.js";

installDiscordSessionKeyNormalizerFixture();

describe("resolveSessionKey", () => {
  it("uses an explicit agent id for canonical direct-chat keys", () => {
    const ctx = makeCtx({
      From: "+15551234567",
    });

    expect(resolveSessionKey("per-sender", ctx, "main", "ops")).toBe("agent:ops:main");
  });

  it("uses an explicit agent id for group keys", () => {
    const ctx = makeCtx({
      From: "C123",
      ChatType: "channel",
      Provider: "slack",
    });

    expect(resolveSessionKey("per-sender", ctx, "main", "ops")).toBe(
      "agent:ops:slack:channel:c123",
    );
  });

  describe("Discord DM session key normalization", () => {
    it.each([
      {
        title: "passes through correct discord:direct keys unchanged",
        sessionKey: "agent:fina:discord:direct:123456",
        chatType: "direct",
        normalizedKey: "discord:123456",
        senderId: "123456",
        expected: "agent:fina:discord:direct:123456",
      },
      {
        title: "migrates legacy discord:dm: keys to discord:direct:",
        sessionKey: "agent:fina:discord:dm:123456",
        chatType: "direct",
        normalizedKey: "discord:123456",
        senderId: "123456",
        expected: "agent:fina:discord:direct:123456",
      },
      {
        title: "fixes phantom discord:channel:USERID keys when sender matches",
        sessionKey: "agent:fina:discord:channel:123456",
        chatType: "direct",
        normalizedKey: "discord:123456",
        senderId: "123456",
        expected: "agent:fina:discord:direct:123456",
      },
      {
        title: "does not rewrite discord:channel: keys for non-direct chats",
        sessionKey: "agent:fina:discord:channel:123456",
        chatType: "channel",
        normalizedKey: "discord:channel:123456",
        senderId: "789",
        expected: "agent:fina:discord:channel:123456",
      },
      {
        title: "does not rewrite discord:channel: keys when sender does not match",
        sessionKey: "agent:fina:discord:channel:123456",
        chatType: "direct",
        normalizedKey: "discord:789",
        senderId: "789",
        expected: "agent:fina:discord:channel:123456",
      },
      {
        title: "handles keys without an agent prefix",
        sessionKey: "discord:channel:123456",
        chatType: "direct",
        normalizedKey: "discord:123456",
        senderId: "123456",
        expected: "discord:direct:123456",
      },
    ])("$title", ({ sessionKey, chatType, normalizedKey, senderId, expected }) => {
      const ctx = makeCtx({
        SessionKey: sessionKey,
        ChatType: chatType,
        From: normalizedKey,
        SenderId: senderId,
      });
      expect(resolveSessionKey("per-sender", ctx)).toBe(expected);
    });
  });
});
