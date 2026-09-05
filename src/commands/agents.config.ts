// Agent config mutation and summary builders used by `openclaw agents` commands.
import {
  normalizeOptionalString,
  resolvePrimaryStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  listAgentEntries,
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  tryResolveLegacyCompatibilityAgentId,
  toAgentEntriesRecord,
} from "../agents/agent-scope.js";
import { resolveAgentAvatarUrlFromSource } from "../agents/identity-avatar-file.js";
import { loadAgentIdentityFromWorkspace } from "../agents/identity-file.js";
import { pinLegacyInheritedAuthOwnerForRosterTransition } from "../agents/legacy-inherited-auth-dir.js";
import { pinSurvivorWorkspaceForRosterCollapse } from "../config/agent-workspace-roster-transition.js";
import { listRouteBindings } from "../config/bindings.js";
import type { IdentityConfig } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, normalizeAgentIdStrict } from "../routing/session-key.js";

export type AgentSummary = {
  id: string;
  name?: string;
  identityName?: string;
  identityEmoji?: string;
  identityAvatarUrl?: string;
  identitySource?: "identity" | "config";
  workspace: string;
  agentDir: string;
  model?: string;
  bindings: number;
  bindingDetails?: string[];
  routes?: string[];
  providers?: string[];
  createdVia?: "operator" | "agent" | "claw";
  creatorAgentId?: string | null;
  createdAt?: number;
  isDefault: boolean;
};

type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

export { listAgentEntries };

/** Find a configured agent entry by normalized id. */
export function findAgentEntryIndex(list: AgentEntry[], agentId: string): number {
  const id = normalizeAgentId(agentId);
  return list.findIndex((entry) => normalizeAgentId(entry.id) === id);
}

/** Build config-derived summaries for text/JSON agent listing. */
export function buildAgentSummaries(cfg: OpenClawConfig): AgentSummary[] {
  const defaultAgentId = tryResolveLegacyCompatibilityAgentId(cfg);
  const configuredAgents = listAgentEntries(cfg);
  const orderedIds =
    configuredAgents.length > 0
      ? configuredAgents.map((agent) => normalizeAgentId(agent.id))
      : defaultAgentId
        ? [defaultAgentId]
        : [];
  const bindingCounts = new Map<string, number>();
  for (const binding of listRouteBindings(cfg)) {
    const agentId = normalizeAgentId(binding.agentId);
    bindingCounts.set(agentId, (bindingCounts.get(agentId) ?? 0) + 1);
  }

  const ordered = uniqueStrings(orderedIds);

  return ordered.map((id) => {
    const workspace = resolveAgentWorkspaceDir(cfg, id);
    const identity = loadAgentIdentityFromWorkspace(workspace);
    const agentConfig = resolveAgentConfig(cfg, id);
    const configName = normalizeOptionalString(agentConfig?.identity?.name);
    const configEmoji = normalizeOptionalString(agentConfig?.identity?.emoji);
    const configAvatarUrl = resolveAgentAvatarUrlFromSource(cfg, id, agentConfig?.identity?.avatar);
    // Validate each avatar before choosing so a stale path cannot hide the workspace image.
    const identityAvatarUrl =
      configAvatarUrl ?? resolveAgentAvatarUrlFromSource(cfg, id, identity?.avatar);
    const identitySource =
      configName || configEmoji || configAvatarUrl ? "config" : identity ? "identity" : undefined;
    const summary: AgentSummary = {
      id,
      name: normalizeOptionalString(agentConfig?.name),
      identityName: configName ?? identity?.name,
      identityEmoji: configEmoji ?? identity?.emoji,
      identitySource,
      workspace,
      agentDir: resolveAgentDir(cfg, id),
      model:
        resolvePrimaryStringValue(agentConfig?.model) ??
        resolvePrimaryStringValue(cfg.agents?.defaults?.model),
      bindings: bindingCounts.get(id) ?? 0,
      isDefault: defaultAgentId !== undefined && id === normalizeAgentId(defaultAgentId),
    };
    if (identityAvatarUrl) {
      summary.identityAvatarUrl = identityAvatarUrl;
    }
    return summary;
  });
}

