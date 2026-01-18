import type { ChannelDirectoryEntry } from "../channels/plugins/types.js";
import type { DirectoryConfigParams } from "../channels/plugins/directory-config.js";
import { resolveDiscordAccount } from "./accounts.js";
import { normalizeDiscordSlug } from "./monitor/allow-list.js";
import { normalizeDiscordToken } from "./token.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

type DiscordGuild = { id: string; name: string };
type DiscordUser = { id: string; username: string; global_name?: string; bot?: boolean };
type DiscordMember = { user: DiscordUser; nick?: string | null };
type DiscordChannel = { id: string; name?: string | null };

async function fetchDiscord<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${DISCORD_API_BASE}${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord API ${path} failed (${res.status}): ${text || "unknown error"}`);
  }
  return (await res.json()) as T;
}

function normalizeQuery(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function buildUserRank(user: DiscordUser): number {
  return user.bot ? 0 : 1;
}

export async function listDiscordDirectoryGroupsLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
  const token = normalizeDiscordToken(account.token);
  if (!token) return [];
  const query = normalizeQuery(params.query);
  const guilds = await fetchDiscord<DiscordGuild[]>("/users/@me/guilds", token);
  const rows: ChannelDirectoryEntry[] = [];

  for (const guild of guilds) {
    const channels = await fetchDiscord<DiscordChannel[]>(`/guilds/${guild.id}/channels`, token);
    for (const channel of channels) {
      const name = channel.name?.trim();
      if (!name) continue;
      if (query && !normalizeDiscordSlug(name).includes(normalizeDiscordSlug(query))) continue;
      rows.push({
        kind: "group",
        id: `channel:${channel.id}`,
        name,
        handle: `#${name}`,
        raw: channel,
      });
      if (typeof params.limit === "number" && params.limit > 0 && rows.length >= params.limit) {
        return rows;
      }
    }
  }

  return rows;
}

export async function listDiscordDirectoryPeersLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const account = resolveDiscordAccount({ cfg: params.cfg, accountId: params.accountId });
  const token = normalizeDiscordToken(account.token);
  if (!token) return [];
  const query = normalizeQuery(params.query);
  if (!query) return [];

  const guilds = await fetchDiscord<DiscordGuild[]>("/users/@me/guilds", token);
  const rows: ChannelDirectoryEntry[] = [];
  const limit = typeof params.limit === "number" && params.limit > 0 ? params.limit : 25;

  for (const guild of guilds) {
    const paramsObj = new URLSearchParams({
      query,
      limit: String(Math.min(limit, 100)),
    });
    const members = await fetchDiscord<DiscordMember[]>(
      `/guilds/${guild.id}/members/search?${paramsObj.toString()}`,
      token,
    );
    for (const member of members) {
      const user = member.user;
      if (!user?.id) continue;
      const name = member.nick?.trim() || user.global_name?.trim() || user.username?.trim();
      rows.push({
        kind: "user",
        id: `user:${user.id}`,
        name: name || undefined,
        handle: user.username ? `@${user.username}` : undefined,
        rank: buildUserRank(user),
        raw: member,
      });
      if (rows.length >= limit) return rows;
    }
  }

  return rows;
}
