import { MAX_SKILL_PROPOSAL_ORIGIN_RUN_IDS } from "./types.js";

function isValidOrigin(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const origin = value as Record<string, unknown>;
  return ["agentId", "sessionKey", "runId", "messageId"].every((key) => {
    const item = origin[key];
    return item === undefined || typeof item === "string";
  });
}

function isValidRunIds(value: unknown): value is string[] | undefined {
  if (value === undefined) {
    return true;
  }
  if (!Array.isArray(value) || value.length > MAX_SKILL_PROPOSAL_ORIGIN_RUN_IDS) {
    return false;
  }
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim() || ids.has(item)) {
      return false;
    }
    ids.add(item);
  }
  return true;
}

function isValidMutationCounts(value: unknown, originRunIds: string[] | undefined): boolean {
  if (value === undefined) {
    return true;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const allowedIds = new Set(originRunIds);
  const entries = Object.entries(value);
  return (
    entries.length <= MAX_SKILL_PROPOSAL_ORIGIN_RUN_IDS &&
    entries.every(
      ([runId, count]) =>
        Boolean(runId.trim()) &&
        allowedIds.has(runId) &&
        typeof count === "number" &&
        Number.isSafeInteger(count) &&
        count > 0,
    )
  );
}

export function hasValidProposalOriginProvenance(value: {
  origin?: unknown;
  originRunIds?: unknown;
  originRunMutationCounts?: unknown;
}): boolean {
  return (
    isValidOrigin(value.origin) &&
    isValidRunIds(value.originRunIds) &&
    isValidMutationCounts(value.originRunMutationCounts, value.originRunIds)
  );
}
