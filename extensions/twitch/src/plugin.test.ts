import { describe, expect, it } from "vitest";
import type { MoltbotConfig } from "clawdbot/plugin-sdk";
import { twitchPlugin } from "./plugin.js";

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
    } as MoltbotConfig;

    const snapshot = await twitchPlugin.status?.buildAccountSnapshot?.({
      account: secondary,
      cfg,
    });

    expect(snapshot?.accountId).toBe("secondary");
  });
});
