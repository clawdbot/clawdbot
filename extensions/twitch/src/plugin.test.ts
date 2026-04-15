import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { twitchPlugin } from "./plugin.js";

describe("twitchPlugin pairing", () => {
  it("normalizes trimmed twitch user prefixes in allow entries", () => {
    expect(twitchPlugin.pairing?.normalizeAllowEntry?.("  twitch:user:123456  ")).toBe("123456");
    expect(twitchPlugin.pairing?.normalizeAllowEntry?.("  user789012  ")).toBe("789012");
  });
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
