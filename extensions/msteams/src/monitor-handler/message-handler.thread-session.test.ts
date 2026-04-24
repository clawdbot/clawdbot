import { describe, expect, it } from "vitest";
import { resolveMSTeamsRouteSessionKey } from "./thread-session.js";

const channelConversationSessionKey = "agent:main:msteams:channel:19:channel@thread.tacv2";

describe("msteams thread session isolation", () => {
  it("appends thread suffix to session key for channel thread replies", async () => {
    const sessionKey = resolveMSTeamsRouteSessionKey({
      baseSessionKey: channelConversationSessionKey,
      isChannel: true,
      replyToId: "thread-root-123",
    });

    expect(sessionKey).toContain("thread:");
    expect(sessionKey).toContain("thread-root-123");
  });

  it("does not append thread suffix for top-level channel messages", async () => {
    const sessionKey = resolveMSTeamsRouteSessionKey({
      baseSessionKey: channelConversationSessionKey,
      isChannel: true,
      replyToId: undefined,
    });

    expect(sessionKey).not.toContain("thread:");
    expect(sessionKey).toBe(channelConversationSessionKey);
  });

  it("produces different session keys for different threads in the same channel", async () => {
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

  it("does not affect DM session keys", async () => {
    const sessionKey = resolveMSTeamsRouteSessionKey({
      baseSessionKey: "agent:main:msteams:dm:user-1",
      isChannel: false,
      replyToId: "some-reply-id",
    });

    expect(sessionKey).not.toContain("thread:");
  });

  it("does not affect group chat session keys", async () => {
    const sessionKey = resolveMSTeamsRouteSessionKey({
      baseSessionKey: "agent:main:msteams:group:19:group-chat-id@unq.gbl.spaces",
      isChannel: false,
      replyToId: "some-reply-id",
    });

    expect(sessionKey).not.toContain("thread:");
  });

  it("prefers conversation message id over replyToId for deep channel replies", async () => {
    const sessionKey = resolveMSTeamsRouteSessionKey({
      baseSessionKey: channelConversationSessionKey,
      isChannel: true,
      conversationMessageId: "thread-root",
      replyToId: "nested-reply",
    });

    expect(sessionKey).toContain("thread-root");
    expect(sessionKey).not.toContain("nested-reply");
  });
});
