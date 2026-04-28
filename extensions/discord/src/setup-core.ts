import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { DiscordGuildEntry, OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { ChannelSetupDmPolicy, ChannelSetupWizard } from "openclaw/plugin-sdk/setup-runtime";
import { createStandardChannelSetupStatus } from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  inspectDiscordSetupAccount,
  resolveDiscordSetupAccountConfig,
} from "./setup-account-state.js";
import {
  createAccountScopedAllowFromSection,
  createAccountScopedGroupAccessSection,
  createAllowlistSetupWizardProxy,
  createLegacyCompatChannelDmPolicy,
  parseMentionOrPrefixedId,
  patchChannelConfigForAccount,
  setSetupChannelEnabled,
} from "./setup-runtime-helpers.js";

const channel = "discord" as const;

export const DISCORD_TOKEN_HELP_LINES = [
  "1) Discord Developer Portal -> Applications -> New Application",
  "2) Bot -> Add Bot -> Reset Token -> copy token",
  "3) OAuth2 -> URL Generator -> scope 'bot' -> invite to your server",
  "Tip: enable Message Content Intent if you need message text. (Bot -> Privileged Gateway Intents -> Message Content Intent)",
  `Docs: ${formatDocsLink("/discord", "discord")}`,
];

export function setDiscordGuildChannelAllowlist(
  cfg: OpenClawConfig,
  accountId: string,
  entries: Array<{
    guildKey: string;
    channelKey?: string;
  }>,
): OpenClawConfig {
  const baseGuilds =
    accountId === DEFAULT_ACCOUNT_ID
      ? (cfg.channels?.discord?.guilds ?? {})
      : (cfg.channels?.discord?.accounts?.[accountId]?.guilds ?? {});
  const guilds: Record<string, DiscordGuildEntry> = { ...baseGuilds };
  for (const entry of entries) {
    const guildKey = entry.guildKey || "*";
    const existing = guilds[guildKey] ?? {};
    if (entry.channelKey) {
      const channels = { ...existing.channels };
      channels[entry.channelKey] = { enabled: true };
      guilds[guildKey] = { ...existing, channels };
    } else {
      guilds[guildKey] = existing;
    }
  }
  return patchChannelConfigForAccount({
    cfg,
    channel,
    accountId,
    patch: { guilds },
  });
}

export function parseDiscordAllowFromId(value: string): string | null {
  return parseMentionOrPrefixedId({
    value,
    mentionPattern: /^<@!?(\d+)>$/,
    prefixPattern: /^(user:|discord:)/i,
    idPattern: /^\d+$/,
  });
}

export function createDiscordSetupWizardBase(handlers: {
  promptAllowFrom: NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>;
  resolveAllowFromEntries: NonNullable<
    NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]
  >;
  resolveGroupAllowlist: NonNullable<
    NonNullable<NonNullable<ChannelSetupWizard["groupAccess"]>["resolveAllowlist"]>
  >;
}) {
  const discordDmPolicy: ChannelSetupDmPolicy = createLegacyCompatChannelDmPolicy({
    label: "Discord",
    channel,
    promptAllowFrom: handlers.promptAllowFrom,
  });

  return {
    channel,
    status: createStandardChannelSetupStatus({
      channelLabel: "Discord",
      configuredLabel: "configured",
      unconfiguredLabel: "needs token",
      configuredHint: "configured",
      unconfiguredHint: "needs token",
      configuredScore: 2,
      unconfiguredScore: 1,
      resolveConfigured: ({ cfg, accountId }) =>
        inspectDiscordSetupAccount({ cfg, accountId }).configured,
    }),
    credentials: [
      {
        inputKey: "token",
        providerHint: channel,
        credentialLabel: "Discord bot token",
        preferredEnvVar: "DISCORD_BOT_TOKEN",
        helpTitle: "Discord bot token",
        helpLines: DISCORD_TOKEN_HELP_LINES,
        envPrompt: "DISCORD_BOT_TOKEN detected. Use env var?",
        keepPrompt: "Discord token already configured. Keep it?",
        inputPrompt: "Enter Discord bot token",
        allowEnv: ({ accountId }: { accountId: string }) => accountId === DEFAULT_ACCOUNT_ID,
        inspect: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) => {
          const account = inspectDiscordSetupAccount({ cfg, accountId });
          return {
            accountConfigured: account.configured,
            hasConfiguredValue: account.tokenStatus !== "missing",
            resolvedValue: normalizeOptionalString(account.token),
            envValue:
              accountId === DEFAULT_ACCOUNT_ID
                ? normalizeOptionalString(process.env.DISCORD_BOT_TOKEN)
                : undefined,
          };
        },
      },
    ],
    groupAccess: createAccountScopedGroupAccessSection({
      channel,
      label: "Discord channels",
      placeholder: "My Server/#general, guildId/channelId, #support",
      currentPolicy: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        resolveDiscordSetupAccountConfig({ cfg, accountId }).config.groupPolicy ?? "allowlist",
      currentEntries: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        Object.entries(
          resolveDiscordSetupAccountConfig({ cfg, accountId }).config.guilds ?? {},
        ).flatMap(([guildKey, value]) => {
          const channels = value?.channels ?? {};
          const channelKeys = Object.keys(channels);
          if (channelKeys.length === 0) {
            const input = /^\d+$/.test(guildKey) ? `guild:${guildKey}` : guildKey;
            return [input];
          }
          return channelKeys.map((channelKey) => `${guildKey}/${channelKey}`);
        }),
      updatePrompt: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
        Boolean(resolveDiscordSetupAccountConfig({ cfg, accountId }).config.guilds),
      resolveAllowlist: handlers.resolveGroupAllowlist,
      fallbackResolved: (entries) => entries.map((input) => ({ input, resolved: false })),
      applyAllowlist: ({
        cfg,
        accountId,
        resolved,
      }: {
        cfg: OpenClawConfig;
        accountId: string;
        resolved: unknown;
      }) => setDiscordGuildChannelAllowlist(cfg, accountId, resolved as never),
    }),
    allowFrom: createAccountScopedAllowFromSection({
      channel,
      credentialInputKey: "token",
      helpTitle: "Discord allowlist",
      helpLines: [
        "Allowlist Discord DMs by username (we resolve to user ids).",
        "Examples:",
        "- 123456789012345678",
        "- @alice",
        "- alice#1234",
        "Multiple entries: comma-separated.",
        `Docs: ${formatDocsLink("/discord", "discord")}`,
      ],
      message: "Discord allowFrom (usernames or ids)",
      placeholder: "@alice, 123456789012345678",
      invalidWithoutCredentialNote:
        "Bot token missing; use numeric user ids (or mention form) only.",
      parseId: parseDiscordAllowFromId,
      resolveEntries: handlers.resolveAllowFromEntries,
    }),
    dmPolicy: discordDmPolicy,
    disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
  } satisfies ChannelSetupWizard;
}
export function createDiscordSetupWizardProxy(loadWizard: () => Promise<ChannelSetupWizard>) {
  return createAllowlistSetupWizardProxy({
    loadWizard,
    createBase: createDiscordSetupWizardBase,
    fallbackResolvedGroupAllowlist: (entries) =>
      entries.map((input) => ({ input, resolved: false })),
  });
}
