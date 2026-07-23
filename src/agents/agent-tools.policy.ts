/**
 * Resolves sandbox tool policies for agents, providers, sub-agents, and group
 * sessions. Keeps runtime tool filtering tied to canonical config, session
 * provenance, and inherited sub-agent capabilities.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  normalizeUniqueSingleOrTrimmedStringList,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import { resolveSessionConversation } from "../channels/plugins/session-conversation.js";
import { resolveChannelGroupToolsPolicy } from "../config/group-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import { logWarn } from "../logger.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/account-id.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import {
  parseRawSessionConversationRef,
  parseThreadSessionSuffix,
} from "../sessions/session-key-utils.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { listAgentEntries, resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope.js";
import { resolveProviderToolPolicy } from "./provider-tool-policy.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import type { SandboxToolPolicy } from "./sandbox.js";
import { resolveSandboxToolPolicyForAgent } from "./sandbox/tool-policy.js";
import {
  resolveSubagentCapabilityStore,
  resolveStoredSubagentInheritedToolAllowlist,
  resolveStoredSubagentInheritedToolDenylist,
  resolveStoredSubagentCapabilities,
  type SessionCapabilityStore,
  type SubagentSessionRole,
} from "./subagent-capabilities.js";
import { isToolAllowedByPolicyName } from "./tool-policy-match.js";
import {
  mergeAlsoAllowPolicy,
  normalizeToolName,
  resolveToolProfilePolicy,
} from "./tool-policy.js";

export { resolveProviderToolPolicy };

/**
 * Tools always denied for sub-agents regardless of depth.
 * These are system-level or interactive tools that sub-agents should never use.
 */
const SUBAGENT_TOOL_DENY_ALWAYS = [
  // System admin - dangerous from subagent
  "gateway",
  "agents_list",
  // Status/scheduling - main agent coordinates
  "session_status",
  "cron",
  // Direct session sends - subagents communicate through announce chain
  "sessions_send",
  "conversations_list",
  "conversations_send",
  "conversations_turn",
];

/** Tools that only make sense for orchestrator sub-agents that can spawn children. */
const SUBAGENT_TOOL_DENY_LEAF = [
  "subagents",
  "sessions_list",
  "sessions_history",
  "sessions_search",
  "sessions_spawn",
];

function resolveSubagentDenyListForRole(role: SubagentSessionRole): string[] {
  if (role === "leaf") {
    return [...SUBAGENT_TOOL_DENY_ALWAYS, ...SUBAGENT_TOOL_DENY_LEAF];
  }
  return [...SUBAGENT_TOOL_DENY_ALWAYS];
}

function mergeConfiguredSubagentAllow(
  allow: string[] | undefined,
  alsoAllow: string[] | undefined,
): string[] | undefined {
  return allow && alsoAllow ? uniqueStrings([...allow, ...alsoAllow]) : allow;
}

/** Resolve sub-agent tool policy from stored session capabilities. */
export function resolveSubagentToolPolicyForSession(
  cfg: OpenClawConfig | undefined,
  sessionKey: string,
  opts?: {
    store?: SessionCapabilityStore;
  },
): SandboxToolPolicy {
  const configured = cfg?.tools?.subagents?.tools;
  const store = resolveSubagentCapabilityStore(sessionKey, {
    cfg,
    store: opts?.store,
  });
  const capabilities = resolveStoredSubagentCapabilities(sessionKey, {
    cfg,
    store,
  });
  const allow = Array.isArray(configured?.allow) ? configured.allow : undefined;
  const alsoAllow = Array.isArray(configured?.alsoAllow) ? configured.alsoAllow : undefined;
  const explicitAllow = new Set(
    [...(allow ?? []), ...(alsoAllow ?? [])].map((toolName) => normalizeToolName(toolName)),
  );
  const deny = [
    ...resolveSubagentDenyListForRole(capabilities.role).filter(
      (toolName) => !explicitAllow.has(normalizeToolName(toolName)),
    ),
    ...(Array.isArray(configured?.deny) ? configured.deny : []),
  ];
  const mergedAllow = mergeConfiguredSubagentAllow(allow, alsoAllow);
  return { allow: mergedAllow, deny };
}

