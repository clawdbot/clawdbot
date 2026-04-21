import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { collectChannelSecurityFindings } from "./audit-channel.js";

function stubDiscordPlugin(params: {
  resolveAccount: (cfg: OpenClawConfig, accountId: string | null | undefined) => unknown;
  inspectAccount?: (cfg: OpenClawConfig, accountId: string | null | undefined) => unknown;
  isConfigured?: (account: unknown, cfg: OpenClawConfig) => boolean;
}): ChannelPlugin {
  return {
    id: "discord",
    meta: {
      id: "discord",
      label: "Discord",
      selectionLabel: "Discord",
      docsPath: "/docs/testing",
      blurb: "test stub",
    },
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    commands: {
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: true,
    },
    security: {
      collectAuditFindings: ({ account }) => {
        const config = (account as { config?: { guilds?: unknown } }).config ?? {};
        const guilds =
          config.guilds && typeof config.guilds === "object" && !Array.isArray(config.guilds)
            ? config.guilds
            : {};
        if (Object.keys(guilds).length === 0) {
          return [];
        }
        return [
          {
            checkId: "channels.discord.commands.native.no_allowlists",
            severity: "warn" as const,
            title: "Discord slash commands have no allowlists",
            detail: "test stub",
          },
        ];
      },
    },
    config: {
      listAccountIds: () => ["default"],
      inspectAccount:
        params.inspectAccount ??
        ((cfg, accountId) => {
          const resolvedAccountId =
            typeof accountId === "string" && accountId ? accountId : "default";
          const account = params.resolveAccount(cfg, resolvedAccountId) as
            | { config?: Record<string, unknown> }
            | undefined;
          return {
            accountId: resolvedAccountId,
            enabled: true,
            configured: true,
            config: account?.config ?? {},
          };
        }),
      resolveAccount: (cfg, accountId) => params.resolveAccount(cfg, accountId),
      isEnabled: () => true,
      isConfigured: (account, cfg) => params.isConfigured?.(account, cfg) ?? true,
    },
  };
}

describe("security audit channel source-config fallback discord", () => {
  it("keeps source-configured channel security findings when resolved inspection is incomplete", async () => {
    const sourceConfig: OpenClawConfig = {
      commands: { native: true },
      channels: {
        discord: {
          enabled: true,
          token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
          groupPolicy: "allowlist",
          guilds: {
            "123": {
              channels: {
                general: { enabled: true },
              },
            },
          },
        },
      },
    };
    const resolvedConfig: OpenClawConfig = {
      commands: { native: true },
      channels: {
        discord: {
          enabled: true,
          groupPolicy: "allowlist",
          guilds: {
            "123": {
              channels: {
                general: { enabled: true },
              },
            },
          },
        },
      },
    };

    const findings = await collectChannelSecurityFindings({
      cfg: resolvedConfig,
      sourceConfig,
      plugins: [
        stubDiscordPlugin({
          inspectAccount: (cfg) => {
            const channel = cfg.channels?.discord ?? {};
            const token = channel.token;
            return {
              accountId: "default",
              enabled: true,
              configured:
                Boolean(token) &&
                typeof token === "object" &&
                !Array.isArray(token) &&
                "source" in token,
              token: "",
              tokenSource:
                Boolean(token) &&
                typeof token === "object" &&
                !Array.isArray(token) &&
                "source" in token
                  ? "config"
                  : "none",
              tokenStatus:
                Boolean(token) &&
                typeof token === "object" &&
                !Array.isArray(token) &&
                "source" in token
                  ? "configured_unavailable"
                  : "missing",
              config: channel,
            };
          },
          resolveAccount: (cfg) => ({ config: cfg.channels?.discord ?? {} }),
          isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
        }),
      ],
    });

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "channels.discord.commands.native.no_allowlists",
          severity: "warn",
        }),
      ]),
    );
  });
});
