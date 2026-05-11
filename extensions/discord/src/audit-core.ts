import { ChannelType } from "discord-api-types/v10";
import type {
  DiscordGuildChannelConfig,
  DiscordGuildEntry,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type DiscordChannelPermissionsAuditEntry = {
  channelId: string;
  ok: boolean;
  missing?: string[];
  error?: string | null;
  matchKey?: string;
  matchSource?: "id";
};

export type DiscordChannelPermissionsAudit = {
  ok: boolean;
  checkedChannels: number;
  unresolvedChannels: number;
  channels: DiscordChannelPermissionsAuditEntry[];
  elapsedMs: number;
};

const REQUIRED_TEXT_CHANNEL_PERMISSIONS = ["ViewChannel", "SendMessages"] as const;
const REQUIRED_VOICE_CHANNEL_PERMISSIONS = [
  "ViewChannel",
  "Connect",
  "Speak",
  "SendMessages",
  "ReadMessageHistory",
] as const;

export function resolveRequiredDiscordChannelPermissions(channelType?: number): string[] {
  if (channelType === ChannelType.GuildVoice || channelType === ChannelType.GuildStageVoice) {
    return [...REQUIRED_VOICE_CHANNEL_PERMISSIONS];
  }
  return [...REQUIRED_TEXT_CHANNEL_PERMISSIONS];
}

function shouldAuditChannelConfig(config: DiscordGuildChannelConfig | undefined) {
  if (!config) {
    return true;
  }
  if (config.enabled === false) {
    return false;
  }
  return true;
}

function listConfiguredGuildChannelKeys(
  guilds: Record<string, DiscordGuildEntry> | undefined,
): string[] {
  if (!guilds) {
    return [];
  }
  const ids = new Set<string>();
  for (const entry of Object.values(guilds)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const channelsRaw = (entry as { channels?: unknown }).channels;
    if (!isRecord(channelsRaw)) {
      continue;
    }
    for (const [key, value] of Object.entries(channelsRaw)) {
      const channelId = normalizeOptionalString(key) ?? "";
      if (!channelId) {
        continue;
      }
      if (channelId === "*") {
        continue;
      }
      if (!shouldAuditChannelConfig(value as DiscordGuildChannelConfig | undefined)) {
        continue;
      }
      ids.add(channelId);
    }
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b));
}

export function collectDiscordAuditChannelIdsForGuilds(
  guilds: Record<string, DiscordGuildEntry> | undefined,
) {
  const keys = listConfiguredGuildChannelKeys(guilds);
  const channelIds = keys.filter((key) => /^\d+$/.test(key));
  const unresolvedChannels = keys.length - channelIds.length;
  return { channelIds, unresolvedChannels };
}

export function collectDiscordAuditChannelIdsForAccount(config: {
  guilds?: Record<string, DiscordGuildEntry>;
  voice?: { autoJoin?: Array<{ guildId?: string; channelId?: string }> };
}) {
  const collected = collectDiscordAuditChannelIdsForGuilds(config.guilds);
  const channelIds = new Set(collected.channelIds);
  let unresolvedVoiceChannels = 0;
  for (const entry of config.voice?.autoJoin ?? []) {
    const channelId = normalizeOptionalString(entry?.channelId) ?? "";
    if (/^\d+$/.test(channelId)) {
      channelIds.add(channelId);
    } else if (channelId) {
      unresolvedVoiceChannels++;
    }
  }
  return {
    channelIds: [...channelIds].toSorted((a, b) => a.localeCompare(b)),
    unresolvedChannels: collected.unresolvedChannels + unresolvedVoiceChannels,
  };
}

export async function auditDiscordChannelPermissionsWithFetcher(params: {
  cfg: OpenClawConfig;
  token: string;
  accountId?: string | null;
  channelIds: string[];
  timeoutMs: number;
  fetchChannelPermissions: (
    channelId: string,
    params: { cfg: OpenClawConfig; token: string; accountId?: string },
  ) => Promise<{
    permissions: string[];
    channelType?: number;
  }>;
}): Promise<DiscordChannelPermissionsAudit> {
  const started = Date.now();
  const token = normalizeOptionalString(params.token) ?? "";
  if (!token || params.channelIds.length === 0) {
    return {
      ok: true,
      checkedChannels: 0,
      unresolvedChannels: 0,
      channels: [],
      elapsedMs: Date.now() - started,
    };
  }

  const channels: DiscordChannelPermissionsAuditEntry[] = [];

  for (const channelId of params.channelIds) {
    try {
      const perms = await params.fetchChannelPermissions(channelId, {
        cfg: params.cfg,
        token,
        accountId: params.accountId ?? undefined,
      });
      const required = resolveRequiredDiscordChannelPermissions(perms.channelType);
      const missing = required.filter((p) => !perms.permissions.includes(p));
      channels.push({
        channelId,
        ok: missing.length === 0,
        missing: missing.length ? missing : undefined,
        error: null,
        matchKey: channelId,
        matchSource: "id",
      });
    } catch (err) {
      channels.push({
        channelId,
        ok: false,
        error: formatErrorMessage(err),
        matchKey: channelId,
        matchSource: "id",
      });
    }
  }

  return {
    ok: channels.every((c) => c.ok),
    checkedChannels: channels.length,
    unresolvedChannels: 0,
    channels,
    elapsedMs: Date.now() - started,
  };
}
