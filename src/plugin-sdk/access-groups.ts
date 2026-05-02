import type { ChannelId } from "../channels/plugins/types.public.js";
import type { AccessGroupConfig } from "../config/types.access-groups.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export const ACCESS_GROUP_ALLOW_FROM_PREFIX = "accessGroup:";

export type AccessGroupMembershipResolver = (params: {
  cfg: OpenClawConfig;
  name: string;
  group: AccessGroupConfig;
  channel: ChannelId;
  accountId: string;
  senderId: string;
}) => boolean | Promise<boolean>;

export function parseAccessGroupAllowFromEntry(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed.startsWith(ACCESS_GROUP_ALLOW_FROM_PREFIX)) {
    return null;
  }
  const name = trimmed.slice(ACCESS_GROUP_ALLOW_FROM_PREFIX.length).trim();
  return name.length > 0 ? name : null;
}

function resolveMessageSenderGroupEntries(params: {
  group: AccessGroupConfig;
  channel: ChannelId;
}): string[] {
  if (params.group.type !== "message.senders") {
    return [];
  }
  return [...(params.group.members["*"] ?? []), ...(params.group.members[params.channel] ?? [])];
}

export async function resolveAccessGroupAllowFromMatches(params: {
  cfg?: OpenClawConfig;
  allowFrom: Array<string | number> | null | undefined;
  channel: ChannelId;
  accountId: string;
  senderId: string;
  isSenderAllowed?: (senderId: string, allowFrom: string[]) => boolean;
  resolveMembership?: AccessGroupMembershipResolver;
}): Promise<string[]> {
  const cfg = params.cfg;
  const groups = cfg?.accessGroups;
  if (!groups) {
    return [];
  }

  const names = Array.from(
    new Set(
      (params.allowFrom ?? [])
        .map((entry) => parseAccessGroupAllowFromEntry(String(entry)))
        .filter((entry): entry is string => entry != null),
    ),
  );
  if (names.length === 0) {
    return [];
  }

  const matched: string[] = [];
  for (const name of names) {
    const group = groups[name];
    if (!group) {
      continue;
    }

    const senderEntries = resolveMessageSenderGroupEntries({
      group,
      channel: params.channel,
    });
    if (
      senderEntries.length > 0 &&
      params.isSenderAllowed?.(params.senderId, senderEntries) === true
    ) {
      matched.push(`${ACCESS_GROUP_ALLOW_FROM_PREFIX}${name}`);
      continue;
    }

    let allowed = false;
    try {
      allowed =
        (await params.resolveMembership?.({
          cfg,
          name,
          group,
          channel: params.channel,
          accountId: params.accountId,
          senderId: params.senderId,
        })) === true;
    } catch {
      allowed = false;
    }
    if (allowed) {
      matched.push(`${ACCESS_GROUP_ALLOW_FROM_PREFIX}${name}`);
    }
  }
  return matched;
}

export async function expandAllowFromWithAccessGroups(params: {
  cfg?: OpenClawConfig;
  allowFrom: Array<string | number> | null | undefined;
  channel: ChannelId;
  accountId: string;
  senderId: string;
  senderAllowEntry?: string;
  isSenderAllowed?: (senderId: string, allowFrom: string[]) => boolean;
  resolveMembership?: AccessGroupMembershipResolver;
}): Promise<string[]> {
  const allowFrom = (params.allowFrom ?? []).map(String);
  const matched = await resolveAccessGroupAllowFromMatches({
    cfg: params.cfg,
    allowFrom,
    channel: params.channel,
    accountId: params.accountId,
    senderId: params.senderId,
    isSenderAllowed: params.isSenderAllowed,
    resolveMembership: params.resolveMembership,
  });
  if (matched.length === 0) {
    return allowFrom;
  }
  const senderEntry = params.senderAllowEntry ?? params.senderId;
  return Array.from(new Set([...allowFrom, senderEntry]));
}
