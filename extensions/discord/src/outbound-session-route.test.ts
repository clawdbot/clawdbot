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

    expect(route).toMatchObject({
      sessionKey: "agent:main:discord:channel:123",
      baseSessionKey: "agent:main:discord:channel:123",
      threadId: "thread-1",
    });
  });

  it("does not promote replyToId into Discord delivery thread metadata", () => {
    const route = resolveDiscordOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "channel:123",
      replyToId: "message-1",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:discord:channel:123",
      baseSessionKey: "agent:main:discord:channel:123",
    });
    expect(route?.threadId).toBeUndefined();
  });
});
