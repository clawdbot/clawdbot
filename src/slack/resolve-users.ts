import { WebClient } from "@slack/web-api";

export type SlackUserLookup = {
  id: string;
  name: string;
  displayName?: string;
  realName?: string;
  email?: string;
  deleted: boolean;
  isBot: boolean;
  isAppUser: boolean;
};

export type SlackUserResolution = {
  input: string;
  resolved: boolean;
  id?: string;
  name?: string;
  email?: string;
  deleted?: boolean;
  isBot?: boolean;
  note?: string;
};

type SlackListUsersResponse = {
  members?: Array<{
    id?: string;
    name?: string;
    deleted?: boolean;
    is_bot?: boolean;
    is_app_user?: boolean;
    real_name?: string;
    profile?: {
      display_name?: string;
      real_name?: string;
      email?: string;
    };
  }>;
  response_metadata?: { next_cursor?: string };
};

function parseSlackUserInput(raw: string): { id?: string; name?: string; email?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  const mention = trimmed.match(/^<@([A-Z0-9]+)>$/i);
  if (mention) return { id: mention[1]?.toUpperCase() };
  const prefixed = trimmed.replace(/^(slack:|user:)/i, "");
  if (/^[A-Z][A-Z0-9]+$/i.test(prefixed)) return { id: prefixed.toUpperCase() };
  if (trimmed.includes("@") && !trimmed.startsWith("@")) return { email: trimmed.toLowerCase() };
  const name = trimmed.replace(/^@/, "").trim();
  return name ? { name } : {};
}

async function listSlackUsers(client: WebClient): Promise<SlackUserLookup[]> {
  const users: SlackUserLookup[] = [];
  let cursor: string | undefined;
  do {
    const res = (await client.users.list({
      limit: 200,
      cursor,
    })) as SlackListUsersResponse;
    for (const member of res.members ?? []) {
      const id = member.id?.trim();
      const name = member.name?.trim();
      if (!id || !name) continue;
      const profile = member.profile ?? {};
      users.push({
        id,
        name,
        displayName: profile.display_name?.trim() || undefined,
        realName: profile.real_name?.trim() || member.real_name?.trim() || undefined,
        email: profile.email?.trim()?.toLowerCase() || undefined,
        deleted: Boolean(member.deleted),
        isBot: Boolean(member.is_bot),
        isAppUser: Boolean(member.is_app_user),
      });
    }
    const next = res.response_metadata?.next_cursor?.trim();
    cursor = next ? next : undefined;
  } while (cursor);
  return users;
}

function scoreSlackUser(user: SlackUserLookup, match: { name?: string; email?: string }): number {
  let score = 0;
  if (!user.deleted) score += 3;
  if (!user.isBot && !user.isAppUser) score += 2;
  if (match.email && user.email === match.email) score += 5;
  if (match.name) {
    const target = match.name.toLowerCase();
    const candidates = [user.name, user.displayName, user.realName]
      .map((value) => value?.toLowerCase())
      .filter(Boolean) as string[];
    if (candidates.some((value) => value === target)) score += 2;
  }
  return score;
}

export async function resolveSlackUserAllowlist(params: {
  token: string;
  entries: string[];
  client?: WebClient;
}): Promise<SlackUserResolution[]> {
  const client = params.client ?? new WebClient(params.token);
  const users = await listSlackUsers(client);
  const results: SlackUserResolution[] = [];

  for (const input of params.entries) {
    const parsed = parseSlackUserInput(input);
    if (parsed.id) {
      const match = users.find((user) => user.id === parsed.id);
      results.push({
        input,
        resolved: true,
        id: parsed.id,
        name: match?.displayName ?? match?.realName ?? match?.name,
        email: match?.email,
        deleted: match?.deleted,
        isBot: match?.isBot,
      });
      continue;
    }
    if (parsed.email) {
      const matches = users.filter((user) => user.email === parsed.email);
      if (matches.length > 0) {
        const scored = matches
          .map((user) => ({ user, score: scoreSlackUser(user, parsed) }))
          .sort((a, b) => b.score - a.score);
        const best = scored[0]?.user ?? matches[0];
        results.push({
          input,
          resolved: true,
          id: best.id,
          name: best.displayName ?? best.realName ?? best.name,
          email: best.email,
          deleted: best.deleted,
          isBot: best.isBot,
          note: matches.length > 1 ? "multiple matches; chose best" : undefined,
        });
        continue;
      }
    }
    if (parsed.name) {
      const target = parsed.name.toLowerCase();
      const matches = users.filter((user) => {
        const candidates = [user.name, user.displayName, user.realName]
          .map((value) => value?.toLowerCase())
          .filter(Boolean) as string[];
        return candidates.includes(target);
      });
      if (matches.length > 0) {
        const scored = matches
          .map((user) => ({ user, score: scoreSlackUser(user, parsed) }))
          .sort((a, b) => b.score - a.score);
        const best = scored[0]?.user ?? matches[0];
        results.push({
          input,
          resolved: true,
          id: best.id,
          name: best.displayName ?? best.realName ?? best.name,
          email: best.email,
          deleted: best.deleted,
          isBot: best.isBot,
          note: matches.length > 1 ? "multiple matches; chose best" : undefined,
        });
        continue;
      }
    }

    results.push({ input, resolved: false });
  }

  return results;
}