/** Resolve the tool policy inherited from a parent sub-agent session. */
export function resolveInheritedToolPolicyForSession(
  cfg: OpenClawConfig | undefined,
  sessionKey: string | undefined | null,
  opts?: {
    store?: SessionCapabilityStore;
  },
): SandboxToolPolicy | undefined {
  const inheritedToolAllow = resolveStoredSubagentInheritedToolAllowlist(sessionKey, {
    cfg,
    store: opts?.store,
  });
  const inheritedToolDeny = resolveStoredSubagentInheritedToolDenylist(sessionKey, {
    cfg,
    store: opts?.store,
  });
  if (inheritedToolAllow.length === 0 && inheritedToolDeny.length === 0) {
    return undefined;
  }
  return {
    ...(inheritedToolAllow.length > 0 ? { allow: inheritedToolAllow } : {}),
    ...(inheritedToolDeny.length > 0 ? { deny: inheritedToolDeny } : {}),
  };
}

/** Filter runtime tools by sandbox allow/deny policy. */
export function filterToolsByPolicy<TTool extends { name: string }>(
  tools: TTool[],
  policy?: SandboxToolPolicy,
): TTool[] {
  if (!policy) {
    return tools;
  }
  return tools.filter((tool) => isToolAllowedByPolicyName(tool.name, policy));
}

/** Resolve the shared profile, scope, extra, and sandbox policy layers. */
export function resolveConfiguredToolPolicies(params: {
  cfg: OpenClawConfig;
  agentTools?: AgentToolsConfig;
  sandboxMode?: "off" | "non-main" | "all";
  agentId?: string | null;
  extraPolicies?: readonly (SandboxToolPolicy | undefined)[];
}): SandboxToolPolicy[] {
  const policies: SandboxToolPolicy[] = [];
  const profile = params.agentTools?.profile ?? params.cfg.tools?.profile;
  const profileAlsoAllow =
    resolveExplicitProfileAlsoAllow(params.agentTools) ??
    resolveExplicitProfileAlsoAllow(params.cfg.tools);
  const profilePolicy = mergeAlsoAllowPolicy(resolveToolProfilePolicy(profile), profileAlsoAllow);
  if (profilePolicy) {
    policies.push(profilePolicy);
  }

  const globalPolicy = pickSandboxToolPolicy(params.cfg.tools ?? undefined);
  if (globalPolicy) {
    policies.push(globalPolicy);
  }

  const agentPolicy = pickSandboxToolPolicy(params.agentTools);
  if (agentPolicy) {
    policies.push(agentPolicy);
  }

  for (const policy of params.extraPolicies ?? []) {
    if (policy) {
      policies.push(policy);
    }
  }

  if (params.sandboxMode === "all") {
    policies.push(resolveSandboxToolPolicyForAgent(params.cfg, params.agentId ?? undefined));
  }

  return policies;
}

function collectUniqueStrings(values: Array<string | null | undefined>): string[] {
  return normalizeUniqueSingleOrTrimmedStringList(values);
}

function buildScopedGroupIdCandidates(groupId?: string | null): string[] {
  const raw = groupId?.trim();
  if (!raw) {
    return [];
  }
  const topicSenderMatch = raw.match(/^(.+):topic:([^:]+):sender:([^:]+)$/i);
  if (topicSenderMatch) {
    const [, chatId, topicId] = topicSenderMatch;
    // Sender-scoped sessions still inherit topic/base group tool policies.
    return collectUniqueStrings([raw, `${chatId}:topic:${topicId}`, chatId]);
  }
  const topicMatch = raw.match(/^(.+):topic:([^:]+)$/i);
  if (topicMatch) {
    const [, chatId, topicId] = topicMatch;
    return collectUniqueStrings([`${chatId}:topic:${topicId}`, chatId]);
  }
  const senderMatch = raw.match(/^(.+):sender:([^:]+)$/i);
  if (senderMatch) {
    const [, chatId] = senderMatch;
    return collectUniqueStrings([raw, chatId]);
  }
  return [raw];
}

