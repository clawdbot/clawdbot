import { describe, expect, it } from "vitest";

import type { MoltbotConfig } from "../../config/config.js";
import { resolveOutboundSessionRoute } from "./outbound-session.js";

const baseConfig = {} as MoltbotConfig;

describe("resolveOutboundSessionRoute", () => {
  it("builds Slack thread session keys", async () => {
    const route = await resolveOutboundSessionRoute({
      cfg: baseConfig,
      channel: "slack",
      agentId: "main",
      target: "channel:C123",
      replyToId: "456",
    });

    expect(route?.sessionKey).toBe("agent:main:slack:channel:c123:thread:456");
    expect(route?.from).toBe("slack:channel:C123");
    expect(route?.to).toBe("channel:C123");
    expect(route?.threadId).toBe("456");
  });

  it("uses Telegram topic ids in group session keys", async () => {
    const route = await resolveOutboundSessionRoute({
      cfg: baseConfig,
      channel: "telegram",
      agentId: "main",
      target: "-100123456:topic:42",
    });

    expect(route?.sessionKey).toBe("agent:main:telegram:group:-100123456:topic:42");
    expect(route?.from).toBe("telegram:group:-100123456:topic:42");
    expect(route?.to).toBe("telegram:-100123456");
    expect(route?.threadId).toBe(42);
  });

  it("treats Telegram usernames as DMs when unresolved", async () => {
    const cfg = { session: { dmScope: "per-channel-peer" } } as MoltbotConfig;
    const route = await resolveOutboundSessionRoute({
      cfg,
      channel: "telegram",
      agentId: "main",
      target: "@alice",
    });

    expect(route?.sessionKey).toBe("agent:main:telegram:dm:@alice");
    expect(route?.chatType).toBe("direct");
  });

  it("honors dmScope identity links", async () => {
    const cfg = {
      session: {
        dmScope: "per-peer",
        identityLinks: {
          alice: ["discord:123"],
        },
      },
    } as MoltbotConfig;

    const route = await resolveOutboundSessionRoute({
      cfg,
      channel: "discord",
      agentId: "main",
      target: "user:123",
    });

    expect(route?.sessionKey).toBe("agent:main:dm:alice");
  });

  it("strips chat_* prefixes for BlueBubbles group session keys", async () => {
    const route = await resolveOutboundSessionRoute({
      cfg: baseConfig,
      channel: "bluebubbles",
      agentId: "main",
      target: "chat_guid:ABC123",
    });

    expect(route?.sessionKey).toBe("agent:main:bluebubbles:group:abc123");
    expect(route?.from).toBe("group:ABC123");
  });

  it("treats Zalo Personal DM targets as direct sessions", async () => {
    const cfg = { session: { dmScope: "per-channel-peer" } } as MoltbotConfig;
    const route = await resolveOutboundSessionRoute({
      cfg,
      channel: "zalouser",
      agentId: "main",
      target: "123456",
    });

    expect(route?.sessionKey).toBe("agent:main:zalouser:dm:123456");
    expect(route?.chatType).toBe("direct");
  });

  it("uses group session keys for Slack mpim allowlist entries", async () => {
    const cfg = {
      channels: {
        slack: {
          dm: {
            groupChannels: ["G123"],
          },
        },
      },
    } as MoltbotConfig;

    const route = await resolveOutboundSessionRoute({
      cfg,
      channel: "slack",
      agentId: "main",
      target: "channel:G123",
    });

    expect(route?.sessionKey).toBe("agent:main:slack:group:g123");
    expect(route?.from).toBe("slack:group:G123");
  });
});
