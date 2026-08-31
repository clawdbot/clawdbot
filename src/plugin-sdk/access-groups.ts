// Access group helpers resolve plugin allowlists that reference named config groups.
import { uniqueStrings } from "../../packages/normalization-core/src/string-normalization.js";
import {
  ACCESS_GROUP_ALLOW_FROM_PREFIX,
  parseAccessGroupAllowFromEntry,
} from "../channels/allow-from.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { AccessGroupConfig } from "../config/types.access-groups.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export { ACCESS_GROUP_ALLOW_FROM_PREFIX, parseAccessGroupAllowFromEntry };

/** Resolves membership for an access group using the full OpenClaw config. */
export type AccessGroupMembershipResolver = (params: {
  /** Full config, available when membership needs cross-channel or provider state. */
  cfg: OpenClawConfig;
  /** Access group name referenced by `accessGroup:<name>`. */
  name: string;
  /** Access group config selected by name. */
  group: AccessGroupConfig;
  /** Channel where the inbound sender is being checked. */
  channel: ChannelId;
  /** Channel account id for account-scoped membership checks. */
  accountId: string;
  /** Inbound sender id or handle being authorized. */
  senderId: string;
}) => boolean | Promise<boolean>;

/** Resolves membership for one access group when the caller already selected the config group. */
export type AccessGroupMembershipLookup = (params: {
  /** Access group name referenced by `accessGroup:<name>`. */
  name: string;
  /** Access group config selected by name. */
  group: AccessGroupConfig;
  /** Channel where the inbound sender is being checked. */
  channel: ChannelId;
  /** Channel account id for account-scoped membership checks. */
  accountId: string;
  /** Inbound sender id or handle being authorized. */
  senderId: string;
}) => boolean | Promise<boolean>;

/** Reports how access-group allowlist entries resolved for a channel sender. */
export type ResolvedAccessGroupAllowFromState = {
  /** Unique access group names referenced by the allowlist. */
  referenced: string[];
  /** Referenced groups that authorized the sender. */
  matched: string[];
  /** Referenced groups absent from config. */
  missing: string[];
  /** Referenced groups whose type cannot be evaluated without a resolver. */
  unsupported: string[];
  /** Referenced groups whose resolver threw. */
  failed: string[];
  /** Matched allowlist entries in `accessGroup:<name>` form. */
  matchedAllowFromEntries: string[];
  /** Whether the input allowlist referenced at least one access group. */
  hasReferences: boolean;
  /** Whether at least one referenced group authorized the sender. */
  hasMatch: boolean;
};

/** Resolve the concrete sender allowlist entries for static message-sender groups. */
function resolveMessageSenderGroupEntries(params: {
  group: AccessGroupConfig;
  channel: ChannelId;
}): string[] {
  if (params.group.type !== "message.senders") {
    return [];
  }
  return [...(params.group.members["*"] ?? []), ...(params.group.members[params.channel] ?? [])];
}

/** Resolves `accessGroup:<name>` allowlist entries without changing the original allowlist. */
export async function resolveAccessGroupAllowFromState(params: {
  /** Configured access groups keyed by name. */
  accessGroups?: Record<string, AccessGroupConfig>;
  /** Raw allowlist entries that may include `accessGroup:<name>` references. */
  allowFrom: Array<string | number> | null | undefined;
  /** Channel where the inbound sender is being checked. */
  channel: ChannelId;
  /** Channel account id for account-scoped membership checks. */
  accountId: string;
  /** Inbound sender id or handle being authorized. */
  senderId: string;
  /** Static sender matcher used for `message.senders` groups. */
  isSenderAllowed?: (senderId: string, allowFrom: string[]) => boolean;
  /** Optional resolver for non-static or integration-backed group types. */
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

    // Static sender groups are fully decided above; resolver hooks cover future
    // group types or integration-backed membership without rechecking static entries.
    if (!params.resolveMembership) {
      if (group.type !== "message.senders") {
        state.unsupported.push(name);
      }
      continue;
    }

    let allowed;
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

/** Returns the matched `accessGroup:<name>` allowlist entries for a sender. */
export async function resolveAccessGroupAllowFromMatches(params: {
  /** Full config containing `accessGroups`. */
  cfg?: OpenClawConfig;
  /** Raw allowlist entries that may include `accessGroup:<name>` references. */
  allowFrom: Array<string | number> | null | undefined;
  /** Channel where the inbound sender is being checked. */
  channel: ChannelId;
  /** Channel account id for account-scoped membership checks. */
  accountId: string;
  /** Inbound sender id or handle being authorized. */
  senderId: string;
  /** Static sender matcher used for `message.senders` groups. */
  isSenderAllowed?: (senderId: string, allowFrom: string[]) => boolean;
  /** Optional resolver for non-static or integration-backed group types. */
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

/** Expands a matching access-group allowlist with the concrete sender entry. */
export async function expandAllowFromWithAccessGroups(params: {
  /** Full config containing `accessGroups`. */
  cfg?: OpenClawConfig;
  /** Raw allowlist entries that may include `accessGroup:<name>` references. */
  allowFrom: Array<string | number> | null | undefined;
  /** Channel where the inbound sender is being checked. */
  channel: ChannelId;
  /** Channel account id for account-scoped membership checks. */
  accountId: string;
  /** Inbound sender id or handle being authorized. */
  senderId: string;
  /** Concrete allowlist entry appended after a group match; defaults to `senderId`. */
  senderAllowEntry?: string;
  /** Static sender matcher used for `message.senders` groups. */
  isSenderAllowed?: (senderId: string, allowFrom: string[]) => boolean;
  /** Optional resolver for non-static or integration-backed group types. */
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
  // Downstream legacy sender checks still expect a concrete allowlist entry after a group match.
  return uniqueStrings([...allowFrom, senderEntry]);
}
