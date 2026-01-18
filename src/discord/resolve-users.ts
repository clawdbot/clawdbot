import { normalizeDiscordSlug } from "./monitor/allow-list.js";
import { normalizeDiscordToken } from "./token.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

type DiscordGuildSummary = {
  id: string;
  name: string;
  slug: string;
};

type DiscordUser = {
  id: string;
  username: string;
  discriminator?: string;
  global_name?: string;
  bot?: boolean;
};

type DiscordMember = {
  user: DiscordUser;
  nick?: string | null;
};

export type DiscordUserResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  guildId?: string;
  guildName?: string;
  note?: string;
};

function parseDiscordUserInput(raw: string): {
  userId?: string;
  guildId?: string;
  guildName?: string;
  userName?: string;
} {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const mention = trimmed.match(/^<@!?(\d+)>$/);
  if (mention) return { userId: mention[1] };
  const prefixed = trimmed.match(/^(?:user:|discord:)?(\d+)$/i);
  if (prefixed) return { userId: prefixed[1] };
  const split = trimmed.includes("/") ? trimmed.split("/") : trimmed.split("#");
  if (split.length >= 2) {
    const guild = split[0]?.trim();
    const user = split.slice(1).join("#").trim();
    if (guild && /^\d+$/.test(guild)) return { guildId: guild, userName: user };
    return { guildName: guild, userName: user };
  }
  return { userName: trimmed.replace(/^@/, "") };
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

function scoreDiscordMember(member: DiscordMember, query: string): number {
  const q = query.toLowerCase();
  const user = member.user;
  const candidates = [user.username, user.global_name, member.nick ?? undefined]
    .map((value) => value?.toLowerCase())
    .filter(Boolean) as string[];
  let score = 0;
  if (candidates.some((value) => value === q)) score += 3;
  if (candidates.some((value) => value?.includes(q))) score += 1;
  if (!user.bot) score += 1;
  return score;
}

export async function resolveDiscordUserAllowlist(params: {
  token: string;
  entries: string[];
  fetcher?: typeof fetch;
}): Promise<DiscordUserResolution[]> {
  const token = normalizeDiscordToken(params.token);
  if (!token)
    return params.entries.map((input) => ({
      input,
      resolved: false,
    }));
  const fetcher = params.fetcher ?? fetch;
  const guilds = await listGuilds(token, fetcher);
  const results: DiscordUserResolution[] = [];

  for (const input of params.entries) {
    const parsed = parseDiscordUserInput(input);
    if (parsed.userId) {
      results.push({
        input,
        resolved: true,
        id: parsed.userId,
      });
      continue;
    }

    const query = parsed.userName?.trim();
    if (!query) {
      results.push({ input, resolved: false });
      continue;
    }

    const guildName = parsed.guildName?.trim();
    const guildList = parsed.guildId
      ? guilds.filter((g) => g.id === parsed.guildId)
      : guildName
        ? guilds.filter((g) => g.slug === normalizeDiscordSlug(guildName))
        : guilds;

    let best: { member: DiscordMember; guild: DiscordGuildSummary; score: number } | null = null;
    let matches = 0;

    for (const guild of guildList) {
      const paramsObj = new URLSearchParams({
        query,
        limit: "25",
      });
      const members = await fetchDiscord<DiscordMember[]>(
        `/guilds/${guild.id}/members/search?${paramsObj.toString()}`,
        token,
        fetcher,
      );
      for (const member of members) {
        const score = scoreDiscordMember(member, query);
        if (score === 0) continue;
        matches += 1;
        if (!best || score > best.score) {
          best = { member, guild, score };
        }
      }
    }

    if (best) {
      const user = best.member.user;
      const name =
        best.member.nick?.trim() || user.global_name?.trim() || user.username?.trim() || undefined;
      results.push({
        input,
        resolved: true,
        id: user.id,
        name,
        guildId: best.guild.id,
        guildName: best.guild.name,
        note: matches > 1 ? "multiple matches; chose best" : undefined,
      });
    } else {
      results.push({ input, resolved: false });
    }
  }

  return results;
}
