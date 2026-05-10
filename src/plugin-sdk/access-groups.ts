import {
  ACCESS_GROUP_ALLOW_FROM_PREFIX,
  parseAccessGroupAllowFromEntry,
} from "../channels/allow-from.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { AccessGroupConfig } from "../config/types.access-groups.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export { ACCESS_GROUP_ALLOW_FROM_PREFIX, parseAccessGroupAllowFromEntry };

export type AccessGroupMembershipResolver = (params: {
  cfg: OpenClawConfig;
  name: string;
  group: AccessGroupConfig;
  channel: ChannelId;
  accountId: string;
  senderId: string;
}) => boolean | Promise<boolean>;

export type AccessGroupMembershipLookup = (params: {
  name: string;
  group: AccessGroupConfig;
  channel: ChannelId;
  accountId: string;
  senderId: string;
}) => boolean | Promise<boolean>;

export type ResolvedAccessGroupAllowFromState = {
  referenced: string[];
  matched: string[];
  missing: string[];
  unsupported: string[];
  failed: string[];
  matchedAllowFromEntries: string[];
  hasReferences: boolean;
  hasMatch: boolean;
};

function resolveMessageSenderGroupEntries(params: {
  group: AccessGroupConfig;
  channel: ChannelId;
}): string[] {
  if (params.group.type !== "message.senders") {
    return [];
  }
  return [...(params.group.members["*"] ?? []), ...(params.group.members[params.channel] ?? [])];
}

export async function resolveAccessGroupAllowFromState(params: {
  accessGroups?: Record<string, AccessGroupConfig>;
  allowFrom: Array<string | number> | null | undefined;
  channel: ChannelId;
  accountId: string;
  senderId: string;
  isSenderAllowed?: (senderId: string, allowFrom: string[]) => boolean;
  resolveMembership?: AccessGroupMembershipLookup;
}): Promise<ResolvedAccessGroupAllowFromState> {
  const names = Array.from(
    new Set(
      (params.allowFrom ?? [])
        .map((entry) => parseAccessGroupAllowFromEntry(String(entry)))
        .filter((entry): entry is string => entry != null),
    ),
  );
  const state: ResolvedAccessGroupAllowFromState = {
    referenced: names,
    matched: [],
    missing: [],
    unsupported: [],
    failed: [],
    matchedAllowFromEntries: [],
    hasReferences: names.length > 0,
    hasMatch: false,
  };
  const groups = params.accessGroups;
  for (const name of names) {
    const group = groups?.[name];
    if (!group) {
      state.missing.push(name);
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
      state.matched.push(name);
      continue;
    }

    if (!params.resolveMembership) {
      if (group.type !== "message.senders") {
        state.unsupported.push(name);
      }
      continue;
    }

    let allowed = false;
    try {
      allowed = await params.resolveMembership({
        name,
        group,
        channel: params.channel,
        accountId: params.accountId,
        senderId: params.senderId,
      });
    } catch {
      state.failed.push(name);
      continue;
    }
    if (allowed) {
      state.matched.push(name);
    }
  }
  state.matchedAllowFromEntries = state.matched.map(
    (name) => `${ACCESS_GROUP_ALLOW_FROM_PREFIX}${name}`,
  );
  state.hasMatch = state.matchedAllowFromEntries.length > 0;
  return state;
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
  const resolveMembership = params.resolveMembership;
  const state = await resolveAccessGroupAllowFromState({
    accessGroups: cfg?.accessGroups,
    allowFrom: params.allowFrom,
    channel: params.channel,
    accountId: params.accountId,
    senderId: params.senderId,
    isSenderAllowed: params.isSenderAllowed,
    resolveMembership:
      resolveMembership && cfg
        ? async (lookupParams) =>
            await resolveMembership({
              cfg,
              ...lookupParams,
            })
        : undefined,
  });
  return state.matchedAllowFromEntries;
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
