/** Reporting projections for sessions cleanup results (action labels, wire shape). */
import type { SessionCleanupSummary, SessionsCleanupResult } from "./cleanup-service.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";

type SessionCleanupAction =
  | "keep"
  | "prune-missing"
  | "prune-model-run"
  | "prune-stale"
  | "cap-overflow"
  | "evict-budget"
  | "retire-dm-scope";

/** Resolves the action label for one session key from cleanup key sets. */
export function resolveSessionCleanupAction(params: {
  key: string;
  missingKeys: Set<string>;
  modelRunPrunedKeys: Set<string>;
  staleKeys: Set<string>;
  cappedKeys: Set<string>;
  budgetEvictedKeys: Set<string>;
  dmScopeRetiredKeys: Set<string>;
}): SessionCleanupAction {
  if (params.dmScopeRetiredKeys.has(params.key)) {
    return "retire-dm-scope";
  }
  if (params.missingKeys.has(params.key)) {
    return "prune-missing";
  }
  if (params.modelRunPrunedKeys.has(params.key)) {
    return "prune-model-run";
  }
  if (params.staleKeys.has(params.key)) {
    return "prune-stale";
  }
  if (params.cappedKeys.has(params.key)) {
    return "cap-overflow";
  }
  if (params.budgetEvictedKeys.has(params.key)) {
    return "evict-budget";
  }
  return "keep";
}

export function serializeSessionCleanupResult(params: {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  dryRun: boolean;
  summaries: SessionCleanupSummary[];
}): SessionsCleanupResult {
  if (params.summaries.length === 1) {
    return params.summaries[0] ?? ({} as SessionCleanupSummary);
  }
  return {
    allAgents: true,
    mode: params.mode,
    dryRun: params.dryRun,
    stores: params.summaries,
  };
}
