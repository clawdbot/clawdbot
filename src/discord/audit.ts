import type { MoltbotConfig } from "../config/config.js";
import type { DiscordGuildChannelConfig, DiscordGuildEntry } from "../config/types.js";
import { resolveDiscordAccount } from "./accounts.js";
import { fetchChannelPermissionsDiscord } from "./send.js";

export type DiscordChannelPermissionsAuditEntry = {
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

const REQUIRED_CHANNEL_PERMISSIONS = ["ViewChannel", "SendMessages"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function shouldAuditChannelConfig(config: DiscordGuildChannelConfig | undefined) {
  if (!config) return true;
  if (config.allow === false) return false;
  if (config.enabled === false) return false;
  return true;
}

function listConfiguredGuildChannelKeys(
  guilds: Record<string, DiscordGuildEntry> | undefined,
): string[] {
  if (!guilds) return [];
  const ids = new Set<string>();
  for (const entry of Object.values(guilds)) {
    if (!entry || typeof entry !== "object") continue;
    const channelsRaw = (entry as { channels?: unknown }).channels;
    if (!isRecord(channelsRaw)) continue;
    for (const [key, value] of Object.entries(channelsRaw)) {
      const channelId = String(key).trim();
      if (!channelId) continue;
      if (!shouldAuditChannelConfig(value as DiscordGuildChannelConfig | undefined)) continue;
      ids.add(channelId);
    }
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export function collectDiscordAuditChannelIds(params: {
  cfg: MoltbotConfig;
  accountId?: string | null;
}) {
  const account = resolveDiscordAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const keys = listConfiguredGuildChannelKeys(account.config.guilds);
  const channelIds = keys.filter((key) => /^\d+$/.test(key));
  const unresolvedChannels = keys.length - channelIds.length;
  return { channelIds, unresolvedChannels };
}

export async function auditDiscordChannelPermissions(params: {
  token: string;
  accountId?: string | null;
  channelIds: string[];
  timeoutMs: number;
}): Promise<DiscordChannelPermissionsAudit> {
  const started = Date.now();
  const token = params.token?.trim() ?? "";
  if (!token || params.channelIds.length === 0) {
    return {
      ok: true,
      checkedChannels: 0,
      unresolvedChannels: 0,
      channels: [],
      elapsedMs: Date.now() - started,
    };
  }

  const required = [...REQUIRED_CHANNEL_PERMISSIONS];
  const channels: DiscordChannelPermissionsAuditEntry[] = [];

  for (const channelId of params.channelIds) {
    try {
      const perms = await fetchChannelPermissionsDiscord(channelId, {
        token,
        accountId: params.accountId ?? undefined,
      });
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
        error: err instanceof Error ? err.message : String(err),
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
