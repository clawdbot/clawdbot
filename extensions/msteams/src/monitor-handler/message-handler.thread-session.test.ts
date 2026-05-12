import { describe, expect, it } from "vitest";
import { resolveMSTeamsRouteSessionKey } from "./thread-session.js";

const channelConversationSessionKey = "agent:main:msteams:channel:19:channel@thread.tacv2";

describe("msteams thread session isolation", () => {
  it("appends thread suffix to session key for channel thread replies", () => {
    const sessionKey = resolveMSTeamsRouteSessionKey({
      baseSessionKey: channelConversationSessionKey,
      isChannel: true,
      replyToId: "thread-root-123",
    });

    expect(sessionKey).toContain("thread:");
    expect(sessionKey).toContain("thread-root-123");
  });

  it("does not append thread suffix for top-level channel messages", () => {
    const sessionKey = resolveMSTeamsRouteSessionKey({
      baseSessionKey: channelConversationSessionKey,
      isChannel: true,
      replyToId: undefined,
    });

    expect(sessionKey).not.toContain("thread:");
    expect(sessionKey).toBe(channelConversationSessionKey);
  });

  it("produces different session keys for different threads in the same channel", () => {
    const sessionKeyA = resolveMSTeamsRouteSessionKey({
      baseSessionKey: channelConversationSessionKey,
      isChannel: true,
      replyToId: "thread-A",
    });
    const sessionKeyB = resolveMSTeamsRouteSessionKey({
      baseSessionKey: channelConversationSessionKey,
      isChannel: true,
      replyToId: "thread-B",
    });

    expect(sessionKeyA).not.toBe(sessionKeyB);
    expect(sessionKeyA).toContain("thread-a"); // normalized lowercase
    expect(sessionKeyB).toContain("thread-b");
  });

  it("does not affect DM session keys", () => {
    const sessionKey = resolveMSTeamsRouteSessionKey({
      baseSessionKey: "agent:main:msteams:dm:user-1",
      isChannel: false,
      replyToId: "some-reply-id",
    });

    expect(sessionKey).not.toContain("thread:");
  });

  it("does not affect group chat session keys", () => {
    const sessionKey = resolveMSTeamsRouteSessionKey({
      baseSessionKey: "agent:main:msteams:group:19:group-chat-id@unq.gbl.spaces",
      isChannel: false,
      replyToId: "some-reply-id",
    });

    expect(sessionKey).not.toContain("thread:");
  });

  it("prefers conversation message id over replyToId for deep channel replies", () => {
    const sessionKey = resolveMSTeamsRouteSessionKey({
      baseSessionKey: channelConversationSessionKey,
      isChannel: true,
      conversationMessageId: "thread-root",
      replyToId: "nested-reply",
    });

    expect(sessionKey).toContain("thread-root");
    expect(sessionKey).not.toContain("nested-reply");
  });

  // Regression coverage for #66771 — malformed mixed thread session key from
  // pre-suffixed base. The handler may pass a base that has already been
  // thread-qualified by a prior turn (e.g. cache-miss-returned route object
  // mutated in-place by message-handler.ts:489). The helper must be idempotent
  // and re-derive from a clean base.
  describe("idempotency against pre-suffixed bases (#66771)", () => {
    it("collapses an already-thread-suffixed base when re-applied with a different thread", () => {
      const sessionKey = resolveMSTeamsRouteSessionKey({
        baseSessionKey: `${channelConversationSessionKey}:thread:old-root`,
        isChannel: true,
        conversationMessageId: "new-root",
      });

      expect(sessionKey).toBe(`${channelConversationSessionKey}:thread:new-root`);
      expect(sessionKey).not.toContain("old-root");
      // No `:thread:OLD:thread:NEW` mixed shape.
      expect(sessionKey.match(/:thread:/g)).toHaveLength(1);
    });

    it("collapses a doubly-thread-suffixed (already-malformed) base to a single suffix", () => {
      const sessionKey = resolveMSTeamsRouteSessionKey({
        baseSessionKey: `${channelConversationSessionKey}:thread:x:thread:y`,
        isChannel: true,
        conversationMessageId: "z",
      });

      expect(sessionKey).toBe(`${channelConversationSessionKey}:thread:z`);
      expect(sessionKey).not.toContain(":thread:x");
      expect(sessionKey).not.toContain(":thread:y");
      expect(sessionKey.match(/:thread:/g)).toHaveLength(1);
    });

    it("is idempotent when the base is already qualified with the same thread", () => {
      const sessionKey = resolveMSTeamsRouteSessionKey({
        baseSessionKey: `${channelConversationSessionKey}:thread:same-root`,
        isChannel: true,
        conversationMessageId: "same-root",
      });

      expect(sessionKey).toBe(`${channelConversationSessionKey}:thread:same-root`);
      expect(sessionKey.match(/:thread:/g)).toHaveLength(1);
    });

    it("strips a stale thread suffix when the inbound is a top-level channel message", () => {
      const sessionKey = resolveMSTeamsRouteSessionKey({
        baseSessionKey: `${channelConversationSessionKey}:thread:stale-root`,
        isChannel: true,
        replyToId: undefined,
      });

      expect(sessionKey).toBe(channelConversationSessionKey);
      expect(sessionKey).not.toContain("thread:");
    });
  });
});
