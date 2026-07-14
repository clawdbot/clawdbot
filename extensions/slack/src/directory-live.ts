// Slack plugin module implements directory live behavior.
import type { ConversationsListResponse, UsersListResponse } from "@slack/web-api";
import type {
  ChannelDirectoryEntry,
  DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSlackAccount } from "./accounts.js";
import { createSlackWebClient } from "./client.js";

type SlackUser = NonNullable<UsersListResponse["members"]>[number];
type SlackChannel = NonNullable<ConversationsListResponse["channels"]>[number];

function createSlackDirectoryClient(params: DirectoryConfigParams) {
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const token = account.userToken ?? account.botToken?.trim();
  return token ? createSlackWebClient(token) : null;
}

function normalizeQuery(value?: string | null): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function buildUserRank(user: SlackUser): number {
  let rank = 0;
  if (!user.deleted) {
    rank += 2;
  }
  if (!user.is_bot && !user.is_app_user) {
    rank += 1;
  }
  return rank;
}

function buildChannelRank(channel: SlackChannel): number {
  return channel.is_archived ? 0 : 1;
}

function slackUserToDirectoryEntry(
  user: SlackUser,
  fallback?: { id?: string; name?: string },
): ChannelDirectoryEntry | null {
  const id = normalizeOptionalString(user.id) ?? normalizeOptionalString(fallback?.id);
  if (!id) {
    return null;
  }
  const handle = normalizeOptionalString(user.name) ?? normalizeOptionalString(fallback?.name);
  const display =
    normalizeOptionalString(user.profile?.display_name) ||
    normalizeOptionalString(user.profile?.real_name) ||
    normalizeOptionalString(user.real_name) ||
    handle;
  return {
    kind: "user",
    id: `user:${id}`,
    name: display || undefined,
    handle: handle ? `@${handle}` : undefined,
    rank: buildUserRank(user),
    raw: user,
  };
}

export async function getSlackDirectorySelfLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry | null> {
  const client = createSlackDirectoryClient(params);
  if (!client) {
    return null;
  }
  const auth = await client.auth.test();
  const userId = normalizeOptionalString(auth.user_id);
  if (!userId) {
    return null;
  }
  try {
    const info = await client.users.info({ user: userId });
    return slackUserToDirectoryEntry(info.user ?? {}, { id: userId, name: auth.user });
  } catch {
    return slackUserToDirectoryEntry(
      { id: userId, name: auth.user },
      { id: userId, name: auth.user },
    );
  }
}

export async function listSlackDirectoryPeersLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const client = createSlackDirectoryClient(params);
  if (!client) {
    return [];
  }
  const query = normalizeQuery(params.query);
  const members: SlackUser[] = [];
  let cursor: string | undefined;

  do {
    const res = await client.users.list({
      limit: 200,
      cursor,
    });
    if (Array.isArray(res.members)) {
      members.push(...res.members);
    }
    const next = res.response_metadata?.next_cursor?.trim();
    cursor = next ? next : undefined;
  } while (cursor);

  const filtered = members.filter((member) => {
    const name = member.profile?.display_name || member.profile?.real_name || member.real_name;
    const handle = member.name;
    const email = member.profile?.email;
    const candidates = [name, handle, email]
      .map((item) => normalizeOptionalLowercaseString(item))
      .filter(Boolean);
    if (!query) {
      return true;
    }
    return candidates.some((candidate) => candidate?.includes(query));
  });

  const rows = filtered
    .map((member) => slackUserToDirectoryEntry(member))
    .filter(Boolean) as ChannelDirectoryEntry[];

  if (typeof params.limit === "number" && params.limit > 0) {
    return rows.slice(0, params.limit);
  }
  return rows;
}

export async function listSlackDirectoryGroupsLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const client = createSlackDirectoryClient(params);
  if (!client) {
    return [];
  }
  const query = normalizeQuery(params.query);
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;

  do {
    const res = await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: false,
      limit: 1000,
      cursor,
    });
    if (Array.isArray(res.channels)) {
      channels.push(...res.channels);
    }
    const next = res.response_metadata?.next_cursor?.trim();
    cursor = next ? next : undefined;
  } while (cursor);

  const filtered = channels.filter((channel) => {
    const name = normalizeOptionalLowercaseString(channel.name);
    if (!query) {
      return true;
    }
    return Boolean(name && name.includes(query));
  });

  const rows = filtered
    .map((channel) => {
      const id = channel.id?.trim();
      const name = channel.name?.trim();
      if (!id || !name) {
        return null;
      }
      return {
        kind: "group",
        id: `channel:${id}`,
        name,
        handle: `#${name}`,
        rank: buildChannelRank(channel),
        raw: channel,
      } satisfies ChannelDirectoryEntry;
    })
    .filter(Boolean) as ChannelDirectoryEntry[];

  if (typeof params.limit === "number" && params.limit > 0) {
    return rows.slice(0, params.limit);
  }
  return rows;
}
