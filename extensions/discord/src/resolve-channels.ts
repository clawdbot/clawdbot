import { DiscordApiError, fetchDiscord } from "./api.js";
import { listGuilds } from "./guilds.js";
import { normalizeDiscordSlug } from "./monitor/allow-list.js";
import {
  buildDiscordUnresolvedResults,
  filterDiscordGuilds,
  resolveDiscordAllowlistToken,
} from "./resolve-allowlist-common.js";

type DiscordChannelSummary = {
  id: string;
  name: string;
  guildId: string;
  type?: number;
  archived?: boolean;
};

type DiscordChannelPayload = {
  id?: string;
  name?: string;
  type?: number;
  guild_id?: string;
  thread_metadata?: { archived?: boolean };
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
  if (!trimmed) {
    return {};
  }
  const mention = trimmed.match(/^<#(\d+)>$/);
  if (mention) {
    return { channelId: mention[1] };
  }
  const channelPrefix = trimmed.match(/^(?:channel:|discord:)?(\d+)$/i);
  if (channelPrefix) {
    return { channelId: channelPrefix[1] };
  }
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
    if (guild && /^\d+$/.test(guild)) {
      if (/^\d+$/.test(channel)) {
        return { guildId: guild, channelId: channel };
      }
      return { guildId: guild, channel };
    }
    return { guild, channel };
  }
  return { guild: trimmed, guildOnly: true };
}

async function listGuildChannels(
  token: string,
  fetcher: typeof fetch,
  guildId: string,
): Promise<DiscordChannelSummary[]> {
  const raw = await fetchDiscord<DiscordChannelPayload[]>(
    `/guilds/${guildId}/channels`,
    token,
    fetcher,
  );
  return raw
    .map((channel) => {
      const archived = channel.thread_metadata?.archived;
      return {
        id: typeof channel.id === "string" ? channel.id : "",
        name: typeof channel.name === "string" ? channel.name : "",
        guildId,
        type: channel.type,
        archived,
      };
    })
    .filter((channel) => Boolean(channel.id) && Boolean(channel.name));
}

type FetchChannelResult =
  | { status: "found"; channel: DiscordChannelSummary }
  | { status: "not-found" }
  | { status: "forbidden" }
  | { status: "invalid" };

async function fetchChannel(
  token: string,
  fetcher: typeof fetch,
  channelId: string,
): Promise<FetchChannelResult> {
  let raw: DiscordChannelPayload;
  try {
    raw = await fetchDiscord<DiscordChannelPayload>(`/channels/${channelId}`, token, fetcher);
  } catch (err) {
    if (err instanceof DiscordApiError && err.status === 403) {
      return { status: "forbidden" };
    }
    if (err instanceof DiscordApiError && err.status === 404) {
      return { status: "not-found" };
    }
    throw err;
  }
  if (!raw || typeof raw.guild_id !== "string" || typeof raw.id !== "string") {
    return { status: "invalid" };
  }
  return {
    status: "found",
    channel: {
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name : "",
      guildId: raw.guild_id,
      type: raw.type,
    },
  };
}

function preferActiveMatch(candidates: DiscordChannelSummary[]): DiscordChannelSummary | undefined {
  if (candidates.length === 0) {
    return undefined;
  }
  const scored = candidates.map((channel) => {
    const isThread = channel.type === 11 || channel.type === 12;
    const archived = Boolean(channel.archived);
    const score = (archived ? 0 : 2) + (isThread ? 0 : 1);
    return { channel, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.channel ?? candidates[0];
}

export async function resolveDiscordChannelAllowlist(params: {
  token: string;
  entries: string[];
  fetcher?: typeof fetch;
}): Promise<DiscordChannelResolution[]> {
  const token = resolveDiscordAllowlistToken(params.token);
  if (!token) {
    return buildDiscordUnresolvedResults(params.entries, (input) => ({
      input,
      resolved: false,
    }));
  }
  const fetcher = params.fetcher ?? fetch;
  const guilds = await listGuilds(token, fetcher);
  const channelsByGuild = new Map<string, Promise<DiscordChannelSummary[]>>();
  const getChannels = (guildId: string) => {
    const existing = channelsByGuild.get(guildId);
    if (existing) {
      return existing;
    }
    const promise = listGuildChannels(token, fetcher, guildId);
    channelsByGuild.set(guildId, promise);
    return promise;
  };

  const results: DiscordChannelResolution[] = [];

  for (const input of params.entries) {
    const parsed = parseDiscordChannelInput(input);
    if (parsed.guildOnly) {
      const guild = filterDiscordGuilds(guilds, {
        guildId: parsed.guildId,
        guildName: parsed.guild,
      })[0];
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
      const channelId = parsed.channelId;
      const result = await fetchChannel(token, fetcher, channelId);
      if (result.status === "found") {
        const channel = result.channel;
        if (parsed.guildId && parsed.guildId !== channel.guildId) {
          const expectedGuild = guilds.find((entry) => entry.id === parsed.guildId);
          const actualGuild = guilds.find((entry) => entry.id === channel.guildId);
          results.push({
            input,
            resolved: false,
            guildId: parsed.guildId,
            guildName: expectedGuild?.name,
            channelId,
            channelName: channel.name,
            note: actualGuild?.name
              ? `channel belongs to guild ${actualGuild.name}`
              : "channel belongs to a different guild",
          });
          continue;
        }
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
        continue;
      }

      if (result.status === "not-found" && parsed.guildId) {
        const guild = guilds.find((entry) => entry.id === parsed.guildId);
        if (guild) {
          const channels = await getChannels(guild.id);
          const matches = channels.filter(
            (channel) => normalizeDiscordSlug(channel.name) === normalizeDiscordSlug(channelId),
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
            continue;
          }
        }
      }

      results.push({
        input,
        resolved: false,
        guildId: parsed.guildId,
        channelId,
      });
      continue;
    }

    if (parsed.guildId || parsed.guild) {
      const guild = filterDiscordGuilds(guilds, {
        guildId: parsed.guildId,
        guildName: parsed.guild,
      })[0];
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
      const normalizedChannelQuery = normalizeDiscordSlug(channelQuery);
      const isNumericId = /^\d+$/.test(channelQuery);
      let matches = channels.filter((channel) =>
        isNumericId
          ? channel.id === channelQuery
          : normalizeDiscordSlug(channel.name) === normalizedChannelQuery,
      );
      if (isNumericId && matches.length === 0) {
        matches = channels.filter(
          (channel) => normalizeDiscordSlug(channel.name) === normalizedChannelQuery,
        );
      }
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
