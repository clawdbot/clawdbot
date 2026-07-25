// Twitch tests cover plugin plugin behavior.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { twitchPlugin } from "./plugin.js";

describe("twitchPlugin pairing", () => {
  it("normalizes trimmed twitch user prefixes in allow entries", () => {
    expect(twitchPlugin.pairing?.normalizeAllowEntry?.("  twitch:user:123456  ")).toBe("123456");
    expect(twitchPlugin.pairing?.normalizeAllowEntry?.("  user789012  ")).toBe("789012");
  });
});

describe("twitchPlugin outbound session routing", () => {
  it("reproduces the canonical inbound channel session", async () => {
    const route = await twitchPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "ops",
      accountId: "stream",
      target: "twitch:channel:OpenClaw",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:ops:twitch:group:openclaw",
      baseSessionKey: "agent:ops:twitch:group:openclaw",
      recipientSessionExact: true,
      peer: { kind: "group", id: "openclaw" },
      chatType: "group",
      to: "openclaw",
    });
  });

  it.each(["twitch:user:alice", "twitch:dm:alice"])(
    "rejects unsupported direct target %s",
    async (target) => {
      const route = await twitchPlugin.messaging?.resolveOutboundSessionRoute?.({
        cfg: {},
        agentId: "ops",
        target,
      });

      expect(route).toBeNull();
    },
  );
});

describe("twitchPlugin.status.buildAccountSnapshot", () => {
  it("uses the resolved account ID for multi-account configs", async () => {
    const secondary = {
      channel: "secondary-channel",
      username: "secondary",
      accessToken: "oauth:secondary-token",
      clientId: "secondary-client",
      enabled: true,
    };

    const cfg = {
      channels: {
        twitch: {
          accounts: {
            default: {
              channel: "default-channel",
              username: "default",
              accessToken: "oauth:default-token",
              clientId: "default-client",
              enabled: true,
            },
            secondary,
          },
        },
      },
    } as OpenClawConfig;

    const snapshot = await twitchPlugin.status?.buildAccountSnapshot?.({
      account: secondary,
      cfg,
    });

    expect(snapshot?.accountId).toBe("secondary");
  });
});

describe("twitchPlugin.config", () => {
  it("uses configured defaultAccount for omitted-account plugin resolution", () => {
    const cfg = {
      channels: {
        twitch: {
          defaultAccount: "secondary",
          accounts: {
            default: {
              channel: "default-channel",
              username: "default",
              accessToken: "oauth:default-token",
              clientId: "default-client",
              enabled: true,
            },
            secondary: {
              channel: "secondary-channel",
              username: "secondary",
              accessToken: "oauth:secondary-token",
              clientId: "secondary-client",
              enabled: true,
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(twitchPlugin.config.defaultAccountId?.(cfg)).toBe("secondary");
    expect(twitchPlugin.config.resolveAccount(cfg).accountId).toBe("secondary");
  });
});
