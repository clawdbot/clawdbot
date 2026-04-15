import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { describe, expect, it } from "vitest";
import { collectDiscordStatusIssues } from "./status-issues.js";

describe("collectDiscordStatusIssues", () => {
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

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel: "discord",
          accountId: "ops",
          kind: "intent",
        }),
        expect.objectContaining({
          channel: "discord",
          accountId: "ops",
          kind: "config",
        }),
      ]),
    );
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

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      channel: "discord",
      accountId: "ops",
      kind: "permissions",
    });
    expect(issues[0]?.message).toContain("Channel 123 permission check failed");
    expect(issues[0]?.message).toContain("alerts");
    expect(issues[0]?.message).toContain("guilds.ops.channels");
  });
});
