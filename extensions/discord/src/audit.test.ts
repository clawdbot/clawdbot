import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditDiscordChannelPermissionsWithFetcher,
  collectDiscordAuditChannelIdsForGuilds,
} from "./audit-core.js";

const fetchChannelPermissionsDiscordMock = vi.fn();

function readDiscordGuilds(cfg: OpenClawConfig) {
  const guilds = cfg.channels?.discord?.guilds;
  expect(guilds).toBeDefined();
  return guilds ?? {};
}

describe("discord audit", () => {
  beforeEach(() => {
    fetchChannelPermissionsDiscordMock.mockReset();
  });

  it("collects numeric channel ids even when config uses allow=false and counts unresolved keys", async () => {
    const cfg = {
      channels: {
        discord: {
          enabled: true,
          token: "t",
          groupPolicy: "allowlist",
          guilds: {
            "123": {
              channels: {
                "111": { allow: true },
                general: { allow: true },
                "222": { allow: false },
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const collected = collectDiscordAuditChannelIdsForGuilds(readDiscordGuilds(cfg));
    expect(collected.channelIds).toEqual(["111", "222"]);
    expect(collected.unresolvedChannels).toBe(1);

    fetchChannelPermissionsDiscordMock.mockResolvedValueOnce({
      channelId: "111",
      permissions: ["ViewChannel"],
      raw: "0",
      isDm: false,
    });
    fetchChannelPermissionsDiscordMock.mockResolvedValueOnce({
      channelId: "222",
      permissions: ["ViewChannel", "SendMessages"],
      raw: "0",
      isDm: false,
    });

    const audit = await auditDiscordChannelPermissionsWithFetcher({
      token: "t",
      accountId: "default",
      channelIds: collected.channelIds,
      timeoutMs: 1000,
      fetchChannelPermissions: fetchChannelPermissionsDiscordMock,
    });
    expect(audit.ok).toBe(false);
    expect(audit.channels).toHaveLength(2);
    expect(audit.channels[0]?.channelId).toBe("111");
    expect(audit.channels[0]?.missing).toContain("SendMessages");
  });

  it("does not count '*' wildcard key as unresolved channel", () => {
    const cfg = {
      channels: {
        discord: {
          enabled: true,
          token: "t",
          groupPolicy: "allowlist",
          guilds: {
            "123": {
              channels: {
                "111": { allow: true },
                "*": { allow: true },
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const collected = collectDiscordAuditChannelIdsForGuilds(readDiscordGuilds(cfg));
    expect(collected.channelIds).toEqual(["111"]);
    expect(collected.unresolvedChannels).toBe(0);
  });

  it("handles guild with only '*' wildcard and no numeric channel ids", () => {
    const cfg = {
      channels: {
        discord: {
          enabled: true,
          token: "t",
          groupPolicy: "allowlist",
          guilds: {
            "123": {
              channels: {
                "*": { allow: true },
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const collected = collectDiscordAuditChannelIdsForGuilds(readDiscordGuilds(cfg));
    expect(collected.channelIds).toEqual([]);
    expect(collected.unresolvedChannels).toBe(0);
  });

  it("collects audit channel ids without resolving SecretRef-backed Discord tokens", () => {
    const cfg = {
      channels: {
        discord: {
          enabled: true,
          token: {
            source: "env",
            provider: "default",
            id: "DISCORD_BOT_TOKEN",
          },
          guilds: {
            "123": {
              channels: {
                "111": { allow: true },
                general: { allow: true },
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const collected = collectDiscordAuditChannelIdsForGuilds(readDiscordGuilds(cfg));
    expect(collected.channelIds).toEqual(["111"]);
    expect(collected.unresolvedChannels).toBe(1);
  });
});
