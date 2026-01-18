import type { RESTGetAPIChannelResult, RESTGetAPIGuildChannelsResult } from "discord-api-types/v10";

import { normalizeDiscordSlug } from "./monitor/allow-list.js";
import { normalizeDiscordToken } from "./token.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

type DiscordGuildSummary = {
  id: string;
  name: string;
  slug: string;
};

type DiscordChannelSummary = {
  id: string;
  name: string;
  guildId: string;
  type?: number;
  archived?: boolean;
};

export type DiscordChannelResolution = {
  input: string;
  resolved: boolean;
  guildId?: string;
  guildName?: string;
  channelId?: string;
  channelName?: string;
  archived?: boolean;
  note?: string;
};

function parseDiscordChannelInput(raw: string): {
  guild?: string;
  channel?: string;
  channelId?: string;
  guildId?: string;
  guildOnly?: boolean;
} {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const mention = trimmed.match(/^<#(\d+)>$/);
  if (mention) return { channelId: mention[1] };
  const channelPrefix = trimmed.match(/^(?:channel:|discord:)?(\d+)$/i);
  if (channelPrefix) return { channelId: channelPrefix[1] };
  const guildPrefix = trimmed.match(/^(?:guild:|server:)?(\d+)$/i);
  if (guildPrefix && !trimmed.includes("/") && !trimmed.includes("#")) {
    return { guildId: guildPrefix[1], guildOnly: true };
  }
  const split = trimmed.includes("/") ? trimmed.split("/") : trimmed.split("#");
  if (split.length >= 2) {
    const guild = split[0]?.trim();
    const channel = split.slice(1).join("#").trim();
    if (!channel) {
      return guild ? { guild: guild.trim(), guildOnly: true } : {};
    }
    if (guild && /^\d+$/.test(guild)) return { guildId: guild, channel };
    return { guild, channel };
  }
  return { guild: trimmed, guildOnly: true };
}

async function fetchDiscord<T>(path: string, token: string, fetcher: typeof fetch): Promise<T> {
  const res = await fetcher(`${DISCORD_API_BASE}${path}`, {
    headers: { Authorization: `Bot ${token}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord API ${path} failed (${res.status}): ${text || "unknown error"}`);
  }
  return (await res.json()) as T;
}

async function listGuilds(token: string, fetcher: typeof fetch): Promise<DiscordGuildSummary[]> {
  const raw = await fetchDiscord<Array<{ id: string; name: string }>>(
    "/users/@me/guilds",
    token,
    fetcher,
  );
  return raw.map((guild) => ({
    id: guild.id,
    name: guild.name,
    slug: normalizeDiscordSlug(guild.name),
  }));
}

async function listGuildChannels(
  token: string,
  fetcher: typeof fetch,
  guildId: string,
): Promise<DiscordChannelSummary[]> {
  const raw = (await fetchDiscord(
    `/guilds/${guildId}/channels`,
    token,
    fetcher,
  )) as RESTGetAPIGuildChannelsResult;
  return raw
    .filter((channel) => Boolean(channel.id) && "name" in channel)
    .map((channel) => {
      const archived =
        "thread_metadata" in channel
          ? (channel as { thread_metadata?: { archived?: boolean } }).thread_metadata?.archived
          : undefined;
      return {
        id: channel.id,
        name: "name" in channel ? (channel.name ?? "") : "",
        guildId,
        type: channel.type,
        archived,
      };
    })
    .filter((channel) => Boolean(channel.name));
}

async function fetchChannel(
  token: string,
  fetcher: typeof fetch,
  channelId: string,
): Promise<DiscordChannelSummary | null> {
  const raw = (await fetchDiscord(
    `/channels/${channelId}`,
    token,
    fetcher,
  )) as RESTGetAPIChannelResult;
  if (!raw || !("guild_id" in raw)) return null;
  return {
    id: raw.id,
    name: "name" in raw ? (raw.name ?? "") : "",
    guildId: raw.guild_id ?? "",
    type: raw.type,
  };
}

function preferActiveMatch(candidates: DiscordChannelSummary[]): DiscordChannelSummary | undefined {
  if (candidates.length === 0) return undefined;
  const scored = candidates.map((channel) => {
    const isThread = channel.type === 11 || channel.type === 12;
    const archived = Boolean(channel.archived);
    const score = (archived ? 0 : 2) + (isThread ? 0 : 1);
    return { channel, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.channel ?? candidates[0];
}

function resolveGuildByName(
  guilds: DiscordGuildSummary[],
  input: string,
): DiscordGuildSummary | undefined {
  const slug = normalizeDiscordSlug(input);
  if (!slug) return undefined;
  return guilds.find((guild) => guild.slug === slug);
}

export async function resolveDiscordChannelAllowlist(params: {
  token: string;
  entries: string[];
  fetcher?: typeof fetch;
}): Promise<DiscordChannelResolution[]> {
  const token = normalizeDiscordToken(params.token);
  if (!token)
    return params.entries.map((input) => ({
      input,
      resolved: false,
    }));
  const fetcher = params.fetcher ?? fetch;
  const guilds = await listGuilds(token, fetcher);
  const channelsByGuild = new Map<string, Promise<DiscordChannelSummary[]>>();
  const getChannels = (guildId: string) => {
    const existing = channelsByGuild.get(guildId);
    if (existing) return existing;
    const promise = listGuildChannels(token, fetcher, guildId);
    channelsByGuild.set(guildId, promise);
    return promise;
  };

  const results: DiscordChannelResolution[] = [];

  for (const input of params.entries) {
    const parsed = parseDiscordChannelInput(input);
    if (parsed.guildOnly) {
      const guild =
        parsed.guildId && guilds.find((entry) => entry.id === parsed.guildId)
          ? guilds.find((entry) => entry.id === parsed.guildId)
          : parsed.guild
            ? resolveGuildByName(guilds, parsed.guild)
            : undefined;
      if (guild) {
        results.push({
          input,
          resolved: true,
          guildId: guild.id,
          guildName: guild.name,
        });
      } else {
        results.push({
          input,
          resolved: false,
          guildId: parsed.guildId,
          guildName: parsed.guild,
        });
      }
      continue;
    }

    if (parsed.channelId) {
      const channel = await fetchChannel(token, fetcher, parsed.channelId);
      if (channel?.guildId) {
        const guild = guilds.find((entry) => entry.id === channel.guildId);
        results.push({
          input,
          resolved: true,
          guildId: channel.guildId,
          guildName: guild?.name,
          channelId: channel.id,
          channelName: channel.name,
          archived: channel.archived,
        });
      } else {
        results.push({
          input,
          resolved: false,
          channelId: parsed.channelId,
        });
      }
      continue;
    }

    if (parsed.guildId || parsed.guild) {
      const guild =
        parsed.guildId && guilds.find((entry) => entry.id === parsed.guildId)
          ? guilds.find((entry) => entry.id === parsed.guildId)
          : parsed.guild
            ? resolveGuildByName(guilds, parsed.guild)
            : undefined;
      const channelQuery = parsed.channel?.trim();
      if (!guild || !channelQuery) {
        results.push({
          input,
          resolved: false,
          guildId: parsed.guildId,
          guildName: parsed.guild,
          channelName: channelQuery ?? parsed.channel,
        });
        continue;
      }
      const channels = await getChannels(guild.id);
      const matches = channels.filter(
        (channel) => normalizeDiscordSlug(channel.name) === normalizeDiscordSlug(channelQuery),
      );
      const match = preferActiveMatch(matches);
      if (match) {
        results.push({
          input,
          resolved: true,
          guildId: guild.id,
          guildName: guild.name,
          channelId: match.id,
          channelName: match.name,
          archived: match.archived,
        });
      } else {
        results.push({
          input,
          resolved: false,
          guildId: guild.id,
          guildName: guild.name,
          channelName: parsed.channel,
          note: `channel not found in guild ${guild.name}`,
        });
      }
      continue;
    }

    const channelName = input.trim().replace(/^#/, "");
    if (!channelName) {
      results.push({
        input,
        resolved: false,
        channelName: channelName,
      });
      continue;
    }
    const candidates: DiscordChannelSummary[] = [];
    for (const guild of guilds) {
      const channels = await getChannels(guild.id);
      for (const channel of channels) {
        if (normalizeDiscordSlug(channel.name) === normalizeDiscordSlug(channelName)) {
          candidates.push(channel);
        }
      }
    }
    const match = preferActiveMatch(candidates);
    if (match) {
      const guild = guilds.find((entry) => entry.id === match.guildId);
      results.push({
        input,
        resolved: true,
        guildId: match.guildId,
        guildName: guild?.name,
        channelId: match.id,
        channelName: match.name,
        archived: match.archived,
        note:
          candidates.length > 1 && guild?.name
            ? `matched multiple; chose ${guild.name}`
            : undefined,
      });
      continue;
    }

    results.push({
      input,
      resolved: false,
      channelName: channelName,
    });
  }

  return results;
}
