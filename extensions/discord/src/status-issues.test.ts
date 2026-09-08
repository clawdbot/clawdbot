// Discord tests cover status issues plugin behavior.
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { describe, expect, it } from "vitest";
import { collectDiscordStatusIssues } from "./status-issues.js";

describe("collectDiscordStatusIssues", () => {
  it("reports an empty guild allowlist with the resolved account config path", () => {
    const issues = collectDiscordStatusIssues([
      {
        accountId: "ops",
        enabled: true,
        configured: true,
        groupPolicy: "allowlist",
        guildsConfigured: 0,
      } as ChannelAccountSnapshot,
    ]);

    expect(issues).toEqual([
      {
        channel: "discord",
        accountId: "ops",
        kind: "config",
        message:
          'Discord guild messages are blocked: effective groupPolicy is "allowlist", but no guilds are configured.',
        fix: "Add your server under channels.discord.accounts.ops.guilds. Refresh channel status after the configuration reload applies.",
      },
    ]);
  });

  it("explains the top-level and explicit default-account guild config paths", () => {
    const issues = collectDiscordStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: true,
        groupPolicy: "allowlist",
        guildsConfigured: 0,
      } as ChannelAccountSnapshot,
    ]);

    expect(issues[0]?.fix).toContain("channels.discord.guilds");
    expect(issues[0]?.fix).toContain(
      "If channels.discord.accounts.default.guilds is set, add it there instead.",
    );
    expect(issues[0]?.fix).toContain("after the configuration reload applies");
  });

  it("reports disabled message content intent and unresolved channel ids", () => {
    const issues = collectDiscordStatusIssues([
      {
        accountId: "ops",
        enabled: true,
        configured: true,
        application: {
          intents: {
            messageContent: "disabled",
          },
        },
        audit: {
          unresolvedChannels: 2,
        },
      } as ChannelAccountSnapshot,
    ]);

    expect(issues).toEqual([
      {
        channel: "discord",
        accountId: "ops",
        kind: "intent",
        message: "Message Content Intent is disabled. Bot may not see normal channel messages.",
        fix: "Enable Message Content Intent in Discord Dev Portal → Bot → Privileged Gateway Intents, or require mention-only operation.",
      },
      {
        channel: "discord",
        accountId: "ops",
        kind: "config",
        message:
          "Some configured guild channels are not numeric IDs (unresolvedChannels=2). Permission audit can only check numeric channel IDs.",
        fix: "Use numeric channel IDs as keys in channels.discord.guilds.*.channels (then rerun channels status --probe).",
      },
    ]);
  });

  it("reports channel permission failures with match metadata", () => {
    const issues = collectDiscordStatusIssues([
      {
        accountId: "ops",
        enabled: true,
        configured: true,
        audit: {
          channels: [
            {
              channelId: "123",
              ok: false,
              missing: ["ViewChannel", "SendMessages"],
              error: "403",
              matchKey: "alerts",
              matchSource: "guilds.ops.channels",
            },
          ],
        },
      } as ChannelAccountSnapshot,
    ]);

    expect(issues).toEqual([
      {
        channel: "discord",
        accountId: "ops",
        kind: "permissions",
        message:
          "Channel 123 permission check failed. missing ViewChannel, SendMessages: 403 (matchKey=alerts matchSource=guilds.ops.channels)",
        fix: "Ensure the bot role can view + send in this channel (and that channel overrides don't deny it).",
      },
    ]);
  });
});
