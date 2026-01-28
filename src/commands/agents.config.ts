import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import type { AgentIdentityFile } from "../agents/identity-file.js";
import {
  identityHasValues,
  loadAgentIdentityFromWorkspace,
  parseIdentityMarkdown as parseIdentityMarkdownFile,
} from "../agents/identity-file.js";
import type { MoltbotConfig } from "../config/config.js";
import { normalizeAgentId } from "../routing/session-key.js";

export type AgentSummary = {
  id: string;
  name?: string;
  identityName?: string;
  identityEmoji?: string;
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

type AgentEntry = NonNullable<NonNullable<MoltbotConfig["agents"]>["list"]>[number];

export type AgentIdentity = AgentIdentityFile;

export function listAgentEntries(cfg: MoltbotConfig): AgentEntry[] {
  const list = cfg.agents?.list;
  if (!Array.isArray(list)) return [];
  return list.filter((entry): entry is AgentEntry => Boolean(entry && typeof entry === "object"));
}

export function findAgentEntryIndex(list: AgentEntry[], agentId: string): number {
  const id = normalizeAgentId(agentId);
  return list.findIndex((entry) => normalizeAgentId(entry.id) === id);
}

function resolveAgentName(cfg: MoltbotConfig, agentId: string) {
  const entry = listAgentEntries(cfg).find(
    (agent) => normalizeAgentId(agent.id) === normalizeAgentId(agentId),
  );
  return entry?.name?.trim() || undefined;
}

function resolveAgentModel(cfg: MoltbotConfig, agentId: string) {
  const entry = listAgentEntries(cfg).find(
    (agent) => normalizeAgentId(agent.id) === normalizeAgentId(agentId),
  );
  if (entry?.model) {
    if (typeof entry.model === "string" && entry.model.trim()) {
      return entry.model.trim();
    }
    if (typeof entry.model === "object") {
      const primary = entry.model.primary?.trim();
      if (primary) return primary;
    }
  }
  const raw = cfg.agents?.defaults?.model;
  if (typeof raw === "string") return raw;
  return raw?.primary?.trim() || undefined;
}

export function parseIdentityMarkdown(content: string): AgentIdentity {
  return parseIdentityMarkdownFile(content);
}

export function loadAgentIdentity(workspace: string): AgentIdentity | null {
  const parsed = loadAgentIdentityFromWorkspace(workspace);
  if (!parsed) return null;
  return identityHasValues(parsed) ? parsed : null;
}

export function buildAgentSummaries(cfg: MoltbotConfig): AgentSummary[] {
  const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
  const configuredAgents = listAgentEntries(cfg);
  const orderedIds =
    configuredAgents.length > 0
      ? configuredAgents.map((agent) => normalizeAgentId(agent.id))
      : [defaultAgentId];
  const bindingCounts = new Map<string, number>();
  for (const binding of cfg.bindings ?? []) {
    const agentId = normalizeAgentId(binding.agentId);
    bindingCounts.set(agentId, (bindingCounts.get(agentId) ?? 0) + 1);
  }

  const ordered = orderedIds.filter((id, index) => orderedIds.indexOf(id) === index);

  return ordered.map((id) => {
    const workspace = resolveAgentWorkspaceDir(cfg, id);
    const identity = loadAgentIdentity(workspace);
    const configIdentity = configuredAgents.find(
      (agent) => normalizeAgentId(agent.id) === id,
    )?.identity;
    const identityName = identity?.name ?? configIdentity?.name?.trim();
    const identityEmoji = identity?.emoji ?? configIdentity?.emoji?.trim();
    const identitySource = identity
      ? "identity"
      : configIdentity && (identityName || identityEmoji)
        ? "config"
        : undefined;
    return {
      id,
      name: resolveAgentName(cfg, id),
      identityName,
      identityEmoji,
      identitySource,
      workspace,
      agentDir: resolveAgentDir(cfg, id),
      model: resolveAgentModel(cfg, id),
      bindings: bindingCounts.get(id) ?? 0,
      isDefault: id === defaultAgentId,
    };
  });
}

export function applyAgentConfig(
  cfg: MoltbotConfig,
  params: {
    agentId: string;
    name?: string;
    workspace?: string;
    agentDir?: string;
    model?: string;
  },
): MoltbotConfig {
  const agentId = normalizeAgentId(params.agentId);
  const name = params.name?.trim();
  const list = listAgentEntries(cfg);
  const index = findAgentEntryIndex(list, agentId);
  const base = index >= 0 ? list[index] : { id: agentId };
  const nextEntry: AgentEntry = {
    ...base,
    ...(name ? { name } : {}),
    ...(params.workspace ? { workspace: params.workspace } : {}),
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(params.model ? { model: params.model } : {}),
  };
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
      list: nextList,
    },
  };
}

export function pruneAgentConfig(
  cfg: MoltbotConfig,
  agentId: string,
): {
  config: MoltbotConfig;
  removedBindings: number;
  removedAllow: number;
} {
  const id = normalizeAgentId(agentId);
  const agents = listAgentEntries(cfg);
  const nextAgentsList = agents.filter((entry) => normalizeAgentId(entry.id) !== id);
  const nextAgents = nextAgentsList.length > 0 ? nextAgentsList : undefined;

  const bindings = cfg.bindings ?? [];
  const filteredBindings = bindings.filter((binding) => normalizeAgentId(binding.agentId) !== id);

  const allow = cfg.tools?.agentToAgent?.allow ?? [];
  const filteredAllow = allow.filter((entry) => entry !== id);

  const nextAgentsConfig = cfg.agents
    ? { ...cfg.agents, list: nextAgents }
    : nextAgents
      ? { list: nextAgents }
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
