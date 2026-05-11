import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { fetchDiscord } from "./api.js";
import { listGuilds, type DiscordGuildSummary } from "./guilds.js";
import {
  buildDiscordUnresolvedResults,
  filterDiscordGuilds,
  resolveDiscordAllowlistToken,
} from "./resolve-allowlist-common.js";

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
  if (!trimmed) {
    return {};
  }
  const mention = trimmed.match(/^<@!?(\d+)>$/);
  if (mention) {
    return { userId: mention[1] };
  }
  const prefixed = trimmed.match(/^(?:user:|discord:)?(\d+)$/i);
  if (prefixed) {
    return { userId: prefixed[1] };
  }
  const split = trimmed.includes("/") ? trimmed.split("/") : trimmed.split("#");
  if (split.length >= 2) {
    const guild = split[0]?.trim();
    const user = split.slice(1).join("#").trim();
    if (guild && /^\d+$/.test(guild)) {
      return { guildId: guild, userName: user };
    }
    return { guildName: guild, userName: user };
  }
  return { userName: trimmed.replace(/^@/, "") };
}

function scoreDiscordMember(member: DiscordMember, query: string): number {
  const q = normalizeLowercaseStringOrEmpty(query);
  const user = member.user;
  const candidates = [user.username, user.global_name, member.nick ?? undefined]
    .map((value) => {
      const normalized = normalizeOptionalString(value);
      return normalized ? normalizeLowercaseStringOrEmpty(normalized) : undefined;
    })
    .filter(Boolean) as string[];
  let score = 0;
  if (candidates.some((value) => value === q)) {
    score += 3;
  }
  if (candidates.some((value) => value?.includes(q))) {
    score += 1;
  }
  if (!user.bot) {
    score += 1;
  }
  return score;
}

export async function resolveDiscordUserAllowlist(params: {
  token: string;
  entries: string[];
  fetcher?: typeof fetch;
}): Promise<DiscordUserResolution[]> {
  const token = resolveDiscordAllowlistToken(params.token);
  if (!token) {
    return buildDiscordUnresolvedResults(params.entries, (input) => ({
      input,
      resolved: false,
    }));
  }
  const fetcher = params.fetcher ?? fetch;

  // Lazy-load guilds: only fetch when an entry actually needs username search.
  // This prevents listGuilds() failures (permissions, network) from blocking
  // resolution of plain user-id entries that don't need guild data at all.
  let guilds: DiscordGuildSummary[] | null = null;
  const getGuilds = async (): Promise<DiscordGuildSummary[]> => {
    if (!guilds) {
      guilds = await listGuilds(token, fetcher);
    }
    return guilds;
  };

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

    const allGuilds = await getGuilds();
    const guildList = filterDiscordGuilds(allGuilds, {
      guildId: parsed.guildId,
      guildName: parsed.guildName?.trim(),
    });

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
        if (score === 0) {
          continue;
        }
        matches += 1;
        if (!best || score > best.score) {
          best = { member, guild, score };
        }
      }
    }

    if (best) {
      const user = best.member.user;
      const name =
        normalizeOptionalString(best.member.nick) ??
        normalizeOptionalString(user.global_name) ??
        normalizeOptionalString(user.username);
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
