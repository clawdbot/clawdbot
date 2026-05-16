import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { DiscordGuildEntry, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ChannelSetupDmPolicy, ChannelSetupWizard } from "openclaw/plugin-sdk/setup-runtime";
import {
  createSetupTranslator,
  createStandardChannelSetupStatus,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  inspectDiscordSetupAccount,
  resolveDiscordSetupAccountConfig,
} from "./setup-account-state.js";
import {
  createAccountScopedAllowFromSection,
  createAccountScopedGroupAccessSection,
  createLegacyCompatChannelDmPolicy,
  parseMentionOrPrefixedId,
  patchChannelConfigForAccount,
  setSetupChannelEnabled,
} from "./setup-runtime-helpers.js";

const t = createSetupTranslator();

const channel = "discord" as const;
const DISCORD_TOKEN_HELP_LINES = [
  t("wizard.discord.tokenHelpCreateApplication"),
  t("wizard.discord.tokenHelpCopyToken"),
  t("wizard.discord.tokenHelpInviteBot"),
  t("wizard.discord.tokenHelpMessageContentIntent"),
  t("wizard.channels.docs", { link: formatDocsLink("/discord", "discord") }),
];

type DiscordGuildChannelAllowlistEntry = {
  guildKey: string;
  channelKey?: string;
};

type DiscordSetupAllowlistResolution = {
  resolved?: boolean;
  guildId?: string;
  channelId?: string;
  guildKey?: string;
  channelKey?: string;
};

function mapDiscordSetupAllowlistEntries(resolved: unknown): DiscordGuildChannelAllowlistEntry[] {
  if (!Array.isArray(resolved)) {
    return [];
  }
  return resolved.flatMap((entry): DiscordGuildChannelAllowlistEntry[] => {
    if (!entry || typeof entry !== "object") {
      return [];
    }
    const row = entry as DiscordSetupAllowlistResolution;
    if (row.resolved === false) {
      return [];
    }
    const guildKey = normalizeOptionalString(row.guildId ?? row.guildKey);
    if (!guildKey) {
      return [];
    }
    const channelKey = normalizeOptionalString(row.channelId ?? row.channelKey);
    return channelKey ? [{ guildKey, channelKey }] : [{ guildKey }];
  });
}

function setDiscordGuildChannelAllowlist(
  cfg: OpenClawConfig,
  accountId: string,
  entries: DiscordGuildChannelAllowlistEntry[],
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
      configuredLabel: t("wizard.channels.statusConfigured"),
      unconfiguredLabel: t("wizard.channels.statusNeedsToken"),
      configuredHint: t("wizard.channels.statusConfigured"),
      unconfiguredHint: t("wizard.channels.statusNeedsToken"),
      configuredScore: 2,
      unconfiguredScore: 1,
      resolveConfigured: ({ cfg, accountId }) =>
        inspectDiscordSetupAccount({ cfg, accountId }).configured,
    }),
    credentials: [
      {
        inputKey: "token",
        providerHint: channel,
        credentialLabel: t("wizard.discord.botToken"),
        preferredEnvVar: "DISCORD_BOT_TOKEN",
        helpTitle: t("wizard.discord.botToken"),
        helpLines: DISCORD_TOKEN_HELP_LINES,
        envPrompt: t("wizard.discord.tokenEnvPrompt"),
        keepPrompt: t("wizard.discord.tokenKeepPrompt"),
        inputPrompt: t("wizard.discord.tokenInputPrompt"),
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
      label: t("wizard.discord.channelsLabel"),
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
      }) =>
        setDiscordGuildChannelAllowlist(cfg, accountId, mapDiscordSetupAllowlistEntries(resolved)),
    }),
    allowFrom: createAccountScopedAllowFromSection({
      channel,
      credentialInputKey: "token",
      helpTitle: "Discord allowlist",
      helpLines: [
        t("wizard.discord.allowlistIntro"),
        t("wizard.discord.examples"),
        "- 123456789012345678",
        "- @alice",
        "- alice#1234",
        t("wizard.discord.multipleEntries"),
        t("wizard.channels.docs", { link: formatDocsLink("/discord", "discord") }),
      ],
      message: t("wizard.discord.allowFromPrompt"),
      placeholder: "@alice, 123456789012345678",
      invalidWithoutCredentialNote: t("wizard.discord.allowFromInvalidWithoutToken"),
      parseId: parseDiscordAllowFromId,
      resolveEntries: handlers.resolveAllowFromEntries,
    }),
    dmPolicy: discordDmPolicy,
    disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, channel, false),
  } satisfies ChannelSetupWizard;
}
