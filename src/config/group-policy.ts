import type { ChannelId } from "../channels/plugins/channel-id.types.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import {
  parseToolsBySenderTypedKey,
  type GroupToolPolicyBySenderConfig,
  type GroupToolPolicyConfig,
  type ToolsBySenderKeyType,
} from "./types.tools.js";

export type GroupPolicyChannel = ChannelId;

export type ChannelGroupConfig = {
  requireMention?: boolean;
  ingest?: boolean;
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
};

export type ChannelGroupPolicy = {
  allowlistEnabled: boolean;
  allowed: boolean;
  groupConfig?: ChannelGroupConfig;
  defaultConfig?: ChannelGroupConfig;
};

type ChannelGroups = Record<string, ChannelGroupConfig>;

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

export type GroupToolPolicySender = {
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
};

type SenderKeyType = "id" | "e164" | "username" | "name";
type CompiledSenderPolicy = {
  buckets: SenderPolicyBuckets;
  wildcard?: GroupToolPolicyConfig;
};

const warnedLegacyToolsBySenderKeys = new Set<string>();
const compiledToolsBySenderCache = new WeakMap<
  GroupToolPolicyBySenderConfig,
  CompiledSenderPolicy
>();

type ParsedSenderPolicyKey =
  | { kind: "wildcard" }
  | { kind: "typed"; type: SenderKeyType; key: string };

type SenderPolicyBuckets = Record<ToolsBySenderKeyType, Map<string, GroupToolPolicyConfig>>;

function normalizeSenderKey(
  value: string,
  options: {
    stripLeadingAt?: boolean;
  } = {},
): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const withoutAt = options.stripLeadingAt && trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  return normalizeLowercaseStringOrEmpty(withoutAt);
}

function normalizeTypedSenderKey(value: string, type: SenderKeyType): string {
  return normalizeSenderKey(value, {
    stripLeadingAt: type === "username",
  });
}

function normalizeLegacySenderKey(value: string): string {
  return normalizeSenderKey(value, {
    stripLeadingAt: true,
  });
}

function warnLegacyToolsBySenderKey(rawKey: string) {
  const trimmed = rawKey.trim();
  if (!trimmed || warnedLegacyToolsBySenderKeys.has(trimmed)) {
    return;
  }
  warnedLegacyToolsBySenderKeys.add(trimmed);
  process.emitWarning(
    `toolsBySender key "${trimmed}" is deprecated. Use explicit prefixes (id:, e164:, username:, name:). Legacy unprefixed keys are matched as id only.`,
    {
      type: "DeprecationWarning",
      code: "OPENCLAW_TOOLS_BY_SENDER_UNTYPED_KEY",
    },
  );
}

function parseSenderPolicyKey(rawKey: string): ParsedSenderPolicyKey | undefined {
  const trimmed = rawKey.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "*") {
    return { kind: "wildcard" };
  }
  const typed = parseToolsBySenderTypedKey(trimmed);
  if (typed) {
    const key = normalizeTypedSenderKey(typed.value, typed.type);
    if (!key) {
      return undefined;
    }
    return {
      kind: "typed",
      type: typed.type,
      key,
    };
  }

  // Backward-compatible fallback: untyped keys now map to immutable sender IDs only.
  warnLegacyToolsBySenderKey(trimmed);
  const key = normalizeLegacySenderKey(trimmed);
  if (!key) {
    return undefined;
  }
  return {
    kind: "typed",
    type: "id",
    key,
  };
}

function createSenderPolicyBuckets(): SenderPolicyBuckets {
  return {
    id: new Map<string, GroupToolPolicyConfig>(),
    e164: new Map<string, GroupToolPolicyConfig>(),
    username: new Map<string, GroupToolPolicyConfig>(),
    name: new Map<string, GroupToolPolicyConfig>(),
  };
}

function compileToolsBySenderPolicy(
  toolsBySender: GroupToolPolicyBySenderConfig,
): CompiledSenderPolicy | undefined {
  const entries = Object.entries(toolsBySender);
  if (entries.length === 0) {
    return undefined;
  }

  const buckets = createSenderPolicyBuckets();
  let wildcard: GroupToolPolicyConfig | undefined;
  for (const [rawKey, policy] of entries) {
    if (!policy) {
      continue;
    }
    const parsed = parseSenderPolicyKey(rawKey);
    if (!parsed) {
      continue;
    }
    if (parsed.kind === "wildcard") {
      wildcard = policy;
      continue;
    }
    const bucket = buckets[parsed.type];
    if (!bucket.has(parsed.key)) {
      bucket.set(parsed.key, policy);
    }
  }

  return { buckets, wildcard };
}

