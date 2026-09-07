import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ChannelId } from "../channels/plugins/channel-id.types.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import {
  resolveChannelGroups,
  type ChannelGroupConfig,
  type ChannelGroups,
} from "./channel-groups.js";
import {
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  type ScopeNode,
  type ScopePath,
  type ScopeTree,
} from "./group-scope-tree.js";
import type { GroupToolPolicySender } from "./tools-by-sender.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import type { GroupToolPolicyConfig } from "./types.tools.js";

export { resolveChannelGroups } from "./channel-groups.js";
export { resolveToolsBySender } from "./tools-by-sender.js";

type GroupPolicyChannel = ChannelId;

export type ChannelGroupPolicy = {
  allowlistEnabled: boolean;
  allowed: boolean;
  groupConfig?: ChannelGroupConfig;
  defaultConfig?: ChannelGroupConfig;
};

function resolveChannelGroupConfig(
  groups: ChannelGroups | undefined,
  groupId: string,
  caseInsensitive = false,
): ChannelGroupConfig | undefined {
  if (!groups) {
    return undefined;
  }
  const direct = groups[groupId];
  if (direct) {
    return direct;
  }
  if (!caseInsensitive) {
    return undefined;
  }
  const target = normalizeLowercaseStringOrEmpty(groupId);
  const matchedKey = Object.keys(groups).find(
    (key) => key !== "*" && normalizeLowercaseStringOrEmpty(key) === target,
  );
  if (!matchedKey) {
    return undefined;
  }
  return groups[matchedKey];
}

/** Locate the authored map selected by the channel owner without changing its inheritance rules. */
export function resolveChannelGroupsConfigPath(params: {
  cfg: OpenClawConfig;
  channel: GroupPolicyChannel;
  accountId?: string | null;
  groups: Readonly<Record<string, unknown>> | undefined;
}): string {
  const rootPath = `channels.${params.channel}.groups`;
  // SAFETY: Validated channel groups retain the original map reference selected by the caller.
  const channelConfig = params.cfg.channels?.[params.channel] as
    | { accounts?: Record<string, { groups?: Readonly<Record<string, unknown>> }> }
    | undefined;
  const accounts = channelConfig?.accounts;
  if (!accounts) {
    return rootPath;
  }
  const accountId = normalizeAccountId(params.accountId);
  const account = resolveAccountEntry(accounts, accountId);
  // Account merging preserves map references. Use the owner's selected map so
  // empty-map inheritance and shallow replacement both retain their exact scope.
  if (!account || (params.groups !== undefined && params.groups !== account.groups)) {
    return rootPath;
  }
  const accountKey = Object.hasOwn(accounts, accountId)
    ? accountId
    : Object.keys(accounts).find((key) => accounts[key] === account);
  return accountKey
    ? `channels.${params.channel}.accounts[${JSON.stringify(accountKey)}].groups`
    : rootPath;
}

type ChannelGroupPolicyMode = "open" | "allowlist" | "disabled";

function resolveChannelGroupPolicyMode(
  cfg: OpenClawConfig,
  channel: GroupPolicyChannel,
  accountId?: string | null,
): ChannelGroupPolicyMode | undefined {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = cfg.channels?.[channel] as
    | {
        groupPolicy?: ChannelGroupPolicyMode;
        accounts?: Record<string, { groupPolicy?: ChannelGroupPolicyMode }>;
      }
    | undefined;
  if (!channelConfig) {
    return undefined;
  }
  const accountPolicy = resolveAccountEntry(
    channelConfig.accounts,
    normalizedAccountId,
  )?.groupPolicy;
  return accountPolicy ?? channelConfig.groupPolicy;
}

