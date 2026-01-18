import { WebClient } from "@slack/web-api";

import type { ChannelDirectoryEntry } from "../channels/plugins/types.js";
import type { DirectoryConfigParams } from "../channels/plugins/directory-config.js";
import { resolveSlackAccount } from "./accounts.js";

type SlackUser = {
  id?: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  is_app_user?: boolean;
  deleted?: boolean;
  profile?: {
    display_name?: string;
    real_name?: string;
    email?: string;
  };
};

type SlackChannel = {
  id?: string;
  name?: string;
  is_archived?: boolean;
  is_private?: boolean;
};

type SlackListUsersResponse = {
  members?: SlackUser[];
  response_metadata?: { next_cursor?: string };
};

type SlackListChannelsResponse = {
  channels?: SlackChannel[];
  response_metadata?: { next_cursor?: string };
};

function resolveReadToken(params: DirectoryConfigParams): string | undefined {
  const account = resolveSlackAccount({ cfg: params.cfg, accountId: params.accountId });
  const userToken = account.config.userToken?.trim() || undefined;
  return userToken ?? account.botToken?.trim();
}

function normalizeQuery(value?: string | null): string {
  return value?.trim().toLowerCase() ?? "";
}

function buildUserRank(user: SlackUser): number {
  let rank = 0;
  if (!user.deleted) rank += 2;
  if (!user.is_bot && !user.is_app_user) rank += 1;
  return rank;
}

function buildChannelRank(channel: SlackChannel): number {
  return channel.is_archived ? 0 : 1;
}

export async function listSlackDirectoryPeersLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const token = resolveReadToken(params);
  if (!token) return [];
  const client = new WebClient(token);
  const query = normalizeQuery(params.query);
  const members: SlackUser[] = [];
  let cursor: string | undefined;

  do {
    const res = (await client.users.list({
      limit: 200,
      cursor,
    })) as SlackListUsersResponse;
    if (Array.isArray(res.members)) members.push(...res.members);
    const next = res.response_metadata?.next_cursor?.trim();
    cursor = next ? next : undefined;
  } while (cursor);

  const filtered = members.filter((member) => {
    const name = member.profile?.display_name || member.profile?.real_name || member.real_name;
    const handle = member.name;
    const email = member.profile?.email;
    const candidates = [name, handle, email]
      .map((item) => item?.trim().toLowerCase())
      .filter(Boolean);
    if (!query) return true;
    return candidates.some((candidate) => candidate?.includes(query));
  });

  const rows = filtered
    .map((member) => {
      const id = member.id?.trim();
      if (!id) return null;
      const handle = member.name?.trim();
      const display =
        member.profile?.display_name?.trim() ||
        member.profile?.real_name?.trim() ||
        member.real_name?.trim() ||
        handle;
      return {
        kind: "user",
        id: `user:${id}`,
        name: display || undefined,
        handle: handle ? `@${handle}` : undefined,
        rank: buildUserRank(member),
        raw: member,
      } satisfies ChannelDirectoryEntry;
    })
    .filter(Boolean) as ChannelDirectoryEntry[];

  if (typeof params.limit === "number" && params.limit > 0) {
    return rows.slice(0, params.limit);
  }
  return rows;
}

export async function listSlackDirectoryGroupsLive(
  params: DirectoryConfigParams,
): Promise<ChannelDirectoryEntry[]> {
  const token = resolveReadToken(params);
  if (!token) return [];
  const client = new WebClient(token);
  const query = normalizeQuery(params.query);
  const channels: SlackChannel[] = [];
  let cursor: string | undefined;

  do {
    const res = (await client.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: false,
      limit: 1000,
      cursor,
    })) as SlackListChannelsResponse;
    if (Array.isArray(res.channels)) channels.push(...res.channels);
    const next = res.response_metadata?.next_cursor?.trim();
    cursor = next ? next : undefined;
  } while (cursor);

  const filtered = channels.filter((channel) => {
    const name = channel.name?.trim().toLowerCase();
    if (!query) return true;
    return Boolean(name && name.includes(query));
  });

  const rows = filtered
    .map((channel) => {
      const id = channel.id?.trim();
      const name = channel.name?.trim();
      if (!id || !name) return null;
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
