import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeUniqueStringEntries, sortUniqueStrings } from "../shared/string-normalization.js";

type SubagentTargetPolicyResult = { ok: true } | { ok: false; allowedText: string; error: string };

function normalizeAllowAgents(allowAgents: readonly string[] | undefined): {
  configured: boolean;
  allowAny: boolean;
  allowedIds: string[];
} {
  if (!Array.isArray(allowAgents)) {
    return {
      configured: false,
      allowAny: false,
      allowedIds: [],
    };
  }
  const allowedIds = allowAgents
    .map((value) => value.trim())
    .filter((value) => value && value !== "*")
    .map((value) => normalizeAgentId(value))
    .filter(Boolean);
  return {
    configured: true,
    allowAny: allowAgents.some((value) => value.trim() === "*"),
    allowedIds: sortUniqueStrings(allowedIds),
  };
}

function normalizeConfiguredAgentIds(
  configuredAgentIds: readonly string[] | undefined,
): Set<string> {
  return new Set(normalizeUniqueStringEntries((configuredAgentIds ?? []).map(normalizeAgentId)));
}

function filterConfiguredAllowedIds(params: {
  allowedIds: readonly string[];
  configuredAgentIds?: readonly string[];
}): string[] {
  const configuredIds = normalizeConfiguredAgentIds(params.configuredAgentIds);
  return params.allowedIds.filter((id) => configuredIds.has(id));
}

export function resolveSubagentAllowedTargetIds(params: {
  requesterAgentId: string;
  allowAgents?: readonly string[];
  configuredAgentIds?: readonly string[];
}): { allowAny: boolean; allowedIds: string[] } {
  const requesterAgentId = normalizeAgentId(params.requesterAgentId);
  const policy = normalizeAllowAgents(params.allowAgents);
  if (!policy.configured) {
    return {
      allowAny: false,
      allowedIds: requesterAgentId ? [requesterAgentId] : [],
    };
  }
  if (policy.allowAny) {
    const configuredIds = Array.from(normalizeConfiguredAgentIds(params.configuredAgentIds));
    if (requesterAgentId) {
      configuredIds.push(requesterAgentId);
    }
    return {
      allowAny: true,
      allowedIds: sortUniqueStrings(configuredIds),
    };
  }
  return {
    allowAny: false,
    allowedIds: filterConfiguredAllowedIds({
      allowedIds: policy.allowedIds,
      configuredAgentIds: params.configuredAgentIds,
    }).toSorted((a, b) => a.localeCompare(b)),
  };
}

export function resolveSubagentTargetPolicy(params: {
  requesterAgentId: string;
  targetAgentId: string;
  requestedAgentId?: string;
  allowAgents?: readonly string[];
  configuredAgentIds?: readonly string[];
}): SubagentTargetPolicyResult {
  const requesterAgentId = normalizeAgentId(params.requesterAgentId);
  const targetAgentId = normalizeAgentId(params.targetAgentId);
  if (!params.requestedAgentId?.trim() && targetAgentId === requesterAgentId) {
    return { ok: true };
  }

  const allowed = resolveSubagentAllowedTargetIds({
    requesterAgentId,
    allowAgents: params.allowAgents,
    configuredAgentIds: params.configuredAgentIds,
  });
  if (allowed.allowedIds.includes(targetAgentId)) {
    return { ok: true };
  }
  const allowedText = allowed.allowedIds.length > 0 ? allowed.allowedIds.join(", ") : "none";
  const policy = normalizeAllowAgents(params.allowAgents);
  if (allowed.allowAny || policy.allowedIds.includes(targetAgentId)) {
    return {
      ok: false,
      allowedText,
      error: `agentId "${targetAgentId}" is not in the configured agent registry (allowed: ${allowedText})`,
    };
  }
  return {
    ok: false,
    allowedText,
    error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
  };
}