function resolveCompiledToolsBySenderPolicy(
  toolsBySender: GroupToolPolicyBySenderConfig,
): CompiledSenderPolicy | undefined {
  const cached = compiledToolsBySenderCache.get(toolsBySender);
  if (cached) {
    return cached;
  }
  const compiled = compileToolsBySenderPolicy(toolsBySender);
  if (!compiled) {
    return undefined;
  }
  // Config is loaded once and treated as immutable; cache compiled sender policy by object identity.
  compiledToolsBySenderCache.set(toolsBySender, compiled);
  return compiled;
}

function normalizeCandidate(value: string | null | undefined, type: SenderKeyType): string {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return "";
  }
  return normalizeTypedSenderKey(trimmed, type);
}

function normalizeSenderIdCandidates(value: string | null | undefined): string[] {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return [];
  }
  const typed = normalizeTypedSenderKey(trimmed, "id");
  const legacy = normalizeLegacySenderKey(trimmed);
  if (!typed) {
    return legacy ? [legacy] : [];
  }
  if (!legacy || legacy === typed) {
    return [typed];
  }
  return [typed, legacy];
}

function matchToolsBySenderPolicy(
  compiled: CompiledSenderPolicy,
  params: GroupToolPolicySender,
): GroupToolPolicyConfig | undefined {
  for (const senderIdCandidate of normalizeSenderIdCandidates(params.senderId)) {
    const match = compiled.buckets.id.get(senderIdCandidate);
    if (match) {
      return match;
    }
  }
  const senderE164 = normalizeCandidate(params.senderE164, "e164");
  if (senderE164) {
    const match = compiled.buckets.e164.get(senderE164);
    if (match) {
      return match;
    }
  }
  const senderUsername = normalizeCandidate(params.senderUsername, "username");
  if (senderUsername) {
    const match = compiled.buckets.username.get(senderUsername);
    if (match) {
      return match;
    }
  }
  const senderName = normalizeCandidate(params.senderName, "name");
  if (senderName) {
    const match = compiled.buckets.name.get(senderName);
    if (match) {
      return match;
    }
  }
  return compiled.wildcard;
}

export function resolveToolsBySender(
  params: {
    toolsBySender?: GroupToolPolicyBySenderConfig;
  } & GroupToolPolicySender,
): GroupToolPolicyConfig | undefined {
  const toolsBySender = params.toolsBySender;
  if (!toolsBySender) {
    return undefined;
  }
  const compiled = resolveCompiledToolsBySenderPolicy(toolsBySender);
  if (!compiled) {
    return undefined;
  }
  return matchToolsBySenderPolicy(compiled, params);
}

function resolveChannelGroups(
  cfg: OpenClawConfig,
  channel: GroupPolicyChannel,
  accountId?: string | null,
): ChannelGroups | undefined {
  const normalizedAccountId = normalizeAccountId(accountId);
  const channelConfig = cfg.channels?.[channel] as
    | {
        accounts?: Record<string, { groups?: ChannelGroups }>;
        groups?: ChannelGroups;
      }
    | undefined;
  if (!channelConfig) {
    return undefined;
  }
  const accountGroups = resolveAccountEntry(channelConfig.accounts, normalizedAccountId)?.groups;
  return accountGroups ?? channelConfig.groups;
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

export function resolveChannelGroupRequireMention(params: {
  cfg: OpenClawConfig;
  channel: GroupPolicyChannel;
  groupId?: string | null;
  accountId?: string | null;
  groupIdCaseInsensitive?: boolean;
  requireMentionOverride?: boolean;
  overrideOrder?: "before-config" | "after-config";
}): boolean {
  const { requireMentionOverride, overrideOrder = "after-config" } = params;
  const { groupConfig, defaultConfig } = resolveChannelGroupPolicy(params);
  const configMention =
    typeof groupConfig?.requireMention === "boolean"
      ? groupConfig.requireMention
      : typeof defaultConfig?.requireMention === "boolean"
        ? defaultConfig.requireMention
        : undefined;

  if (overrideOrder === "before-config" && typeof requireMentionOverride === "boolean") {
    return requireMentionOverride;
  }
  if (typeof configMention === "boolean") {
    return configMention;
  }
  if (overrideOrder !== "before-config" && typeof requireMentionOverride === "boolean") {
    return requireMentionOverride;
  }
  return true;
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
  const defaultConfig = groups?.["*"];
  const groupSenderPolicy = resolveToolsBySender({
    toolsBySender: groupConfig?.toolsBySender,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  if (groupSenderPolicy) {
    return groupSenderPolicy;
  }
  if (groupConfig?.tools) {
    return groupConfig.tools;
  }
  const defaultSenderPolicy = resolveToolsBySender({
    toolsBySender: defaultConfig?.toolsBySender,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  if (defaultSenderPolicy) {
    return defaultSenderPolicy;
  }
  if (defaultConfig?.tools) {
    return defaultConfig.tools;
  }
  return undefined;
}
