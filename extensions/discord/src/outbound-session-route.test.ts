import { describe, expect, it } from "vitest";
import { resolveDiscordOutboundSessionRoute } from "./outbound-session-route.js";

describe("resolveDiscordOutboundSessionRoute", () => {
  it("keeps explicit delivery thread ids without adding a session suffix", () => {
    const route = resolveDiscordOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "channel:123",
      threadId: "thread-1",
    });

    expect(route).toEqual({
      baseSessionKey: "agent:main:discord:channel:123",
      chatType: "channel",
      from: "discord:channel:123",
      peer: { kind: "channel", id: "123" },
      sessionKey: "agent:main:discord:channel:123",
      threadId: "thread-1",
      to: "channel:123",
    });
  });

  it("does not promote replyToId into Discord delivery thread metadata", () => {
    const route = resolveDiscordOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "channel:123",
      replyToId: "message-1",
    });

    expect(route).toEqual({
      baseSessionKey: "agent:main:discord:channel:123",
      chatType: "channel",
      from: "discord:channel:123",
      peer: { kind: "channel", id: "123" },
      sessionKey: "agent:main:discord:channel:123",
      to: "channel:123",
    });
    expect(route?.threadId).toBeUndefined();
  });
});
