import { getLoadedChannelPlugin } from "../channels/plugins/index.js";
import { resolveSessionConversation } from "../channels/plugins/session-conversation.js";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../config/agent-limits.js";
import { resolveChannelGroupToolsPolicy } from "../config/group-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentToolsConfig } from "../config/types.tools.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  parseRawSessionConversationRef,
  parseThreadSessionSuffix,
} from "../sessions/session-key-utils.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { resolveAgentConfig, resolveAgentIdFromSessionKey } from "./agent-scope.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import { pickSandboxToolPolicy } from "./sandbox-tool-policy.js";
import type { SandboxToolPolicy } from "./sandbox.js";
import {
  resolveStoredSubagentCapabilities,
  type SubagentSessionRole,
} from "./subagent-capabilities.js";
import { isToolAllowedByPolicies, isToolAllowedByPolicyName } from "./tool-policy-match.js";
import { normalizeToolName } from "./tool-policy.js";

/**
 * Tools always denied for sub-agents regardless of depth.
 * These are system-level or interactive tools that sub-agents should never use.
 */
const SUBAGENT_TOOL_DENY_ALWAYS = [
  // System admin - dangerous from subagent
  "gateway",
  "agents_list",
  // Interactive setup - not a task
  "whatsapp_login",
  // Status/scheduling - main agent coordinates
  "session_status",
  "cron",
  // Direct session sends - subagents communicate through announce chain
  "sessions_send",
];

/**
 * Additional tools denied for leaf sub-agents (depth >= maxSpawnDepth).
 * These are tools that only make sense for orchestrator sub-agents that can spawn children.
 */
const SUBAGENT_TOOL_DENY_LEAF = [
  "subagents",
  "sessions_list",
  "sessions_history",
  "sessions_spawn",
];

/**
 * Build the deny list for a sub-agent at a given depth.
 *
 * - Depth 1 with maxSpawnDepth >= 2 (orchestrator): allowed to use sessions_spawn,
 *   subagents, sessions_list, sessions_history so it can manage its children.
 * - Depth >= maxSpawnDepth (leaf): denied subagents, sessions_spawn, and
 *   session management tools.
 */
function resolveSubagentDenyList(depth: number, maxSpawnDepth: number): string[] {
  const isLeaf = depth >= Math.max(1, Math.floor(maxSpawnDepth));
  if (isLeaf) {
    return [...SUBAGENT_TOOL_DENY_ALWAYS, ...SUBAGENT_TOOL_DENY_LEAF];
  }
  // Orchestrator sub-agent: only deny the always-denied tools.
  // sessions_spawn, subagents, sessions_list, sessions_history are allowed.
  return [...SUBAGENT_TOOL_DENY_ALWAYS];
}

function resolveSubagentDenyListForRole(role: SubagentSessionRole): string[] {
  if (role === "leaf") {
    return [...SUBAGENT_TOOL_DENY_ALWAYS, ...SUBAGENT_TOOL_DENY_LEAF];
  }
  return [...SUBAGENT_TOOL_DENY_ALWAYS];
}

export function resolveSubagentToolPolicy(cfg?: OpenClawConfig, depth?: number): SandboxToolPolicy {
  const configured = cfg?.tools?.subagents?.tools;
  const maxSpawnDepth =
    cfg?.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  const effectiveDepth = typeof depth === "number" && depth >= 0 ? depth : 1;
  const baseDeny = resolveSubagentDenyList(effectiveDepth, maxSpawnDepth);
  const allow = Array.isArray(configured?.allow) ? configured.allow : undefined;
  const alsoAllow = Array.isArray(configured?.alsoAllow) ? configured.alsoAllow : undefined;
  const explicitAllow = new Set(
    [...(allow ?? []), ...(alsoAllow ?? [])].map((toolName) => normalizeToolName(toolName)),
  );
  const deny = [
    ...baseDeny.filter((toolName) => !explicitAllow.has(normalizeToolName(toolName))),
    ...(Array.isArray(configured?.deny) ? configured.deny : []),
  ];
  const mergedAllow = allow && alsoAllow ? Array.from(new Set([...allow, ...alsoAllow])) : allow;
  return { allow: mergedAllow, deny };
}

export function resolveSubagentToolPolicyForSession(
  cfg: OpenClawConfig | undefined,
  sessionKey: string,
): SandboxToolPolicy {
  const configured = cfg?.tools?.subagents?.tools;
  const capabilities = resolveStoredSubagentCapabilities(sessionKey, { cfg });
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
  const mergedAllow = allow && alsoAllow ? Array.from(new Set([...allow, ...alsoAllow])) : allow;
  return { allow: mergedAllow, deny };
}

export function filterToolsByPolicy(tools: AnyAgentTool[], policy?: SandboxToolPolicy) {
  if (!policy) {
    return tools;
  }
  return tools.filter((tool) => isToolAllowedByPolicyName(tool.name, policy));
}

type ToolPolicyConfig = {
  allow?: string[];
  alsoAllow?: string[];
  deny?: string[];
  profile?: string;
};

function normalizeProviderKey(value: string): string {
  return normalizeLowercaseStringOrEmpty(value);
}

function collectUniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    resolved.push(trimmed);
  }
  return resolved;
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
    const resolvedConversation = /:(?:sender|thread|topic):/iu.test(conversation.rawId)
      ? resolveSessionConversation({
          channel: conversation.channel,
          kind: conversation.kind,
          rawId: conversation.rawId,
        })
      : null;
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

function resolveProviderToolPolicy(params: {
  byProvider?: Record<string, ToolPolicyConfig>;
  modelProvider?: string;
  modelId?: string;
}): ToolPolicyConfig | undefined {
  const provider = params.modelProvider?.trim();
  if (!provider || !params.byProvider) {
    return undefined;
  }

  const entries = Object.entries(params.byProvider);
  if (entries.length === 0) {
    return undefined;
  }

  const lookup = new Map<string, ToolPolicyConfig>();
  for (const [key, value] of entries) {
    const normalized = normalizeProviderKey(key);
    if (!normalized) {
      continue;
    }
    lookup.set(normalized, value);
  }

  const normalizedProvider = normalizeProviderKey(provider);
  const rawModelId = normalizeOptionalLowercaseString(params.modelId);
  const fullModelId =
    rawModelId && !rawModelId.includes("/") ? `${normalizedProvider}/${rawModelId}` : rawModelId;

  const candidates = [...(fullModelId ? [fullModelId] : []), normalizedProvider];

  for (const key of candidates) {
    const match = lookup.get(key);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function resolveExplicitProfileAlsoAllow(tools?: OpenClawConfig["tools"]): string[] | undefined {
  return Array.isArray(tools?.alsoAllow) ? tools.alsoAllow : undefined;
}

function hasExplicitToolSection(section: unknown): boolean {
  return section !== undefined && section !== null;
}

function resolveImplicitProfileAlsoAllow(params: {
  globalTools?: OpenClawConfig["tools"];
  agentTools?: AgentToolsConfig;
}): string[] | undefined {
  const implicit = new Set<string>();
  if (
    hasExplicitToolSection(params.agentTools?.exec) ||
    hasExplicitToolSection(params.globalTools?.exec)
  ) {
    implicit.add("exec");
    implicit.add("process");
  }
  if (
    hasExplicitToolSection(params.agentTools?.fs) ||
    hasExplicitToolSection(params.globalTools?.fs)
  ) {
    implicit.add("read");
    implicit.add("write");
    implicit.add("edit");
  }
  return implicit.size > 0 ? Array.from(implicit) : undefined;
}

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
    (params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined);
  const agentConfig =
    params.config && agentId ? resolveAgentConfig(params.config, agentId) : undefined;
  const agentTools = agentConfig?.tools;
  const globalTools = params.config?.tools;

  const profile = agentTools?.profile ?? globalTools?.profile;
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
  const implicitProfileAlsoAllow = resolveImplicitProfileAlsoAllow({ globalTools, agentTools });
  const profileAlsoAllow =
    explicitProfileAlsoAllow || implicitProfileAlsoAllow
      ? Array.from(
          new Set([...(explicitProfileAlsoAllow ?? []), ...(implicitProfileAlsoAllow ?? [])]),
        )
      : undefined;
  return {
    agentId,
    globalPolicy: pickSandboxToolPolicy(globalTools),
    globalProviderPolicy: pickSandboxToolPolicy(providerPolicy),
    agentPolicy: pickSandboxToolPolicy(agentTools),
    agentProviderPolicy: pickSandboxToolPolicy(agentProviderPolicy),
    profile,
    providerProfile: agentProviderPolicy?.profile ?? providerPolicy?.profile,
    // alsoAllow is applied at the profile stage (to avoid being filtered out early).
    profileAlsoAllow,
    providerProfileAlsoAllow: Array.isArray(agentProviderPolicy?.alsoAllow)
      ? agentProviderPolicy?.alsoAllow
      : Array.isArray(providerPolicy?.alsoAllow)
        ? providerPolicy?.alsoAllow
        : undefined,
  };
}

export function resolveGroupToolPolicy(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  spawnedBy?: string | null;
  messageProvider?: string;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  accountId?: string | null;
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
  const groupIds = collectUniqueStrings([
    ...buildScopedGroupIdCandidates(params.groupId),
    ...(sessionContext.groupIds ?? []),
    ...(spawnedContext.groupIds ?? []),
  ]);
  if (groupIds.length === 0) {
    return undefined;
  }
  const channelRaw = params.messageProvider ?? sessionContext.channel ?? spawnedContext.channel;
  const channel = normalizeMessageChannel(channelRaw);
  if (!channel) {
    return undefined;
  }
  let plugin;
  try {
    plugin = getLoadedChannelPlugin(channel);
  } catch {
    plugin = undefined;
  }
  for (const groupId of groupIds) {
    const toolsConfig = plugin?.groups?.resolveToolPolicy?.({
      cfg: params.config,
      groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      accountId: params.accountId,
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
    groupId: groupIds[0],
    groupIdCandidates: groupIds.slice(1),
    accountId: params.accountId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  return pickSandboxToolPolicy(configTools);
}

export { isToolAllowedByPolicies, isToolAllowedByPolicyName } from "./tool-policy-match.js";
