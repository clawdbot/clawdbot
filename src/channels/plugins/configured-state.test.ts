// Configured state tests cover channel plugin configured-state detection and summaries.
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  hasBundledChannelPackageState,
  listBundledChannelIdsForPackageState,
} from "./package-state-probes.js";

const nodeRequire = createRequire(import.meta.url);

describe("bundled channel configured-state metadata", () => {
  it("lists the shipped metadata-first configured-state channels", () => {
    expect(listBundledChannelIdsForPackageState("configuredState")).toEqual([
      "buzz",
      "clickclack",
      "discord",
      "feishu",
      "googlechat",
      "irc",
      "line",
      "matrix",
      "mattermost",
      "msteams",
      "nextcloud-talk",
      "nostr",
      "raft",
      "slack",
      "sms",
      "synology-chat",
      "telegram",
      "twitch",
      "zalo",
      "zalouser",
    ]);
  });

  it("resolves Discord, Slack, Telegram, and IRC env probes without full plugin loads", () => {
    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "discord",
        cfg: {},
        env: { DISCORD_BOT_TOKEN: "token" },
      }),
    ).toBe(true);
    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "slack",
        cfg: {},
        env: { SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-test" },
      }),
    ).toBe(true);
    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "telegram",
        cfg: {},
        env: { TELEGRAM_BOT_TOKEN: "token" },
      }),
    ).toBe(true);
    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "irc",
        cfg: {},
        env: { IRC_HOST: "irc.example.com", IRC_NICK: "openclaw" },
      }),
    ).toBe(true);
  });

  it.each([
    { channelId: "slack", env: { SLACK_BOT_TOKEN: "xoxb-test" } },
    { channelId: "slack", env: { SLACK_APP_TOKEN: "xapp-test" } },
    { channelId: "msteams", env: { MSTEAMS_APP_ID: "app" } },
    { channelId: "msteams", env: { MSTEAMS_APP_ID: "app", MSTEAMS_TENANT_ID: "tenant" } },
    { channelId: "sms", env: { TWILIO_ACCOUNT_SID: "account" } },
    { channelId: "sms", env: { TWILIO_ACCOUNT_SID: "account", TWILIO_AUTH_TOKEN: "token" } },
    { channelId: "line", env: { LINE_CHANNEL_ACCESS_TOKEN: "token" } },
    { channelId: "synology-chat", env: { SYNOLOGY_CHAT_TOKEN: "token" } },
    { channelId: "feishu", env: { FEISHU_APP_ID: "app", FEISHU_APP_SECRET: "secret" } },
    { channelId: "nextcloud-talk", env: { NEXTCLOUD_TALK_BOT_SECRET: "secret" } },
    { channelId: "zalo", env: { ZALO_WEBHOOK_SECRET: "secret" } },
  ])("rejects incomplete $channelId environment credentials", ({ channelId, env }) => {
    expect(
      hasBundledChannelPackageState({ metadataKey: "configuredState", channelId, cfg: {}, env }),
    ).toBe(false);
  });

  it.each([
    {
      channelId: "msteams",
      env: {
        MSTEAMS_APP_ID: "app",
        MSTEAMS_APP_PASSWORD: "password",
        MSTEAMS_TENANT_ID: "tenant",
      },
    },
    {
      channelId: "sms",
      env: {
        TWILIO_ACCOUNT_SID: "account",
        TWILIO_AUTH_TOKEN: "token",
        TWILIO_MESSAGING_SERVICE_SID: "service",
      },
    },
    {
      channelId: "line",
      env: { LINE_CHANNEL_ACCESS_TOKEN: "token", LINE_CHANNEL_SECRET: "secret" },
    },
    { channelId: "zalo", env: { ZALO_BOT_TOKEN: "token" } },
    {
      channelId: "synology-chat",
      env: { SYNOLOGY_CHAT_TOKEN: "token", SYNOLOGY_CHAT_INCOMING_URL: "https://example.test" },
    },
  ])("accepts complete $channelId environment credentials", ({ channelId, env }) => {
    expect(
      hasBundledChannelPackageState({ metadataKey: "configuredState", channelId, cfg: {}, env }),
    ).toBe(true);
  });

  it("keeps explicit blank Teams credentials authoritative over ambient credentials", () => {
    expect(
      hasBundledChannelPackageState({
        metadataKey: "configuredState",
        channelId: "msteams",
        cfg: { channels: { msteams: { appId: "", appPassword: "", tenantId: "" } } },
        env: {
          MSTEAMS_APP_ID: "ambient-app",
          MSTEAMS_APP_PASSWORD: "ambient-password",
          MSTEAMS_TENANT_ID: "ambient-tenant",
        },
      }),
    ).toBe(false);
  });

  it.each([
    {
      name: "Slack HTTP credentials",
      channelId: "slack",
      cfg: { channels: { slack: { mode: "http", signingSecret: "signed" } } },
      env: { SLACK_BOT_TOKEN: "xoxb-test" },
    },
    {
      name: "Slack user identity",
      channelId: "slack",
      cfg: { channels: { slack: { postAs: "user" } } },
      env: { SLACK_USER_TOKEN: "xoxp-test", SLACK_APP_TOKEN: "xapp-test" },
    },
    {
      name: "Teams managed identity",
      channelId: "msteams",
      cfg: {},
      env: {
        MSTEAMS_APP_ID: "app",
        MSTEAMS_TENANT_ID: "tenant",
        MSTEAMS_AUTH_TYPE: "federated",
        MSTEAMS_USE_MANAGED_IDENTITY: "true",
      },
    },
    {
      name: "configured Feishu account",
      channelId: "feishu",
      cfg: { channels: { feishu: { appId: "app", appSecret: "secret" } } },
      env: {},
    },
    {
      name: "configured Nextcloud account",
      channelId: "nextcloud-talk",
      cfg: { channels: { "nextcloud-talk": { baseUrl: "https://cloud.example.test" } } },
      env: { NEXTCLOUD_TALK_BOT_SECRET: "secret" },
    },
  ] satisfies Array<{
    name: string;
    channelId: string;
    cfg: OpenClawConfig;
    env: NodeJS.ProcessEnv;
  }>)("accepts the owner-specific $name contract", ({ channelId, cfg, env }) => {
    expect(
      hasBundledChannelPackageState({ metadataKey: "configuredState", channelId, cfg, env }),
    ).toBe(true);
  });

  it("uses declarative env metadata without a TypeScript source require hook", () => {
    const previousTsHook = nodeRequire.extensions[".ts"];
    delete nodeRequire.extensions[".ts"];
    try {
      expect(
        hasBundledChannelPackageState({
          metadataKey: "configuredState",
          channelId: "discord",
          cfg: {},
          env: { DISCORD_BOT_TOKEN: "token" },
        }),
      ).toBe(true);
    } finally {
      if (previousTsHook) {
        nodeRequire.extensions[".ts"] = previousTsHook;
      }
    }
  });
});
