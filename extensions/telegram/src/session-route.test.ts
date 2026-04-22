import { describe, expect, it } from "vitest";
import { telegramPlugin } from "./channel.js";

describe("telegram session route", () => {
  it("keeps direct topic thread ids in a thread session suffix", async () => {
    const route = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "12345:topic:99",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:main:thread:99",
      baseSessionKey: "agent:main:main",
      threadId: 99,
    });
  });

  it("recovers direct topic thread routes from currentSessionKey when the DM scope is isolated", async () => {
    const route = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: { session: { dmScope: "per-channel-peer" } },
      agentId: "main",
      target: "12345",
      currentSessionKey: "agent:main:telegram:direct:12345:thread:12345:99",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:telegram:direct:12345:thread:12345:99",
      baseSessionKey: "agent:main:telegram:direct:12345",
      threadId: "12345:99",
    });
  });

  it('does not recover currentSessionKey threads for shared dmScope "main" DMs', async () => {
    const route = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "12345",
      currentSessionKey: "agent:main:main:thread:12345:99",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
    });
    expect(route?.threadId).toBeUndefined();
  });

  it("keeps group topic ids in the group peer route instead of adding a thread suffix", async () => {
    const route = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "-100:topic:99",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:telegram:group:-100:topic:99",
      baseSessionKey: "agent:main:telegram:group:-100:topic:99",
      threadId: 99,
    });
  });
});