function resolveGroupContextFromSessionKey(sessionKey?: string | null): {
  channel?: string;
  groupIds?: string[];
} {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return {};
  }
  const { baseSessionKey, threadId } = parseThreadSessionSuffix(raw);
  const conversationKey = threadId ? baseSessionKey : raw;
  const conversation = parseRawSessionConversationRef(conversationKey);
  if (conversation) {
    const resolvedConversation = resolveSessionConversation({
      channel: conversation.channel,
      kind: conversation.kind,
      rawId: conversation.rawId,
    });
    return {
      channel: conversation.channel,
      groupIds: collectUniqueStrings([
        ...buildScopedGroupIdCandidates(conversation.rawId),
        resolvedConversation?.id,
        resolvedConversation?.baseConversationId,
        ...(resolvedConversation?.parentConversationCandidates ?? []),
      ]),
    };
  }
  const base = conversationKey ?? raw;
  const parts = base.split(":").filter(Boolean);
  let body = parts[0] === "agent" ? parts.slice(2) : parts;
  if (body[0] === "subagent") {
    body = body.slice(1);
  }
  if (body.length < 3) {
    return {};
  }
  const [channel, kind, ...rest] = body;
  if (kind !== "group" && kind !== "channel") {
    return {};
  }
  const groupId = rest.join(":").trim();
  if (!groupId) {
    return {};
  }
  return {
    channel: normalizeLowercaseStringOrEmpty(channel),
    groupIds: buildScopedGroupIdCandidates(groupId),
  };
}

type GroupToolPolicyContext = ReturnType<typeof resolveGroupContextFromSessionKey>;

function resolveTrustedGroupIdFromContexts(params: {
  groupId?: string | null;
  sessionContext: GroupToolPolicyContext;
  spawnedContext: GroupToolPolicyContext;
}): {
  groupId: string | null | undefined;
  dropped: boolean;
} {
  const callerGroupId = (params.groupId ?? "").trim();
  if (!callerGroupId) {
    return { groupId: params.groupId, dropped: false };
  }
  const trustedGroupIds = collectUniqueStrings([
    ...(params.sessionContext.groupIds ?? []),
    ...(params.spawnedContext.groupIds ?? []),
  ]);
  // Fail closed when no server-derived session/spawn context can vouch for the
  // caller group id. Non-group sessions must not opt into group-scoped tool
  // policy by supplying an arbitrary groupId.
  if (trustedGroupIds.length === 0) {
    return { groupId: null, dropped: true };
  }
  if (trustedGroupIds.includes(callerGroupId)) {
    return { groupId: params.groupId, dropped: false };
  }
  return { groupId: null, dropped: true };
}

/** Validate caller-supplied group ids against server-derived session context. */
export function resolveTrustedGroupId(params: {
  groupId?: string | null;
  sessionKey?: string | null;
  spawnedBy?: string | null;
}): {
  groupId: string | null | undefined;
  dropped: boolean;
} {
  return resolveTrustedGroupIdFromContexts({
    groupId: params.groupId,
    sessionContext: resolveGroupContextFromSessionKey(params.sessionKey),
    spawnedContext: resolveGroupContextFromSessionKey(params.spawnedBy),
  });
}

/** True when a server-derived session key names a group/channel conversation. */
export function sessionKeyNamesGroupConversation(sessionKey?: string | null): boolean {
  return (resolveGroupContextFromSessionKey(sessionKey).groupIds?.length ?? 0) > 0;
}

function resolveExplicitProfileAlsoAllow(tools?: OpenClawConfig["tools"]): string[] | undefined {
  return Array.isArray(tools?.alsoAllow) ? tools.alsoAllow : undefined;
}

function hasExplicitToolSection(section: unknown): boolean {
  return section !== undefined && section !== null;
}

