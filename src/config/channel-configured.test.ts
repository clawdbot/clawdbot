// Covers channel-configured checks from bootstrap and plugin metadata.
import { describe, expect, it, vi } from "vitest";
import { getChannelEnvVars } from "../secrets/channel-env-vars.js";
import { isChannelConfigured } from "./channel-configured.js";

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

  it("requires both Mattermost URL and token env vars through the package metadata seam", () => {
    expect(isChannelConfigured({}, "mattermost", { MATTERMOST_BOT_TOKEN: "token" })).toBe(false);
    expect(
      isChannelConfigured({}, "mattermost", {
        MATTERMOST_URL: "https://mattermost.example.test",
      }),
    ).toBe(false);
    expect(
      isChannelConfigured({}, "mattermost", {
        MATTERMOST_BOT_TOKEN: "token",
        MATTERMOST_URL: "https://mattermost.example.test",
      }),
    ).toBe(true);
  });

  it("requires both Synology Chat token and incoming URL env vars through the package metadata seam", () => {
    // The remaining Synology env vars are display or tuning knobs with defaults
    // (nasHost -> "localhost", botName -> "OpenClaw"), so none of them proves an
    // account exists. They stay declared as alternatives only so env-var
    // discovery keeps knowing their names.
    expect(isChannelConfigured({}, "synology-chat", { SYNOLOGY_NAS_HOST: "nas.example.com" })).toBe(
      false,
    );
    expect(isChannelConfigured({}, "synology-chat", { OPENCLAW_BOT_NAME: "MyBot" })).toBe(false);
    expect(isChannelConfigured({}, "synology-chat", { SYNOLOGY_RATE_LIMIT: "30" })).toBe(false);
    expect(isChannelConfigured({}, "synology-chat", { SYNOLOGY_ALLOWED_USER_IDS: "1,2" })).toBe(
      false,
    );
    expect(isChannelConfigured({}, "synology-chat", { SYNOLOGY_CHAT_TOKEN: "token" })).toBe(false);
    expect(
      isChannelConfigured({}, "synology-chat", {
        SYNOLOGY_CHAT_INCOMING_URL: "https://nas.example.com/webapi/incoming",
      }),
    ).toBe(false);
    expect(
      isChannelConfigured({}, "synology-chat", {
        SYNOLOGY_CHAT_TOKEN: "token",
        SYNOLOGY_CHAT_INCOMING_URL: "https://nas.example.com/webapi/incoming",
      }),
    ).toBe(true);
  });

  it("keeps every Synology Chat env var discoverable after narrowing the probe", () => {
    // Env-var discovery reads the union of allOf and anyOf, and it feeds the
    // shell-env expected keys plus the workspace dotenv blocklist. Narrowing the
    // configured-state probe must not shrink that surface.
    expect(getChannelEnvVars("synology-chat")).toEqual([
      "SYNOLOGY_CHAT_TOKEN",
      "SYNOLOGY_CHAT_INCOMING_URL",
      "SYNOLOGY_NAS_HOST",
      "SYNOLOGY_ALLOWED_USER_IDS",
      "SYNOLOGY_RATE_LIMIT",
      "OPENCLAW_BOT_NAME",
    ]);
  });

  it("still falls back to generic config presence for channels without a custom hook", () => {
    expect(
      isChannelConfigured(
        {
          channels: {
            signal: {
              transport: { kind: "managed-native", httpPort: 8080 },
            },
          },
        },
        "signal",
        {},
      ),
    ).toBe(true);
  });

  it("treats explicit enabled channel config as configured state", () => {
    expect(
      isChannelConfigured(
        {
          channels: {
            "openclaw-weixin": {
              enabled: true,
            },
          },
        },
        "openclaw-weixin",
        {},
      ),
    ).toBe(true);
  });

  it("does not treat disabled channel config as configured state", () => {
    expect(
      isChannelConfigured(
        {
          channels: {
            "openclaw-weixin": {
              enabled: false,
            },
          },
        },
        "openclaw-weixin",
        {},
      ),
    ).toBe(false);
  });

  it("does not treat persisted Matrix credentials as configured channel state", () => {
    expect(
      isChannelConfigured({}, "matrix", { OPENCLAW_STATE_DIR: "state-with-matrix-creds" }),
    ).toBe(false);
  });
});
