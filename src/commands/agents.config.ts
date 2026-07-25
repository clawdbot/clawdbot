// Agent config mutation and summary builders used by `openclaw agents` commands.
import {
  normalizeOptionalString,
  resolvePrimaryStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  listAgentEntries,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { resolveAgentAvatarUrlFromSource } from "../agents/identity-avatar-file.js";
import type { AgentIdentityFile } from "../agents/identity-file.js";
import { identityHasValues, loadAgentIdentityFromWorkspace } from "../agents/identity-file.js";
import { listRouteBindings } from "../config/bindings.js";
import type { IdentityConfig } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";

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
  isDefault: boolean;
};

type AgentEntry = NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>[number];

function toAgentEntries(list: AgentEntry[]): Record<string, Omit<AgentEntry, "id">> {
  return Object.fromEntries(
    list.map((entry) => {
      const { id, ...config } = entry;
      return [id, config];
    }),
  );
}

export type AgentIdentity = AgentIdentityFile;
export { listAgentEntries };

/** Find a configured agent entry by normalized id. */
export function findAgentEntryIndex(list: AgentEntry[], agentId: string): number {
  const id = normalizeAgentId(agentId);
  return list.findIndex((entry) => normalizeAgentId(entry.id) === id);
}

function resolveAgentModel(cfg: OpenClawConfig, agentId: string) {
  const entry = listAgentEntries(cfg).find(
    (agent) => normalizeAgentId(agent.id) === normalizeAgentId(agentId),
  );
  const entryPrimary = resolvePrimaryStringValue(entry?.model);
  if (entryPrimary) {
    return entryPrimary;
  }
  return resolvePrimaryStringValue(cfg.agents?.defaults?.model);
}

/** Load non-empty identity metadata from a workspace identity file. */
export function loadAgentIdentity(workspace: string): AgentIdentity | null {
  const parsed = loadAgentIdentityFromWorkspace(workspace);
  if (!parsed) {
    return null;
  }
  return identityHasValues(parsed) ? parsed : null;
}

/** Build config-derived summaries for text/JSON agent listing. */
export function buildAgentSummaries(cfg: OpenClawConfig): AgentSummary[] {
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
  const configuredAgents = listAgentEntries(cfg);
  const orderedIds =
    configuredAgents.length > 0
      ? configuredAgents.map((agent) => normalizeAgentId(agent.id))
      : [defaultAgentId];
  const bindingCounts = new Map<string, number>();
  for (const binding of listRouteBindings(cfg)) {
    const agentId = normalizeAgentId(binding.agentId);
    bindingCounts.set(agentId, (bindingCounts.get(agentId) ?? 0) + 1);
  }

  const ordered = uniqueStrings(orderedIds);

  return ordered.map((id) => {
    const workspace = resolveAgentWorkspaceDir(cfg, id);
    const identity = loadAgentIdentity(workspace);
    const configIdentity = configuredAgents.find(
      (agent) => normalizeAgentId(agent.id) === id,
    )?.identity;
    const identityName = identity?.name ?? configIdentity?.name?.trim();
    const identityEmoji = identity?.emoji ?? configIdentity?.emoji?.trim();
    const identityAvatarUrl = resolveAgentAvatarUrlFromSource(
      cfg,
      id,
      identity?.avatar ?? configIdentity?.avatar,
    );
    const identitySource = identity
      ? "identity"
      : configIdentity && (identityName || identityEmoji || identityAvatarUrl)
        ? "config"
        : undefined;
    const summary: AgentSummary = {
      id,
      name: normalizeOptionalString(
        configuredAgents.find((agent) => normalizeAgentId(agent.id) === id)?.name,
      ),
      identityName,
      identityEmoji,
      identitySource,
      workspace,
      agentDir: resolveAgentDir(cfg, id),
      model: resolveAgentModel(cfg, id),
      bindings: bindingCounts.get(id) ?? 0,
      isDefault: id === defaultAgentId,
    };
    if (identityAvatarUrl) {
      summary.identityAvatarUrl = identityAvatarUrl;
    }
    return summary;
  });
}

/** Add or update one agent entry while preserving the default-agent placeholder when needed. */
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
    if (nextList.length === 0 && agentId !== normalizeAgentId(resolveDefaultAgentId(cfg))) {
      nextList.push({ id: resolveDefaultAgentId(cfg) });
    }
    nextList.push(nextEntry);
  }
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      entries: toAgentEntries(nextList),
    },
  };
}

/** Remove an agent and any config references that route or allow traffic to it. */
export function pruneAgentConfig(
  cfg: OpenClawConfig,
  agentId: string,
): {
  config: OpenClawConfig;
  removedBindings: number;
  removedAllow: number;
} {
  const id = normalizeAgentId(agentId);
  const agents = listAgentEntries(cfg);
  const pruneAllowAgents = (allowAgents: string[] | undefined) =>
    allowAgents?.filter((entry) => {
      const trimmed = entry.trim();
      return !trimmed || trimmed === "*" || normalizeAgentId(trimmed) !== id;
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
  const nextAgents = nextAgentsList.length > 0 ? toAgentEntries(nextAgentsList) : undefined;

  const bindings = cfg.bindings ?? [];
  const filteredBindings = bindings.filter((binding) => normalizeAgentId(binding.agentId) !== id);

  const allow = cfg.tools?.agentToAgent?.allow ?? [];
  const filteredAllow = allow.filter((entry) => entry !== id);

  const nextDefaults = cfg.agents?.defaults?.subagents?.allowAgents
    ? {
        ...cfg.agents.defaults,
        subagents: {
          ...cfg.agents.defaults.subagents,
          allowAgents: pruneAllowAgents(cfg.agents.defaults.subagents.allowAgents),
        },
      }
    : cfg.agents?.defaults;
  const nextAgentsConfig = cfg.agents
    ? { ...cfg.agents, defaults: nextDefaults, entries: nextAgents }
    : nextAgents
      ? { entries: nextAgents }
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

  return {
    config: {
      ...cfg,
      agents: nextAgentsConfig,
      bindings: filteredBindings.length > 0 ? filteredBindings : undefined,
      tools: nextTools,
    },
    removedBindings: bindings.length - filteredBindings.length,
    removedAllow: allow.length - filteredAllow.length,
  };
}