/** Detect tool config sections that previously widened profiles implicitly.
 *  Used only for migration warnings — not merged into profileAlsoAllow.  #47487 */
type ImplicitProfileGrantDetection = {
  entries: Array<{ section: string; grants: string[] }>;
};

function detectImplicitProfileGrants(params: {
  globalTools?: OpenClawConfig["tools"];
  agentTools?: AgentToolsConfig;
  includeGlobalSections: boolean;
}): ImplicitProfileGrantDetection | undefined {
  const entries: ImplicitProfileGrantDetection["entries"] = [];
  if (
    hasExplicitToolSection(params.agentTools?.exec) ||
    (params.includeGlobalSections && hasExplicitToolSection(params.globalTools?.exec))
  ) {
    entries.push({ section: "tools.exec", grants: ["exec", "process"] });
  }
  if (
    hasExplicitToolSection(params.agentTools?.fs) ||
    (params.includeGlobalSections && hasExplicitToolSection(params.globalTools?.fs))
  ) {
    entries.push({ section: "tools.fs", grants: ["read", "write", "edit"] });
  }
  if (entries.length === 0) {
    return undefined;
  }
  return { entries };
}

function formatImplicitToolSections(sections: string[]): string {
  return sections.join(" / ");
}

function formatToolListForWarning(toolNames: string[]): string {
  return toolNames.map((toolName) => `"${toolName}"`).join(", ");
}