export function resolveChannelGroupPolicy(params: {
  cfg: OpenClawConfig;
  channel: GroupPolicyChannel;
  groupId?: string | null;
  accountId?: string | null;
  groupIdCaseInsensitive?: boolean;
  /** When true, sender-level filtering (groupAllowFrom) is configured upstream. */
  hasGroupAllowFrom?: boolean;
}): ChannelGroupPolicy {
  const { cfg, channel } = params;
  const groups = resolveChannelGroups(cfg, channel, params.accountId);
  const groupPolicy = resolveChannelGroupPolicyMode(cfg, channel, params.accountId);
  const hasGroups = Boolean(groups && Object.keys(groups).length > 0);
  const allowlistEnabled = groupPolicy === "allowlist" || hasGroups;
  const normalizedId = params.groupId?.trim();
  const groupConfig = normalizedId
    ? resolveChannelGroupConfig(groups, normalizedId, params.groupIdCaseInsensitive)
    : undefined;
  const defaultConfig = groups?.["*"];
  const allowAll = allowlistEnabled && Boolean(groups && Object.hasOwn(groups, "*"));
  // When groupPolicy is "allowlist" with groupAllowFrom but no explicit groups,
  // allow the group through — sender-level filtering handles access control.
  const senderFilterBypass =
    groupPolicy === "allowlist" && !hasGroups && Boolean(params.hasGroupAllowFrom);
  const allowed =
    groupPolicy === "disabled"
      ? false
      : !allowlistEnabled || allowAll || Boolean(groupConfig) || senderFilterBypass;
  return {
    allowlistEnabled,
    allowed,
    groupConfig,
    defaultConfig,
  };
}

function buildSelectedGroupScope(
  groupConfig: ChannelGroupConfig | undefined,
  defaultConfig: ChannelGroupConfig | undefined,
): { tree: ScopeTree; path: ScopePath } {
  // Flat lookup selects one whole entry, including an explicitly requested "*".
  // Preserve its boolean/truthy fallback rules without changing native scope callers.
  const project = (node: ChannelGroupConfig): ScopeNode => ({
    requireMention: typeof node.requireMention === "boolean" ? node.requireMention : undefined,
    tools: node.tools || undefined,
    toolsBySender: node.toolsBySender,
  });
  return {
    tree: {
      scopes: groupConfig ? { selected: project(groupConfig) } : {},
      defaults: defaultConfig ? project(defaultConfig) : undefined,
    },
    path: groupConfig ? ["selected"] : [],
  };
}

export function resolveChannelGroupRequireMention(params: {
  cfg: OpenClawConfig;
  channel: GroupPolicyChannel;
  groupId?: string | null;
  accountId?: string | null;
  groupIdCaseInsensitive?: boolean;
  requireMentionOverride?: boolean;
  configuredGroupDefaultsToNoMention?: boolean;
  overrideOrder?: "before-config" | "after-config";
}): boolean {
  const { groupConfig, defaultConfig } = resolveChannelGroupPolicy(params);
  return resolveScopeRequireMention({
    ...buildSelectedGroupScope(groupConfig, defaultConfig),
    requireMentionOverride: params.requireMentionOverride,
    overrideOrder: params.overrideOrder,
    configuredScopeDefaultsToNoMention: params.configuredGroupDefaultsToNoMention,
  });
}

export function resolveChannelGroupToolsPolicy(
  params: {
    cfg: OpenClawConfig;
    channel: GroupPolicyChannel;
    groupId?: string | null;
    groupIdCandidates?: Array<string | null | undefined>;
    accountId?: string | null;
    groupIdCaseInsensitive?: boolean;
  } & GroupToolPolicySender,
): GroupToolPolicyConfig | undefined {
  const groups = resolveChannelGroups(params.cfg, params.channel, params.accountId);
  const groupIds = [
    params.groupId,
    ...(Array.isArray(params.groupIdCandidates) ? params.groupIdCandidates : []),
  ];
  let groupConfig: ChannelGroupConfig | undefined;
  for (const rawGroupId of groupIds) {
    const groupId = rawGroupId?.trim();
    if (!groupId) {
      continue;
    }
    // Scoped ids can collapse to a parent group; try all exact matches before wildcard fallback.
    groupConfig = resolveChannelGroupConfig(groups, groupId, params.groupIdCaseInsensitive);
    if (groupConfig) {
      break;
    }
  }
  return resolveScopeToolsPolicy({
    ...params,
    ...buildSelectedGroupScope(groupConfig, groups?.["*"]),
    messageProvider: params.messageProvider ?? params.channel,
  });
}
