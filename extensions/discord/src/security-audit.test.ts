import { describe, expect, it, vi } from "vitest";
import type { ResolvedDiscordAccount } from "./accounts.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { collectDiscordSecurityAuditFindings } from "./security-audit.js";

type DiscordAccountConfig = ResolvedDiscordAccount["config"];

const { readChannelAllowFromStoreMock } = vi.hoisted(() => ({
  readChannelAllowFromStoreMock: vi.fn(async () => [] as string[]),
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", () => ({
  readChannelAllowFromStore: readChannelAllowFromStoreMock,
}));

function createAccount(
  config: DiscordAccountConfig,
  accountId = "default",
): ResolvedDiscordAccount {
  return {
    accountId,
    enabled: true,
    token: "t",
    tokenSource: "config",
    tokenStatus: "available",
    config,
  };
}

async function collectFindings(params: {
  cfg: OpenClawConfig;
  config: DiscordAccountConfig;
  accountId?: string;
  orderedAccountIds?: string[];
  hasExplicitAccountPath?: boolean;
  storeAllowFrom?: string[];
}) {
  readChannelAllowFromStoreMock.mockResolvedValue(params.storeAllowFrom ?? []);
  return await collectDiscordSecurityAuditFindings({
    cfg: params.cfg,
    account: createAccount(params.config, params.accountId),
    accountId: params.accountId ?? "default",
    orderedAccountIds: params.orderedAccountIds ?? ["default"],
    hasExplicitAccountPath: params.hasExplicitAccountPath ?? false,
  });
}

describe("Discord security audit findings", () => {
  it("flags slash commands when access-group enforcement is disabled and no users allowlist exists", async () => {
    const cfg: OpenClawConfig = {
      commands: { native: true, useAccessGroups: false },
      channels: {
        discord: {
          enabled: true,
          token: "t",
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

    const discordConfig = cfg.channels?.discord;
    if (!discordConfig) {
      throw new Error("discord config required");
    }
    const findings = await collectFindings({
      cfg,
      config: discordConfig,
    });

    const unrestrictedFinding = findings.find(
      (finding) => finding.checkId === "channels.discord.commands.native.unrestricted",
    );
    expect(unrestrictedFinding?.severity).toBe("critical");
  });

  it.each([
    {
      name: "flags missing guild user allowlists",
      cfg: {
        commands: { native: true },
        channels: {
          discord: {
            enabled: true,
            token: "t",
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
      } satisfies OpenClawConfig,
      expectFinding: true,
    },
    {
      name: "does not flag when dm.allowFrom includes a Discord snowflake id",
      cfg: {
        commands: { native: true },
        channels: {
          discord: {
            enabled: true,
            token: "t",
            dm: { allowFrom: ["387380367612706819"] },
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
      } satisfies OpenClawConfig,
      expectFinding: false,
    },
  ])("$name", async (testCase) => {
    const findings = await collectFindings({
      cfg: testCase.cfg,
      config: testCase.cfg.channels.discord,
    });

    expect(
      findings.some(
        (finding) => finding.checkId === "channels.discord.commands.native.no_allowlists",
      ),
    ).toBe(testCase.expectFinding);
  });

  it.each([
    {
      name: "warns when Discord allowlists contain name-based entries",
      config: {
        enabled: true,
        token: "t",
        allowFrom: ["Alice#1234", "<@123456789012345678>"],
        guilds: {
          "123": {
            users: ["trusted.operator"],
            channels: {
              general: {
                users: ["987654321098765432", "security-team"],
              },
            },
          },
        },
      } satisfies DiscordAccountConfig,
      storeAllowFrom: ["team.owner"],
      expectNameBasedSeverity: "warn",
      detailIncludes: [
        "channels.discord.allowFrom:Alice#1234",
        "channels.discord.guilds.123.users:trusted.operator",
        "channels.discord.guilds.123.channels.general.users:security-team",
        "~/.openclaw/credentials/discord-allowFrom.json:team.owner",
      ],
      detailExcludes: ["<@123456789012345678>"],
    },
    {
      name: "marks Discord name-based allowlists as break-glass when dangerous matching is enabled",
      config: {
        enabled: true,
        token: "t",
        dangerouslyAllowNameMatching: true,
        allowFrom: ["Alice#1234"],
      } satisfies DiscordAccountConfig,
      expectNameBasedSeverity: "info",
      detailIncludes: ["out-of-scope"],
    },
    {
      name: "audits name-based allowlists on non-default Discord accounts",
      accountId: "beta",
      orderedAccountIds: ["alpha", "beta"],
      hasExplicitAccountPath: true,
      config: {
        enabled: true,
        token: "b",
        allowFrom: ["Alice#1234"],
      } satisfies DiscordAccountConfig,
      expectNameBasedSeverity: "warn",
      detailIncludes: ["channels.discord.accounts.beta.allowFrom:Alice#1234"],
    },
    {
      name: "does not warn when Discord allowlists use ID-style entries only",
      config: {
        enabled: true,
        token: "t",
        allowFrom: [
          "123456789012345678",
          "<@223456789012345678>",
          "user:323456789012345678",
          "discord:423456789012345678",
          "pk:member-123",
        ],
        guilds: {
          "123": {
            users: ["523456789012345678", "<@623456789012345678>", "pk:member-456"],
            channels: {
              general: {
                users: ["723456789012345678", "user:823456789012345678"],
              },
            },
          },
        },
      } satisfies DiscordAccountConfig,
      expectNoNameBasedFinding: true,
    },
  ])("$name", async (testCase) => {
    const findings = await collectFindings({
      cfg: { channels: { discord: testCase.config } },
      config: testCase.config,
      accountId: testCase.accountId,
      orderedAccountIds: testCase.orderedAccountIds,
      hasExplicitAccountPath: testCase.hasExplicitAccountPath,
      storeAllowFrom: testCase.storeAllowFrom,
    });
    const nameBasedFinding = findings.find(
      (entry) => entry.checkId === "channels.discord.allowFrom.name_based_entries",
    );

    if (testCase.expectNoNameBasedFinding) {
      expect(nameBasedFinding).toBeUndefined();
    } else {
      if (!nameBasedFinding) {
        throw new Error(`expected name-based finding for ${testCase.name}`);
      }
      expect(nameBasedFinding.severity).toBe(testCase.expectNameBasedSeverity);
      for (const snippet of testCase.detailIncludes ?? []) {
        expect(nameBasedFinding.detail).toContain(snippet);
      }
      for (const snippet of testCase.detailExcludes ?? []) {
        expect(nameBasedFinding.detail).not.toContain(snippet);
      }
    }
  });
});
