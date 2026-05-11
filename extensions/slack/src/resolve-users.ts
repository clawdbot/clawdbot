import type { WebClient } from "@slack/web-api";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { createSlackWebClient } from "./client.js";
import {
  collectSlackCursorItems,
  resolveSlackAllowlistEntries,
} from "./resolve-allowlist-common.js";

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
  if (!trimmed) {
    return {};
  }
  const mention = trimmed.match(/^<@([A-Z0-9]+)>$/i);
  if (mention) {
    return { id: mention[1]?.toUpperCase() };
  }
  const prefixed = trimmed.replace(/^(slack:|user:)/i, "");
  if (/^[A-Z][A-Z0-9]+$/i.test(prefixed)) {
    return { id: prefixed.toUpperCase() };
  }
  if (trimmed.includes("@") && !trimmed.startsWith("@")) {
    return { email: normalizeLowercaseStringOrEmpty(trimmed) };
  }
  const name = trimmed.replace(/^@/, "").trim();
  return name ? { name } : {};
}

async function listSlackUsers(client: WebClient): Promise<SlackUserLookup[]> {
  return collectSlackCursorItems({
    fetchPage: async (cursor) =>
      (await client.users.list({
        limit: 200,
        cursor,
      })) as SlackListUsersResponse,
    collectPageItems: (res) =>
      (res.members ?? [])
        .map((member) => {
          const id = normalizeOptionalString(member.id);
          const name = normalizeOptionalString(member.name);
          if (!id || !name) {
            return null;
          }
          const profile = member.profile ?? {};
          return {
            id,
            name,
            displayName: normalizeOptionalString(profile.display_name),
            realName:
              normalizeOptionalString(profile.real_name) ??
              normalizeOptionalString(member.real_name),
            email:
              normalizeOptionalString(profile.email) == null
                ? undefined
                : normalizeLowercaseStringOrEmpty(profile.email),
            deleted: Boolean(member.deleted),
            isBot: Boolean(member.is_bot),
            isAppUser: Boolean(member.is_app_user),
          } satisfies SlackUserLookup;
        })
        .filter(Boolean) as SlackUserLookup[],
  });
}

function scoreSlackUser(user: SlackUserLookup, match: { name?: string; email?: string }): number {
  let score = 0;
  if (!user.deleted) {
    score += 3;
  }
  if (!user.isBot && !user.isAppUser) {
    score += 2;
  }
  if (match.email && user.email === match.email) {
    score += 5;
  }
  if (match.name) {
    const target = normalizeLowercaseStringOrEmpty(match.name);
    const candidates = [user.name, user.displayName, user.realName]
      .map((value) => normalizeLowercaseStringOrEmpty(value))
      .filter(Boolean);
    if (candidates.some((value) => value === target)) {
      score += 2;
    }
  }
  return score;
}

function resolveSlackUserFromMatches(
  input: string,
  matches: SlackUserLookup[],
  parsed: { name?: string; email?: string },
): SlackUserResolution {
  const scored = matches
    .map((user) => ({ user, score: scoreSlackUser(user, parsed) }))
    .toSorted((a, b) => b.score - a.score);
  const best = scored[0]?.user ?? matches[0];
  return {
    input,
    resolved: true,
    id: best.id,
    name: best.displayName ?? best.realName ?? best.name,
    email: best.email,
    deleted: best.deleted,
    isBot: best.isBot,
    note: matches.length > 1 ? "multiple matches; chose best" : undefined,
  };
}

export async function resolveSlackUserAllowlist(params: {
  token: string;
  entries: string[];
  client?: WebClient;
}): Promise<SlackUserResolution[]> {
  const client = params.client ?? createSlackWebClient(params.token);
  const users = await listSlackUsers(client);
  return resolveSlackAllowlistEntries<
    { id?: string; name?: string; email?: string },
    SlackUserLookup,
    SlackUserResolution
  >({
    entries: params.entries,
    lookup: users,
    parseInput: parseSlackUserInput,
    findById: (lookup, id) => lookup.find((user) => user.id === id),
    buildIdResolved: ({ input, parsed, match }) => ({
      input,
      resolved: true,
      id: parsed.id,
      name: match?.displayName ?? match?.realName ?? match?.name,
      email: match?.email,
      deleted: match?.deleted,
      isBot: match?.isBot,
    }),
    resolveNonId: ({ input, parsed, lookup }) => {
      if (parsed.email) {
        const matches = lookup.filter((user) => user.email === parsed.email);
        if (matches.length > 0) {
          return resolveSlackUserFromMatches(input, matches, parsed);
        }
      }
      if (parsed.name) {
        const target = normalizeLowercaseStringOrEmpty(parsed.name);
        const matches = lookup.filter((user) => {
          const candidates = [user.name, user.displayName, user.realName]
            .map((value) => normalizeLowercaseStringOrEmpty(value))
            .filter(Boolean);
          return candidates.includes(target);
        });
        if (matches.length > 0) {
          return resolveSlackUserFromMatches(input, matches, parsed);
        }
      }
      return undefined;
    },
    buildUnresolved: (input) => ({ input, resolved: false }),
  });
}