export function applyAgentConfig(
  cfg: OpenClawConfig,
  params: {
    agentId: string;
    name?: string;
    workspace?: string;
    agentDir?: string;
    model?: string | null;
    identity?: IdentityConfig;
  },
): OpenClawConfig {
  const agentId = normalizeAgentId(params.agentId);
  const name = params.name?.trim();
  const list = listAgentEntries(cfg);
  const index = findAgentEntryIndex(list, agentId);
  const base = (index >= 0 ? list[index] : undefined) ?? { id: agentId };
  const mergedIdentity = params.identity ? { ...base.identity, ...params.identity } : undefined;
  const nextEntry: AgentEntry = {
    ...base,
    ...(name ? { name } : {}),
    ...(params.workspace ? { workspace: params.workspace } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(mergedIdentity ? { identity: mergedIdentity } : {}),
  };
  // Model is tri-state: omission preserves the override, null restores inheritance.
  if (params.model === null) {
    delete nextEntry.model;
  } else if (params.model !== undefined) {
    nextEntry.model = params.model;
  }
  const nextList = [...list];
  if (index >= 0) {
    nextList[index] = nextEntry;
  } else {
    nextList.push(nextEntry);
  }
  const { list: _legacyList, ownership: _ownership, ...agentsConfig } = cfg.agents ?? {};
  const nextConfig: OpenClawConfig = {
    ...cfg,
    agents: {
      ...agentsConfig,
      ...(nextList.length > 1 ? { ownership: "explicit" as const } : {}),
      entries: toAgentEntriesRecord(nextList),
    },
  };
  if (list.length !== 1 || nextList.length <= 1) {
    return nextConfig;
  }
  const priorSystemAgentId = tryResolveLegacyCompatibilityAgentId(cfg);
  const transitionedConfig =
    priorSystemAgentId &&
    !normalizeOptionalString(nextConfig.agents?.defaults?.systemAgent?.agentId)
      ? {
          ...nextConfig,
          agents: {
            ...nextConfig.agents,
            defaults: {
              ...nextConfig.agents?.defaults,
              systemAgent: { agentId: priorSystemAgentId },
            },
          },
        }
      : nextConfig;
  return pinLegacyInheritedAuthOwnerForRosterTransition(cfg, transitionedConfig);
}

/** Remove an agent and any config references that route or allow traffic to it. */
export function pruneAgentConfig(
  cfg: OpenClawConfig,
  agentId: string,
): {
  config: OpenClawConfig;
  removedBindings: number;
  removedAllow: number;
  clearedOwnerRefs: string[];
} {
  const id = normalizeAgentId(agentId);
  const clearedOwnerRefs: string[] = [];
  const targetsDeletedAgent = (candidate: string) => {
    const normalized = normalizeAgentIdStrict(candidate);
    return normalized.ok && normalized.value === id;
  };
  const clearOwnerRef = <T extends { agentId?: string }>(value: T | undefined, path: string) => {
    const owner = normalizeOptionalString(value?.agentId);
    if (!value || !owner || normalizeAgentId(owner) !== id) {
      return value;
    }
    clearedOwnerRefs.push(path);
    const { agentId: _agentId, ...rest } = value;
    return Object.keys(rest).length > 0 ? (rest as T) : undefined;
  };
  const agents = listAgentEntries(cfg);
  const pruneAllowAgents = (allowAgents: string[] | undefined) =>
    allowAgents?.filter((entry) => {
      const trimmed = entry.trim();
      return !trimmed || !targetsDeletedAgent(trimmed);
    });
  const nextAgentsList = [];
  for (const entry of agents) {
    if (normalizeAgentId(entry.id) === id) {
      continue;
    }
    nextAgentsList.push(
      entry.subagents?.allowAgents
        ? {
            ...entry,
            subagents: {
              ...entry.subagents,
              allowAgents: pruneAllowAgents(entry.subagents.allowAgents),
            },
          }
        : entry,
    );
  }
  const nextAgents = nextAgentsList.length > 0 ? toAgentEntriesRecord(nextAgentsList) : undefined;

  const bindings = cfg.bindings ?? [];
  const filteredBindings = bindings.filter((binding) => normalizeAgentId(binding.agentId) !== id);

  const allow = cfg.tools?.agentToAgent?.allow ?? [];
  const filteredAllow = allow.filter((entry) => entry !== id);

  const prunedDefaults = cfg.agents?.defaults?.subagents?.allowAgents
    ? {
        ...cfg.agents.defaults,
        subagents: {
          ...cfg.agents.defaults.subagents,
          allowAgents: pruneAllowAgents(cfg.agents.defaults.subagents.allowAgents),
        },
      }
    : cfg.agents?.defaults;
  const deletedAgentOwnedHeartbeat =
    normalizeOptionalString(prunedDefaults?.heartbeat?.agentId) !== undefined &&
    normalizeAgentId(prunedDefaults?.heartbeat?.agentId) === id;
  const nextHeartbeat =
    deletedAgentOwnedHeartbeat && nextAgentsList.length > 1
      ? undefined
      : clearOwnerRef(prunedDefaults?.heartbeat, "agents.defaults.heartbeat.agentId");
  if (deletedAgentOwnedHeartbeat && nextAgentsList.length > 1) {
    clearedOwnerRefs.push("agents.defaults.heartbeat");
  }
  const nextDefaults = prunedDefaults
    ? {
        ...prunedDefaults,
        heartbeat: nextHeartbeat,
        systemAgent: clearOwnerRef(
          prunedDefaults.systemAgent,
          "agents.defaults.systemAgent.agentId",
        ),
      }
    : undefined;
  const nextTalk = clearOwnerRef(cfg.talk, "talk.agentId");
  const nextBroadcast = cfg.broadcast
    ? Object.fromEntries(
        Object.entries(cfg.broadcast).map(([peerId, value]) => [
          peerId,
          Array.isArray(value) ? value.filter((entry) => !targetsDeletedAgent(entry)) : value,
        ]),
      )
    : undefined;
  const nextHooks = cfg.hooks
    ? {
        ...cfg.hooks,
        allowedAgentIds: cfg.hooks.allowedAgentIds?.filter((entry) => !targetsDeletedAgent(entry)),
        mappings: cfg.hooks.mappings?.filter(
          (mapping) => !mapping.agentId || !targetsDeletedAgent(mapping.agentId),
        ),
      }
    : undefined;
  const { list: _legacyList, ownership: _ownership, ...agentsConfig } = cfg.agents ?? {};
  const nextAgentsConfig = cfg.agents
    ? {
        ...agentsConfig,
        ...(nextAgentsList.length > 1 ? { ownership: "explicit" as const } : {}),
        defaults: nextDefaults,
        entries: nextAgents,
      }
    : nextAgents
      ? {
          ...(nextAgentsList.length > 1 ? { ownership: "explicit" as const } : {}),
          entries: nextAgents,
        }
      : undefined;
  const nextTools = cfg.tools?.agentToAgent
    ? {
        ...cfg.tools,
        agentToAgent: {
          ...cfg.tools.agentToAgent,
          allow: filteredAllow.length > 0 ? filteredAllow : undefined,
        },
      }
    : cfg.tools;

  const preliminaryConfig: OpenClawConfig = {
    ...cfg,
    agents: nextAgentsConfig,
    bindings: filteredBindings.length > 0 ? filteredBindings : undefined,
    broadcast: nextBroadcast,
    hooks: nextHooks,
    talk: nextTalk,
    tools: nextTools,
  };
  const workspacePinnedConfig = pinSurvivorWorkspaceForRosterCollapse(
    cfg,
    preliminaryConfig,
  ).config;
  const transitionPinnedConfig =
    agents.length > 1 && nextAgentsList.length === 1
      ? pinLegacyInheritedAuthOwnerForRosterTransition(cfg, workspacePinnedConfig)
      : workspacePinnedConfig;

  return {
    config: transitionPinnedConfig,
    removedBindings: bindings.length - filteredBindings.length,
    removedAllow: allow.length - filteredAllow.length,
    clearedOwnerRefs,
  };
}
