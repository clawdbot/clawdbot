import { coerceNativeSetting, normalizeAllowFromList } from "openclaw/plugin-sdk/channel-policy";
import { readChannelAllowFromStore } from "openclaw/plugin-sdk/conversation-runtime";
import { isDangerousNameMatchingEnabled } from "openclaw/plugin-sdk/dangerous-name-runtime";
import {
  resolveNativeCommandsEnabled,
  resolveNativeSkillsEnabled,
} from "openclaw/plugin-sdk/native-command-config-runtime";
import type { ResolvedDiscordAccount } from "./accounts.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { isDiscordMutableAllowEntry } from "./security-doctor.js";

function normalizeOptionalString(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function addDiscordNameBasedEntries(params: {
  target: Set<string>;
  values: unknown;
  source: string;
}) {
  if (!Array.isArray(params.values)) {
    return;
  }
  for (const value of params.values) {
    if (!isDiscordMutableAllowEntry(String(value))) {
      continue;
    }
    const text = normalizeOptionalString(String(value)) ?? "";
    if (!text) {
      continue;
    }
    params.target.add(`${params.source}:${text}`);
  }
}

export async function collectDiscordSecurityAuditFindings(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  account: ResolvedDiscordAccount;
  orderedAccountIds: string[];
  hasExplicitAccountPath: boolean;
}) {
  const findings: Array<{
    checkId: string;
    severity: "info" | "warn" | "critical";
    title: string;
    detail: string;
    remediation?: string;
  }> = [];
  const discordCfg = params.account.config ?? {};
  const accountId =
    normalizeOptionalString(params.accountId) ?? params.account.accountId ?? "default";
  const dangerousNameMatchingEnabled = isDangerousNameMatchingEnabled(discordCfg);
  const storeAllowFrom = await readChannelAllowFromStore("discord", process.env, accountId).catch(
    () => [],
  );
  const discordNameBasedAllowEntries = new Set<string>();
  const discordPathPrefix =
    params.orderedAccountIds.length > 1 || params.hasExplicitAccountPath
      ? `channels.discord.accounts.${accountId}`
      : "channels.discord";

  addDiscordNameBasedEntries({
    target: discordNameBasedAllowEntries,
    values: discordCfg.allowFrom,
    source: `${discordPathPrefix}.allowFrom`,
  });
  addDiscordNameBasedEntries({
    target: discordNameBasedAllowEntries,
    values: (discordCfg.dm as { allowFrom?: unknown } | undefined)?.allowFrom,
    source: `${discordPathPrefix}.dm.allowFrom`,
  });
  addDiscordNameBasedEntries({
    target: discordNameBasedAllowEntries,
    values: storeAllowFrom,
    source: "~/.openclaw/credentials/discord-allowFrom.json",
  });

  const guildEntries = (discordCfg.guilds as Record<string, unknown> | undefined) ?? {};
  for (const [guildKey, guildValue] of Object.entries(guildEntries)) {
    if (!guildValue || typeof guildValue !== "object") {
      continue;
    }
    const guild = guildValue as Record<string, unknown>;
    addDiscordNameBasedEntries({
      target: discordNameBasedAllowEntries,
      values: guild.users,
      source: `${discordPathPrefix}.guilds.${guildKey}.users`,
    });
    const channels = guild.channels;
    if (!channels || typeof channels !== "object") {
      continue;
    }
    for (const [channelKey, channelValue] of Object.entries(channels as Record<string, unknown>)) {
      if (!channelValue || typeof channelValue !== "object") {
        continue;
      }
      const channel = channelValue as Record<string, unknown>;
      addDiscordNameBasedEntries({
        target: discordNameBasedAllowEntries,
        values: channel.users,
        source: `${discordPathPrefix}.guilds.${guildKey}.channels.${channelKey}.users`,
      });
    }
  }

  if (discordNameBasedAllowEntries.size > 0) {
    const examples = Array.from(discordNameBasedAllowEntries).slice(0, 5);
    const more =
      discordNameBasedAllowEntries.size > examples.length
        ? ` (+${discordNameBasedAllowEntries.size - examples.length} more)`
        : "";
    findings.push({
      checkId: "channels.discord.allowFrom.name_based_entries",
      severity: dangerousNameMatchingEnabled ? "info" : "warn",
      title: dangerousNameMatchingEnabled
        ? "Discord allowlist uses break-glass name/tag matching"
        : "Discord allowlist contains name or tag entries",
      detail: dangerousNameMatchingEnabled
        ? "Discord name/tag allowlist matching is explicitly enabled via dangerouslyAllowNameMatching. This mutable-identity mode is operator-selected break-glass behavior and out-of-scope for vulnerability reports by itself. " +
          `Found: ${examples.join(", ")}${more}.`
        : "Discord name/tag allowlist matching uses normalized slugs and can collide across users. " +
          `Found: ${examples.join(", ")}${more}.`,
      remediation: dangerousNameMatchingEnabled
        ? "Prefer stable Discord IDs (or <@id>/user:<id>/pk:<id>), then disable dangerouslyAllowNameMatching."
        : "Prefer stable Discord IDs (or <@id>/user:<id>/pk:<id>) in channels.discord.allowFrom and channels.discord.guilds.*.users, or explicitly opt in with dangerouslyAllowNameMatching=true if you accept the risk.",
    });
  }

  const nativeEnabled = resolveNativeCommandsEnabled({
    providerId: "discord",
    providerSetting: coerceNativeSetting(
      (discordCfg.commands as { native?: unknown } | undefined)?.native,
    ),
    globalSetting: params.cfg.commands?.native,
  });
  const nativeSkillsEnabled = resolveNativeSkillsEnabled({
    providerId: "discord",
    providerSetting: coerceNativeSetting(
      (discordCfg.commands as { nativeSkills?: unknown } | undefined)?.nativeSkills,
    ),
    globalSetting: params.cfg.commands?.nativeSkills,
  });
  if (!nativeEnabled && !nativeSkillsEnabled) {
    return findings;
  }

  const defaultGroupPolicy = params.cfg.channels?.defaults?.groupPolicy;
  const groupPolicy =
    (discordCfg.groupPolicy as string | undefined) ?? defaultGroupPolicy ?? "allowlist";
  const guildsConfigured = Object.keys(guildEntries).length > 0;
  const hasAnyUserAllowlist = Object.values(guildEntries).some((guild) => {
    if (!guild || typeof guild !== "object") {
      return false;
    }
    const record = guild as Record<string, unknown>;
    if (Array.isArray(record.users) && record.users.length > 0) {
      return true;
    }
    const channels = record.channels;
    if (!channels || typeof channels !== "object") {
      return false;
    }
    return Object.values(channels as Record<string, unknown>).some((channel) => {
      if (!channel || typeof channel !== "object") {
        return false;
      }
      const channelRecord = channel as Record<string, unknown>;
      return Array.isArray(channelRecord.users) && channelRecord.users.length > 0;
    });
  });
  const dmAllowFromRaw = (discordCfg.dm as { allowFrom?: unknown } | undefined)?.allowFrom;
  const dmAllowFrom = Array.isArray(dmAllowFromRaw) ? dmAllowFromRaw : [];
  const ownerAllowFromConfigured =
    normalizeAllowFromList([...dmAllowFrom, ...storeAllowFrom]).length > 0;
  const useAccessGroups = params.cfg.commands?.useAccessGroups !== false;

  if (!useAccessGroups && groupPolicy !== "disabled" && guildsConfigured && !hasAnyUserAllowlist) {
    findings.push({
      checkId: "channels.discord.commands.native.unrestricted",
      severity: "critical",
      title: "Discord slash commands are unrestricted",
      detail:
        "commands.useAccessGroups=false disables sender allowlists for Discord slash commands unless a per-guild/channel users allowlist is configured; with no users allowlist, any user in allowed guild channels can invoke /… commands.",
      remediation:
        "Set commands.useAccessGroups=true (recommended), or configure channels.discord.guilds.<id>.users (or channels.discord.guilds.<id>.channels.<channel>.users).",
    });
  } else if (
    useAccessGroups &&
    groupPolicy !== "disabled" &&
    guildsConfigured &&
    !ownerAllowFromConfigured &&
    !hasAnyUserAllowlist
  ) {
    findings.push({
      checkId: "channels.discord.commands.native.no_allowlists",
      severity: "warn",
      title: "Discord slash commands have no allowlists",
      detail:
        "Discord slash commands are enabled, but neither an owner allowFrom list nor any per-guild/channel users allowlist is configured; /… commands will be rejected for everyone.",
      remediation:
        "Add your user id to channels.discord.allowFrom (or approve yourself via pairing), or configure channels.discord.guilds.<id>.users.",
    });
  }

  return findings;
}
