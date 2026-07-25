// Discord tests cover outbound session route plugin behavior.
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
      baseSessionKey: "agent:main:discord:channel:thread-1",
      chatType: "channel",
      from: "discord:channel:thread-1",
      peer: { kind: "channel", id: "thread-1" },
      recipientSessionExact: false,
      sessionKey: "agent:main:discord:channel:thread-1",
      threadId: "thread-1",
      to: "channel:thread-1",
    });
  });

  it("uses numeric thread channel ids as exact inbound sessions", () => {
    const route = resolveDiscordOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "channel:123",
      threadId: "456",
    });

    expect(route).toMatchObject({
      baseSessionKey: "agent:main:discord:channel:456",
      peer: { kind: "channel", id: "456" },
      recipientSessionExact: true,
      sessionKey: "agent:main:discord:channel:456",
      to: "channel:456",
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
      recipientSessionExact: true,
      sessionKey: "agent:main:discord:channel:123",
      to: "channel:123",
    });
    expect(route?.threadId).toBeUndefined();
  });

  it("treats bare numeric outbound targets as channel routes", () => {
    const route = resolveDiscordOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "123",
    });

    expect(route).toMatchObject({
      baseSessionKey: "agent:main:discord:channel:123",
      chatType: "channel",
      from: "discord:channel:123",
      peer: { kind: "channel", id: "123" },
      sessionKey: "agent:main:discord:channel:123",
      to: "channel:123",
    });
  });

  it("does not claim channel names as canonical recipient sessions", () => {
    const route = resolveDiscordOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "channel:general",
    });

    expect(route?.recipientSessionExact).toBe(false);
  });
});
