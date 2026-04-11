import { describe, expect, it, vi } from "vitest";
import { isChannelConfigured } from "./channel-configured.js";

vi.mock("../channels/plugins/configured-state.js", () => ({
  hasBundledChannelConfiguredState: ({
    channelId,
    env,
  }: {
    channelId: string;
    env?: NodeJS.ProcessEnv;
  }) => {
    if (channelId === "telegram") {
      return Boolean(env?.TELEGRAM_BOT_TOKEN);
    }
    if (channelId === "discord") {
      return Boolean(env?.DISCORD_BOT_TOKEN);
    }
    if (channelId === "slack") {
      return Boolean(env?.SLACK_BOT_TOKEN);
    }
    if (channelId === "irc") {
      return Boolean(env?.IRC_HOST && env?.IRC_NICK);
    }
    return false;
  },
}));

vi.mock("../channels/plugins/persisted-auth-state.js", () => ({
  hasBundledChannelPersistedAuthState: ({
    channelId,
    env,
  }: {
    channelId: string;
    env?: NodeJS.ProcessEnv;
  }) => channelId === "matrix" && env?.OPENCLAW_STATE_DIR === "state-with-matrix-creds",
}));

vi.mock("../channels/plugins/bootstrap-registry.js", () => ({
  getBootstrapChannelPlugin: () => undefined,
}));

describe("isChannelConfigured", () => {
  it("detects Telegram env configuration through the package metadata seam", () => {
    expect(isChannelConfigured({}, "telegram", { TELEGRAM_BOT_TOKEN: "token" })).toBe(true);
  });

  it("detects Discord env configuration through the package metadata seam", () => {
    expect(isChannelConfigured({}, "discord", { DISCORD_BOT_TOKEN: "token" })).toBe(true);
  });

  it("detects Slack env configuration through the package metadata seam", () => {
    expect(isChannelConfigured({}, "slack", { SLACK_BOT_TOKEN: "xoxb-test" })).toBe(true);
  });

  it("requires both IRC host and nick env vars through the package metadata seam", () => {
    expect(isChannelConfigured({}, "irc", { IRC_HOST: "irc.example.com" })).toBe(false);
    expect(
      isChannelConfigured({}, "irc", {
        IRC_HOST: "irc.example.com",
        IRC_NICK: "openclaw",
      }),
    ).toBe(true);
  });

  it("still falls back to generic config presence for channels without a custom hook", () => {
    expect(
      isChannelConfigured(
        {
          channels: {
            signal: {
              httpPort: 8080,
            },
          },
        },
        "signal",
        {},
      ),
    ).toBe(true);
  });

  it("detects persisted Matrix credentials through package metadata", () => {
    expect(
      isChannelConfigured({}, "matrix", { OPENCLAW_STATE_DIR: "state-with-matrix-creds" }),
    ).toBe(true);
  });
});
