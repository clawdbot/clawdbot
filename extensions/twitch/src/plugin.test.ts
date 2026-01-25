import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import { twitchPlugin } from "./plugin.js";

describe("twitchPlugin.status.buildAccountSnapshot", () => {
  it("uses the resolved account ID for multi-account configs", () => {
    const secondary = {
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
              username: "default",
              accessToken: "oauth:default-token",
              clientId: "default-client",
              enabled: true,
            },
            secondary,
          },
        },
      },
    } as ClawdbotConfig;

    const snapshot = twitchPlugin.status.buildAccountSnapshot({
      account: secondary,
      cfg,
    });

    expect(snapshot.accountId).toBe("secondary");
  });
});