/** Resolve the layered global, provider, agent, and profile tool policies. */
export function resolveEffectiveToolPolicy(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  modelProvider?: string;
  modelId?: string;
}) {
  const explicitAgentId =
    typeof params.agentId === "string" && params.agentId.trim()
      ? normalizeAgentId(params.agentId)
      : undefined;
  const agentId =
    explicitAgentId ??
    (params.sessionKey ? parseAgentSessionKey(params.sessionKey)?.agentId : undefined) ??
    (params.config && listAgentEntries(params.config).length > 0
      ? resolveDefaultAgentId(params.config)
      : undefined);
  const agentConfig =
    params.config && agentId ? resolveAgentConfig(params.config, agentId) : undefined;
  const agentTools = agentConfig?.tools;
  const globalTools = params.config?.tools;

  const profile = agentTools?.profile ?? globalTools?.profile;
  const profileSource = agentTools?.profile ? "agent" : globalTools?.profile ? "global" : undefined;
  const providerPolicy = resolveProviderToolPolicy({
    byProvider: globalTools?.byProvider,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const agentProviderPolicy = resolveProviderToolPolicy({
    byProvider: agentTools?.byProvider,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const explicitProfileAlsoAllow =
    resolveExplicitProfileAlsoAllow(agentTools) ?? resolveExplicitProfileAlsoAllow(globalTools);

  // Warn affected users about removed implicit grants (#47487), but only when
  // the active profile/explicit alsoAllow do not already grant those tools.
  if (profile) {
    const implicitGrants = detectImplicitProfileGrants({
      globalTools,
      agentTools,
      includeGlobalSections: profileSource === "global",
    });
    if (implicitGrants) {
      const profilePolicy = mergeAlsoAllowPolicy(
        resolveToolProfilePolicy(profile),
        explicitProfileAlsoAllow,
      );
      const uncoveredEntries = implicitGrants.entries
        .map((entry) => ({
          section: entry.section,
          grants: entry.grants.filter(
            (toolName) => !isToolAllowedByPolicyName(toolName, profilePolicy),
          ),
        }))
        .filter((entry) => entry.grants.length > 0);
      const uncovered = uncoveredEntries.flatMap((entry) => entry.grants);
      if (uncovered.length > 0) {
        logWarn(
          `tools policy: profile "${profile}"${agentId ? ` (agent "${agentId}")` : ""} has ` +
            `configured tool sections (${formatImplicitToolSections(uncoveredEntries.map((entry) => entry.section))}) that no longer implicitly widen ` +
            `the profile. Add alsoAllow: [${formatToolListForWarning(uncovered)}] ` +
            `explicitly if these tools should be available. See #47487.`,
        );
      }
    }
  }

  const profileAlsoAllow = explicitProfileAlsoAllow
    ? uniqueStrings(explicitProfileAlsoAllow)
    : undefined;
  return {
    agentId,
    globalPolicy: pickSandboxToolPolicy(globalTools),
    globalProviderPolicy: pickSandboxToolPolicy(providerPolicy),
    agentPolicy: pickSandboxToolPolicy(agentTools),
    agentProviderPolicy: pickSandboxToolPolicy(agentProviderPolicy),
    profile,
    providerProfile: agentProviderPolicy?.profile ?? providerPolicy?.profile,
    // alsoAllow is applied at the profile stage to avoid early filtering.
    profileAlsoAllow,
    providerProfileAlsoAllow: Array.isArray(agentProviderPolicy?.alsoAllow)
      ? agentProviderPolicy?.alsoAllow
      : Array.isArray(providerPolicy?.alsoAllow)
        ? providerPolicy?.alsoAllow
        : undefined,
  };
}

/** Resolve group-scoped tool policy after validating session provenance. */
export function resolveGroupToolPolicy(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  spawnedBy?: string | null;
  messageProvider?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
  /** Scheduled authority must not fall back from a removed named account. */
  requireConfiguredAccount?: boolean;
  senderPolicyMode?: "always" | "never";
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
}): SandboxToolPolicy | undefined {
  if (!params.config) {
    return undefined;
  }
  const sessionContext = resolveGroupContextFromSessionKey(params.sessionKey);
  const spawnedContext = resolveGroupContextFromSessionKey(params.spawnedBy);
  const trustedGroup = resolveTrustedGroupIdFromContexts({
    groupId: params.groupId,
    sessionContext,
    spawnedContext,
  });
  // Keep server-derived ids first so a caller cannot use a trusted parent
  // candidate to skip a more-specific session group policy.
  const groupIds = collectUniqueStrings([
    ...(sessionContext.groupIds ?? []),
    ...(spawnedContext.groupIds ?? []),
    ...buildScopedGroupIdCandidates(trustedGroup.groupId),
  ]);
  const channelRaw = sessionContext.channel ?? spawnedContext.channel ?? params.messageProvider;
  const channel = normalizeMessageChannel(channelRaw);
  const accountId = normalizeAccountId(params.accountId);
  if (!channel) {
    return params.requireConfiguredAccount && accountId !== DEFAULT_ACCOUNT_ID
      ? { allow: [] }
      : undefined;
  }
  let plugin;
  try {
    plugin = getLoadedChannelPlugin(channel);
  } catch {
    plugin = undefined;
  }
  if (params.requireConfiguredAccount && accountId !== DEFAULT_ACCOUNT_ID) {
    let configured: boolean;
    try {
      configured =
        plugin?.config
          .listAccountIds(params.config)
          .some((candidate) => normalizeAccountId(candidate) === accountId) === true;
    } catch {
      configured = false;
    }
    if (!configured) {
      // A named creator account is an authority boundary, not a fallback hint.
      // If it disappears, deny the scheduled surface instead of selecting default config.
      return { allow: [] };
    }
  }
  if (groupIds.length === 0) {
    return undefined;
  }
  for (const groupId of groupIds) {
    const toolsConfig = plugin?.groups?.resolveToolPolicy?.({
      cfg: params.config,
      groupId,
      groupChannel: trustedGroup.dropped ? null : params.groupChannel,
      groupSpace: trustedGroup.dropped ? null : params.groupSpace,
      accountId,
      senderPolicyMode: params.senderPolicyMode,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
    });
    const policy = pickSandboxToolPolicy(toolsConfig);
    if (policy) {
      return policy;
    }
  }
  const configTools = resolveChannelGroupToolsPolicy({
    cfg: params.config,
    channel,
    messageProvider: channel,
    groupId: groupIds[0],
    groupIdCandidates: groupIds.slice(1),
    accountId,
    senderPolicyMode: params.senderPolicyMode,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  return pickSandboxToolPolicy(configTools);
}
