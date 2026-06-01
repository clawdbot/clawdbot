import { describe, expect, it } from "vitest";
import { telegramPlugin } from "./channel.js";

describe("telegram session route", () => {
  it("scopes direct topic session suffixes by chat id", async () => {
    const route = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "12345:topic:99",
    });

    expect(route?.sessionKey).toBe("agent:main:main:thread:12345:99");
    expect(route?.baseSessionKey).toBe("agent:main:main");
    expect(route?.threadId).toBe(99);
  });

  it("keeps same direct topic ids distinct across chats", async () => {
    const first = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "12345:topic:99",
    });
    const second = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "67890:topic:99",
    });

    expect(first?.sessionKey).toBe("agent:main:main:thread:12345:99");
    expect(second?.sessionKey).toBe("agent:main:main:thread:67890:99");
    expect(first?.threadId).toBe(99);
    expect(second?.threadId).toBe(99);
  });

  it("returns native topic ids for username direct topic targets", async () => {
    const route = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "@alice:topic:99",
    });

    expect(route?.sessionKey).toBe("agent:main:main:thread:@alice:99");
    expect(route?.baseSessionKey).toBe("agent:main:main");
    expect(route?.threadId).toBe(99);
    expect(route?.from).toBe("telegram:@alice:topic:99");
  });

  it("aligns isolated direct topic sessions with inbound reply routing", async () => {
    const route = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: { session: { dmScope: "per-account-channel-peer" } },
      agentId: "finance",
      accountId: "finance",
      target: "104506878:topic:174872",
    });

    expect(route?.sessionKey).toBe(
      "agent:finance:telegram:finance:direct:104506878:thread:104506878:174872",
    );
    expect(route?.baseSessionKey).toBe("agent:finance:telegram:finance:direct:104506878");
    expect(route?.threadId).toBe(174872);
    expect(route?.from).toBe("telegram:104506878:topic:174872");
  });

  it("recovers direct topic thread routes from currentSessionKey when the DM scope is isolated", async () => {
    const route = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: { session: { dmScope: "per-channel-peer" } },
      agentId: "main",
      target: "12345",
      currentSessionKey: "agent:main:telegram:direct:12345:thread:12345:99",
    });

    expect(route?.sessionKey).toBe("agent:main:telegram:direct:12345:thread:12345:99");
    expect(route?.baseSessionKey).toBe("agent:main:telegram:direct:12345");
    expect(route?.threadId).toBe(99);
    expect(route?.from).toBe("telegram:12345:topic:99");
  });

  it("recovers username direct topic thread routes from currentSessionKey", async () => {
    const route = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: { session: { dmScope: "per-channel-peer" } },
      agentId: "main",
      target: "@alice",
      currentSessionKey: "agent:main:telegram:direct:@alice:thread:@alice:99",
    });

    expect(route?.sessionKey).toBe("agent:main:telegram:direct:@alice:thread:@alice:99");
    expect(route?.baseSessionKey).toBe("agent:main:telegram:direct:@alice");
    expect(route?.threadId).toBe(99);
    expect(route?.from).toBe("telegram:@alice:topic:99");
  });

  it('does not recover currentSessionKey threads for shared dmScope "main" DMs', async () => {
    const route = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "12345",
      currentSessionKey: "agent:main:main:thread:12345:99",
    });

    expect(route?.sessionKey).toBe("agent:main:main");
    expect(route?.baseSessionKey).toBe("agent:main:main");
    expect(route?.threadId).toBeUndefined();
  });

  it("keeps group topic ids in the group peer route instead of adding a thread suffix", async () => {
    const route = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "-100:topic:99",
    });

    expect(route?.sessionKey).toBe("agent:main:telegram:group:-100:topic:99");
    expect(route?.baseSessionKey).toBe("agent:main:telegram:group:-100:topic:99");
    expect(route?.threadId).toBe(99);
  });
});
