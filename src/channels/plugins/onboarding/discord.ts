import type { MoltbotConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import type { DiscordGuildEntry } from "../../../config/types.discord.js";
import {
  listDiscordAccountIds,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
} from "../../../discord/accounts.js";
import { normalizeDiscordSlug } from "../../../discord/monitor/allow-list.js";
import { resolveDiscordUserAllowlist } from "../../../discord/resolve-users.js";
import {
  resolveDiscordChannelAllowlist,
  type DiscordChannelResolution,
} from "../../../discord/resolve-channels.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import { formatDocsLink } from "../../../terminal/links.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import { promptChannelAccessConfig } from "./channel-access.js";
import { addWildcardAllowFrom, promptAccountId } from "./helpers.js";

const channel = "discord" as const;

function setDiscordDmPolicy(cfg: MoltbotConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.discord?.dm?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      discord: {
        ...cfg.channels?.discord,
        dm: {
          ...cfg.channels?.discord?.dm,
          enabled: cfg.channels?.discord?.dm?.enabled ?? true,
          policy: dmPolicy,
          ...(allowFrom ? { allowFrom } : {}),
        },
      },
    },
  };
}

async function noteDiscordTokenHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Discord Developer Portal → Applications → New Application",
      "2) Bot → Add Bot → Reset Token → copy token",
      "3) OAuth2 → URL Generator → scope 'bot' → invite to your server",
      "Tip: enable Message Content Intent if you need message text. (Bot → Privileged Gateway Intents → Message Content Intent)",
      `Docs: ${formatDocsLink("/discord", "discord")}`,
    ].join("\n"),
    "Discord bot token",
  );
}

function setDiscordGroupPolicy(
  cfg: MoltbotConfig,
  accountId: string,
  groupPolicy: "open" | "allowlist" | "disabled",
): MoltbotConfig {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        discord: {
          ...cfg.channels?.discord,
          enabled: true,
          groupPolicy,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      discord: {
        ...cfg.channels?.discord,
        enabled: true,
        accounts: {
          ...cfg.channels?.discord?.accounts,
          [accountId]: {
            ...cfg.channels?.discord?.accounts?.[accountId],
            enabled: cfg.channels?.discord?.accounts?.[accountId]?.enabled ?? true,
            groupPolicy,
          },
        },
      },
    },
  };
}

function setDiscordGuildChannelAllowlist(
  cfg: MoltbotConfig,
  accountId: string,
  entries: Array<{
    guildKey: string;
    channelKey?: string;
  }>,
): MoltbotConfig {
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
      channels[entry.channelKey] = { allow: true };
      guilds[guildKey] = { ...existing, channels };
    } else {
      guilds[guildKey] = existing;
    }
  }
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        discord: {
          ...cfg.channels?.discord,
          enabled: true,
          guilds,
        },
      },
    };
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      discord: {
        ...cfg.channels?.discord,
        enabled: true,
        accounts: {
          ...cfg.channels?.discord?.accounts,
          [accountId]: {
            ...cfg.channels?.discord?.accounts?.[accountId],
            enabled: cfg.channels?.discord?.accounts?.[accountId]?.enabled ?? true,
            guilds,
          },
        },
      },
    },
  };
}

function setDiscordAllowFrom(cfg: MoltbotConfig, allowFrom: string[]): MoltbotConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      discord: {
        ...cfg.channels?.discord,
        dm: {
          ...cfg.channels?.discord?.dm,
          enabled: cfg.channels?.discord?.dm?.enabled ?? true,
          allowFrom,
        },
      },
    },
  };
}

function parseDiscordAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function promptDiscordAllowFrom(params: {
  cfg: MoltbotConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<MoltbotConfig> {
  const accountId =
    params.accountId && normalizeAccountId(params.accountId)
      ? (normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID)
      : resolveDefaultDiscordAccountId(params.cfg);
  const resolved = resolveDiscordAccount({ cfg: params.cfg, accountId });
  const token = resolved.token;
  const existing = params.cfg.channels?.discord?.dm?.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist Discord DMs by username (we resolve to user ids).",
      "Examples:",
      "- 123456789012345678",
      "- @alice",
      "- alice#1234",
      "Multiple entries: comma-separated.",
      `Docs: ${formatDocsLink("/discord", "discord")}`,
    ].join("\n"),
    "Discord allowlist",
  );

  const parseInputs = (value: string) => parseDiscordAllowFromInput(value);
  const parseId = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const mention = trimmed.match(/^<@!?(\d+)>$/);
    if (mention) return mention[1];
    const prefixed = trimmed.replace(/^(user:|discord:)/i, "");
    if (/^\d+$/.test(prefixed)) return prefixed;
    return null;
  };

  while (true) {
    const entry = await params.prompter.text({
      message: "Discord allowFrom (usernames or ids)",
      placeholder: "@alice, 123456789012345678",
      initialValue: existing[0] ? String(existing[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = parseInputs(String(entry));
    if (!token) {
      const ids = parts.map(parseId).filter(Boolean) as string[];
      if (ids.length !== parts.length) {
        await params.prompter.note(
          "Bot token missing; use numeric user ids (or mention form) only.",
          "Discord allowlist",
        );
        continue;
      }
      const unique = [...new Set([...existing.map((v) => String(v).trim()), ...ids])].filter(
        Boolean,
      );
      return setDiscordAllowFrom(params.cfg, unique);
    }

    const results = await resolveDiscordUserAllowlist({
      token,
      entries: parts,
    }).catch(() => null);
    if (!results) {
      await params.prompter.note("Failed to resolve usernames. Try again.", "Discord allowlist");
      continue;
    }
    const unresolved = results.filter((res) => !res.resolved || !res.id);
    if (unresolved.length > 0) {
      await params.prompter.note(
        `Could not resolve: ${unresolved.map((res) => res.input).join(", ")}`,
        "Discord allowlist",
      );
      continue;
    }
    const ids = results.map((res) => res.id as string);
    const unique = [...new Set([...existing.map((v) => String(v).trim()).filter(Boolean), ...ids])];
    return setDiscordAllowFrom(params.cfg, unique);
  }
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Discord",
  channel,
  policyKey: "channels.discord.dm.policy",
  allowFromKey: "channels.discord.dm.allowFrom",
  getCurrent: (cfg) => cfg.channels?.discord?.dm?.policy ?? "pairing",
  setPolicy: (cfg, policy) => setDiscordDmPolicy(cfg, policy),
  promptAllowFrom: promptDiscordAllowFrom,
};

export const discordOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listDiscordAccountIds(cfg).some((accountId) =>
      Boolean(resolveDiscordAccount({ cfg, accountId }).token),
    );
    return {
      channel,
      configured,
      statusLines: [`Discord: ${configured ? "configured" : "needs token"}`],
      selectionHint: configured ? "configured" : "needs token",
      quickstartScore: configured ? 2 : 1,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const discordOverride = accountOverrides.discord?.trim();
    const defaultDiscordAccountId = resolveDefaultDiscordAccountId(cfg);
    let discordAccountId = discordOverride
      ? normalizeAccountId(discordOverride)
      : defaultDiscordAccountId;
    if (shouldPromptAccountIds && !discordOverride) {
      discordAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "Discord",
        currentId: discordAccountId,
        listAccountIds: listDiscordAccountIds,
        defaultAccountId: defaultDiscordAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveDiscordAccount({
      cfg: next,
      accountId: discordAccountId,
    });
    const accountConfigured = Boolean(resolvedAccount.token);
    const allowEnv = discordAccountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv = allowEnv && Boolean(process.env.DISCORD_BOT_TOKEN?.trim());
    const hasConfigToken = Boolean(resolvedAccount.config.token);

    let token: string | null = null;
    if (!accountConfigured) {
      await noteDiscordTokenHelp(prompter);
    }
    if (canUseEnv && !resolvedAccount.config.token) {
      const keepEnv = await prompter.confirm({
        message: "DISCORD_BOT_TOKEN detected. Use env var?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            discord: { ...next.channels?.discord, enabled: true },
          },
        };
      } else {
        token = String(
          await prompter.text({
            message: "Enter Discord bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigToken) {
      const keep = await prompter.confirm({
        message: "Discord token already configured. Keep it?",
        initialValue: true,
      });
      if (!keep) {
        token = String(
          await prompter.text({
            message: "Enter Discord bot token",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      token = String(
        await prompter.text({
          message: "Enter Discord bot token",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (token) {
      if (discordAccountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            discord: { ...next.channels?.discord, enabled: true, token },
          },
        };
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            discord: {
              ...next.channels?.discord,
              enabled: true,
              accounts: {
                ...next.channels?.discord?.accounts,
                [discordAccountId]: {
                  ...next.channels?.discord?.accounts?.[discordAccountId],
                  enabled: next.channels?.discord?.accounts?.[discordAccountId]?.enabled ?? true,
                  token,
                },
              },
            },
          },
        };
      }
    }

    const currentEntries = Object.entries(resolvedAccount.config.guilds ?? {}).flatMap(
      ([guildKey, value]) => {
        const channels = value?.channels ?? {};
        const channelKeys = Object.keys(channels);
        if (channelKeys.length === 0) return [guildKey];
        return channelKeys.map((channelKey) => `${guildKey}/${channelKey}`);
      },
    );
    const accessConfig = await promptChannelAccessConfig({
      prompter,
      label: "Discord channels",
      currentPolicy: resolvedAccount.config.groupPolicy ?? "allowlist",
      currentEntries,
      placeholder: "My Server/#general, guildId/channelId, #support",
      updatePrompt: Boolean(resolvedAccount.config.guilds),
    });
    if (accessConfig) {
      if (accessConfig.policy !== "allowlist") {
        next = setDiscordGroupPolicy(next, discordAccountId, accessConfig.policy);
      } else {
        const accountWithTokens = resolveDiscordAccount({
          cfg: next,
          accountId: discordAccountId,
        });
        let resolved: DiscordChannelResolution[] = accessConfig.entries.map((input) => ({
          input,
          resolved: false,
        }));
        if (accountWithTokens.token && accessConfig.entries.length > 0) {
          try {
            resolved = await resolveDiscordChannelAllowlist({
              token: accountWithTokens.token,
              entries: accessConfig.entries,
            });
            const resolvedChannels = resolved.filter((entry) => entry.resolved && entry.channelId);
            const resolvedGuilds = resolved.filter(
              (entry) => entry.resolved && entry.guildId && !entry.channelId,
            );
            const unresolved = resolved
              .filter((entry) => !entry.resolved)
              .map((entry) => entry.input);
            if (resolvedChannels.length > 0 || resolvedGuilds.length > 0 || unresolved.length > 0) {
              const summary: string[] = [];
              if (resolvedChannels.length > 0) {
                summary.push(
                  `Resolved channels: ${resolvedChannels
                    .map((entry) => entry.channelId)
                    .filter(Boolean)
                    .join(", ")}`,
                );
              }
              if (resolvedGuilds.length > 0) {
                summary.push(
                  `Resolved guilds: ${resolvedGuilds
                    .map((entry) => entry.guildId)
                    .filter(Boolean)
                    .join(", ")}`,
                );
              }
              if (unresolved.length > 0) {
                summary.push(`Unresolved (kept as typed): ${unresolved.join(", ")}`);
              }
              await prompter.note(summary.join("\n"), "Discord channels");
            }
          } catch (err) {
            await prompter.note(
              `Channel lookup failed; keeping entries as typed. ${String(err)}`,
              "Discord channels",
            );
          }
        }
        const allowlistEntries: Array<{ guildKey: string; channelKey?: string }> = [];
        for (const entry of resolved) {
          const guildKey =
            entry.guildId ??
            (entry.guildName ? normalizeDiscordSlug(entry.guildName) : undefined) ??
            "*";
          const channelKey =
            entry.channelId ??
            (entry.channelName ? normalizeDiscordSlug(entry.channelName) : undefined);
          if (!channelKey && guildKey === "*") continue;
          allowlistEntries.push({ guildKey, ...(channelKey ? { channelKey } : {}) });
        }
        next = setDiscordGroupPolicy(next, discordAccountId, "allowlist");
        next = setDiscordGuildChannelAllowlist(next, discordAccountId, allowlistEntries);
      }
    }

    return { cfg: next, accountId: discordAccountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      discord: { ...cfg.channels?.discord, enabled: false },
    },
  }),
};
