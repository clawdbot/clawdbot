// Doctor scanner and repair for subagent allowlists that reference missing agents.
import { listAgentIds } from "../../../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId, normalizeOptionalAgentId } from "../../../routing/session-key.js";

type StaleSubagentAllowlistHit = {
  /** Config path containing the stale allowAgents entry. */
  pathLabel: string;
  /** Original configured agent id. */
  agentId: string;
  /** Normalized agent id used for matching configured targets. */
  normalizedAgentId: string;
};

function collectConfiguredSubagentTargetIds(cfg: OpenClawConfig): Set<string> {
  const ids = new Set<string>(listAgentIds(cfg));
  for (const agent of cfg.agents?.list ?? []) {
    if (agent.runtime?.type !== "acp") {
      continue;
    }
    const acpAgent = normalizeOptionalAgentId(agent.runtime.acp?.agent);
    if (acpAgent) {
      ids.add(acpAgent);
    }
  }
  const defaultAcpAgent = normalizeOptionalAgentId(cfg.acp?.defaultAgent);
  if (defaultAcpAgent) {
    ids.add(defaultAcpAgent);
  }
  for (const entry of cfg.acp?.allowedAgents ?? []) {
    if (entry.trim() === "*") {
      continue;
    }
    const acpAgent = normalizeOptionalAgentId(entry);
    if (acpAgent) {
      ids.add(acpAgent);
    }
  }
  return ids;
}

function collectStaleAllowlistEntries(params: {
  allowAgents: unknown;
  pathLabel: string;
  configuredTargetIds: ReadonlySet<string>;
}): StaleSubagentAllowlistHit[] {
  if (!Array.isArray(params.allowAgents)) {
    return [];
  }
  const hits: StaleSubagentAllowlistHit[] = [];
  const seen = new Set<string>();
  for (const entry of params.allowAgents) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed || trimmed === "*") {
      continue;
    }
    const normalizedAgentId = normalizeAgentId(trimmed);
    if (params.configuredTargetIds.has(normalizedAgentId)) {
      continue;
    }
    const key = `${params.pathLabel}:${normalizedAgentId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    hits.push({
      pathLabel: params.pathLabel,
      agentId: trimmed,
      normalizedAgentId,
    });
  }
  return hits;
}

/** Find subagent allowlist entries not backed by configured agent or ACP targets. */
export function scanStaleSubagentAllowlistReferences(
  cfg: OpenClawConfig,
): StaleSubagentAllowlistHit[] {
  const configuredTargetIds = collectConfiguredSubagentTargetIds(cfg);
  const hits: StaleSubagentAllowlistHit[] = [];
  hits.push(
    ...collectStaleAllowlistEntries({
      allowAgents: cfg.agents?.defaults?.subagents?.allowAgents,
      pathLabel: "agents.defaults.subagents.allowAgents",
      configuredTargetIds,
    }),
  );
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const [index, agent] of agents.entries()) {
    hits.push(
      ...collectStaleAllowlistEntries({
        allowAgents: agent?.subagents?.allowAgents,
        pathLabel: `agents.list.${index}.subagents.allowAgents`,
        configuredTargetIds,
      }),
    );
  }
  return hits;
}

/** Format warnings for stale subagent allowlist entries. */
export function collectStaleSubagentAllowlistWarnings(params: {
  hits: readonly StaleSubagentAllowlistHit[];
  doctorFixCommand: string;
}): string[] {
  if (params.hits.length === 0) {
    return [];
  }
  return [
    ...params.hits.map(
      (hit) =>
        `- ${hit.pathLabel}: stale subagent target "${hit.agentId}" is not in the configured agent registry.`,
    ),
    `- Run "${params.doctorFixCommand}" to remove stale subagent target ids, or add a configured agent or ACP target for each intended target.`,
  ];
}

function filterAllowAgents(params: {
  allowAgents: string[];
  staleTargetIds: ReadonlySet<string>;
}): string[] {
  return params.allowAgents.filter((entry) => {
    const trimmed = entry.trim();
    return !trimmed || trimmed === "*" || !params.staleTargetIds.has(normalizeAgentId(trimmed));
  });
}

/** Remove stale subagent allowlist entries while preserving valid targets and wildcards. */
export function maybeRepairStaleSubagentAllowlists(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const hits = scanStaleSubagentAllowlistReferences(cfg);
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const hitsByPath = new Map<string, StaleSubagentAllowlistHit[]>();
  for (const hit of hits) {
    hitsByPath.set(hit.pathLabel, [...(hitsByPath.get(hit.pathLabel) ?? []), hit]);
  }

  const defaultsHits = hitsByPath.get("agents.defaults.subagents.allowAgents") ?? [];
  if (defaultsHits.length > 0 && Array.isArray(next.agents?.defaults?.subagents?.allowAgents)) {
    const staleTargetIds = new Set(defaultsHits.map((hit) => hit.normalizedAgentId));
    next.agents.defaults.subagents.allowAgents = filterAllowAgents({
      allowAgents: next.agents.defaults.subagents.allowAgents,
      staleTargetIds,
    });
  }

  const agents = Array.isArray(next.agents?.list) ? next.agents.list : [];
  for (const [index, agent] of agents.entries()) {
    const pathLabel = `agents.list.${index}.subagents.allowAgents`;
    const agentHits = hitsByPath.get(pathLabel) ?? [];
    if (agentHits.length === 0 || !Array.isArray(agent?.subagents?.allowAgents)) {
      continue;
    }
    const staleTargetIds = new Set(agentHits.map((hit) => hit.normalizedAgentId));
    agent.subagents.allowAgents = filterAllowAgents({
      allowAgents: agent.subagents.allowAgents,
      staleTargetIds,
    });
  }

  const changes = [...hitsByPath.entries()].map(([pathLabel, pathHits]) => {
    const ids = pathHits.map((hit) => hit.agentId).join(", ");
    return `- ${pathLabel}: removed ${pathHits.length} stale subagent target id${pathHits.length === 1 ? "" : "s"} (${ids})`;
  });

  return { config: next, changes };
}
