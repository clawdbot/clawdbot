import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatErrorMessage } from "../../infra/errors.js";
import type {
  SessionDiskBudgetSweepResult,
  SessionUnreferencedArtifactSweepResult,
} from "./disk-budget.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type { SessionStoreTarget } from "./targets.js";

export type SessionCleanupSummary = {
  agentId: string;
  storePath: string;
  mode: ResolvedSessionMaintenanceConfig["mode"];
  dryRun: boolean;
  beforeCount: number;
  afterCount: number;
  missing: number;
  dmScopeRetired: number;
  modelRunPruned: number;
  archived?: number;
  capArchived?: number;
  pruned: number;
  capped: number;
  unreferencedArtifacts: SessionUnreferencedArtifactSweepResult;
  diskBudget: SessionDiskBudgetSweepResult | null;
  wouldMutate: boolean;
  applied?: true;
  appliedCount?: number;
};

export type SessionsCleanupFailure = {
  target: SessionStoreTarget;
  message: string;
  lifecycleCommitted: boolean;
};

export function createSessionsCleanupFailure(
  target: SessionStoreTarget,
  cause: unknown,
  lifecycleCommitted: boolean,
): SessionsCleanupFailure {
  return {
    target,
    message: `Session cleanup failed for agent '${target.agentId}': ${formatErrorMessage(cause)}`,
    lifecycleCommitted,
  };
}

export class SessionsCleanupFailureError extends Error {
  constructor(
    readonly failure: SessionsCleanupFailure,
    cause: unknown,
  ) {
    super(failure.message, { cause });
    this.name = "SessionsCleanupFailureError";
  }
}

export type SessionsCleanupPartialErrorDetail = {
  failingAgentId: string;
  failingStorePath: string;
  message: string;
  lifecycleCommitted: boolean;
};

type SessionsCleanupAggregateResult = {
  allAgents: true;
  mode: ResolvedSessionMaintenanceConfig["mode"];
  dryRun: boolean;
  stores: SessionCleanupSummary[];
};

export type SessionsCleanupPartialResult = SessionsCleanupAggregateResult & {
  partialError: SessionsCleanupPartialErrorDetail;
};

export type SessionsCleanupResult =
  | SessionCleanupSummary
  | (SessionsCleanupAggregateResult & { partialError?: never })
  | SessionsCleanupPartialResult;

export function serializeSessionCleanupResult(params: {
  mode: ResolvedSessionMaintenanceConfig["mode"];
  dryRun: boolean;
  summaries: SessionCleanupSummary[];
  failure?: SessionsCleanupFailure;
}): SessionsCleanupResult {
  const summaries = params.summaries.map((summary) => ({
    ...summary,
    storePath: resolveSqliteTargetFromSessionStorePath(summary.storePath, {
      agentId: summary.agentId,
    }).path,
  }));
  const [summary] = summaries;
  // A partial failure exists only after another store completed, so it always
  // uses the aggregate shape and never fabricates a scalar store summary.
  if (summary && summaries.length === 1 && !params.failure) {
    return summary;
  }
  return {
    allAgents: true,
    mode: params.mode,
    dryRun: params.dryRun,
    stores: summaries,
    ...(params.failure
      ? {
          partialError: {
            failingAgentId: params.failure.target.agentId,
            failingStorePath: resolveSqliteTargetFromSessionStorePath(
              params.failure.target.storePath,
              { agentId: params.failure.target.agentId },
            ).path,
            message: params.failure.message,
            lifecycleCommitted: params.failure.lifecycleCommitted,
          },
        }
      : {}),
  };
}

function isSessionCleanupSummary(value: unknown): value is SessionCleanupSummary {
  if (!isRecord(value) || !isRecord(value.unreferencedArtifacts)) {
    return false;
  }
  return (
    typeof value.agentId === "string" &&
    typeof value.storePath === "string" &&
    (value.mode === "enforce" || value.mode === "warn") &&
    typeof value.dryRun === "boolean" &&
    typeof value.beforeCount === "number" &&
    typeof value.afterCount === "number" &&
    typeof value.missing === "number" &&
    typeof value.dmScopeRetired === "number" &&
    typeof value.modelRunPruned === "number" &&
    (value.archived === undefined || typeof value.archived === "number") &&
    (value.capArchived === undefined || typeof value.capArchived === "number") &&
    typeof value.pruned === "number" &&
    typeof value.capped === "number" &&
    typeof value.unreferencedArtifacts.removedFiles === "number" &&
    (value.diskBudget === null || isRecord(value.diskBudget)) &&
    typeof value.wouldMutate === "boolean" &&
    (value.applied === undefined || value.applied === true) &&
    (value.appliedCount === undefined || typeof value.appliedCount === "number")
  );
}

export function isSessionsCleanupPartialResult(
  value: unknown,
): value is SessionsCleanupPartialResult {
  if (!isRecord(value) || !isRecord(value.partialError)) {
    return false;
  }
  return (
    value.allAgents === true &&
    (value.mode === "enforce" || value.mode === "warn") &&
    typeof value.dryRun === "boolean" &&
    Array.isArray(value.stores) &&
    value.stores.every(isSessionCleanupSummary) &&
    typeof value.partialError.failingAgentId === "string" &&
    typeof value.partialError.failingStorePath === "string" &&
    typeof value.partialError.message === "string" &&
    typeof value.partialError.lifecycleCommitted === "boolean"
  );
}
