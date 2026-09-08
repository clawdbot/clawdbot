import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../shared/async-work-scope.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import { formatErrorMessage } from "./errors.js";
import {
  countUsableUsageCostRollups,
  getUsageCostStaleRollupFiles,
  isUsageCostRollupFresh,
  latestUsageCostRollupScan,
  readUsageCostRollups,
  refreshCostUsageCacheForAgent,
  resolveUsageCostAgentDir,
  resolveUsageCostCacheDatabasePath,
  resolveUsageCostPricingFingerprint,
} from "./session-cost-usage-aggregation.js";
import { isSessionCostUsageRefreshRunning } from "./session-cost-usage-cache.sqlite.js";
import {
  listUsageCountedTranscriptStats,
  resolveUsageCostTranscriptFile,
  USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY,
} from "./session-cost-usage-collection.js";
import {
  buildCostUsageSummaryFromRollups,
  createUsageDayKeyFormatter,
} from "./session-cost-usage-projection.js";
import { buildSessionCostSummaryFromRollup } from "./session-cost-usage-rollup.js";
import type {
  CostUsageSummary,
  SessionCostSummary,
  UsageCacheStatus,
  UsageDailyBucket,
} from "./session-cost-usage.types.js";

const USAGE_COST_REFRESH_RETRY_MIN_MS = 50;
const USAGE_COST_REFRESH_RETRY_MAX_MS = 5_000;
const logger = createSubsystemLogger("usage-cost-cache");

type UsageCostRefreshState = {
  agentId: string;
  config?: OpenClawConfig;
  databasePath: string;
  fullRefreshRequested: boolean;
  pendingSessionFiles: Set<string>;
  sessionsDir: string;
};

// Only active queues retain their scope; one owner cannot adopt another owner's work.
const usageCostRefreshes = new Map<AbortSignal | undefined, Map<string, UsageCostRefreshState>>();

function isUsageCostRefreshQueued(databasePath: string): boolean {
  return usageCostRefreshes.get(getAsyncWorkSignal())?.has(databasePath) === true;
}

export async function loadCostUsageSummary(params: {
  startMs?: number;
  endMs?: number;
  dayBucket?: UsageDailyBucket;
  config?: OpenClawConfig;
  agentId: string;
}): Promise<CostUsageSummary> {
  const now = Date.now();
  const defaultStart = new Date(now);
  defaultStart.setDate(defaultStart.getDate() - 29);
  const startMs = params.startMs ?? defaultStart.getTime();
  const endMs = params.endMs ?? now;
  const agentDir = resolveUsageCostAgentDir(params.config, params.agentId);
  const databasePath = resolveUsageCostCacheDatabasePath(params.agentId);
  const result = await refreshCostUsageCacheForAgent({
    config: params.config,
    agentId: params.agentId,
    agentDir,
    databasePath,
  });
  const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config, agentDir);
  const rollups = readUsageCostRollups(params.agentId, pricingFingerprint, databasePath);
  const files = await listUsageCountedTranscriptStats(params.agentId);
  return buildCostUsageSummaryFromRollups({
    rollups,
    files,
    startMs,
    endMs,
    dayBucket: params.dayBucket,
    refreshing:
      result === "busy" ||
      isUsageCostRefreshQueued(databasePath) ||
      isSessionCostUsageRefreshRunning(params.agentId, databasePath),
  });
}

export async function loadCostUsageSummaryFromCache(params: {
  startMs: number;
  endMs: number;
  dayBucket?: UsageDailyBucket;
  config?: OpenClawConfig;
  agentId: string;
  requestRefresh?: boolean;
  refreshMode?: "background" | "sync-when-empty";
}): Promise<CostUsageSummary> {
  const agentDir = resolveUsageCostAgentDir(params.config, params.agentId);
  const databasePath = resolveUsageCostCacheDatabasePath(params.agentId);
  const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config, agentDir);
  let rollups = readUsageCostRollups(params.agentId, pricingFingerprint, databasePath);
  let files = await listUsageCountedTranscriptStats(params.agentId);
  const staleFiles = getUsageCostStaleRollupFiles({ rollups, files });
  if (params.requestRefresh !== false && staleFiles.length > 0) {
    const cachedFiles = countUsableUsageCostRollups({ rollups, files });
    if (params.refreshMode === "sync-when-empty" && cachedFiles === 0) {
      const result = await refreshCostUsageCacheForAgent({
        config: params.config,
        agentId: params.agentId,
        agentDir,
        startMs: params.startMs,
      });
      rollups = readUsageCostRollups(params.agentId, pricingFingerprint, databasePath);
      files = await listUsageCountedTranscriptStats(params.agentId);
      if (result === "refreshed" && getUsageCostStaleRollupFiles({ rollups, files }).length > 0) {
        requestCostUsageCacheRefresh({ config: params.config, agentId: params.agentId });
      }
    } else {
      requestCostUsageCacheRefresh({ config: params.config, agentId: params.agentId });
    }
  }
  return buildCostUsageSummaryFromRollups({
    rollups,
    files,
    startMs: params.startMs,
    endMs: params.endMs,
    dayBucket: params.dayBucket,
    refreshing:
      isUsageCostRefreshQueued(databasePath) ||
      isSessionCostUsageRefreshRunning(params.agentId, databasePath),
  });
}

export async function loadSessionCostSummariesFromCache(params: {
  sessions: Array<{ sessionId?: string; sessionFile: string }>;
  config?: OpenClawConfig;
  agentId: string;
  startMs?: number;
  endMs?: number;
  includeUntimestamped?: boolean;
  dayBucket?: UsageDailyBucket;
  requestRefresh?: boolean;
}): Promise<{ summaries: Array<SessionCostSummary | null>; cacheStatus: UsageCacheStatus }> {
  const agentDir = resolveUsageCostAgentDir(params.config, params.agentId);
  const databasePath = resolveUsageCostCacheDatabasePath(params.agentId);
  const pricingFingerprint = resolveUsageCostPricingFingerprint(params.config, agentDir);
  const fileTasks = params.sessions.map(
    (session) => async () => await resolveUsageCostTranscriptFile(session.sessionFile),
  );
  const { results: files } = await runTasksWithConcurrency({
    tasks: fileTasks,
    limit: USAGE_COST_TRANSCRIPT_STAT_CONCURRENCY,
  });
  const rollups = readUsageCostRollups(params.agentId, pricingFingerprint, databasePath, {
    filePaths: files.flatMap((file) => (file ? [file.filePath] : [])),
  });
  const staleFiles = new Set<string>();
  let cachedFiles = 0;
  const hasExplicitRange = params.startMs !== undefined || params.endMs !== undefined;
  const startMs = params.startMs ?? Number.NEGATIVE_INFINITY;
  const endMs = params.endMs ?? Number.POSITIVE_INFINITY;
  const dayFormatter = createUsageDayKeyFormatter(params.dayBucket);
  const summaries = params.sessions.map((session, index) => {
    const file = files[index];
    const stored = file ? rollups.get(file.filePath) : undefined;
    if (!file || !stored || !isUsageCostRollupFresh({ stored, file })) {
      staleFiles.add(file?.sourcePath ?? session.sessionFile);
      return null;
    }
    cachedFiles += 1;
    return buildSessionCostSummaryFromRollup({
      rollup: stored.entry.rollup,
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      startMs,
      endMs,
      includeUntimestamped: params.includeUntimestamped === true || !hasExplicitRange,
      formatDay: dayFormatter,
    });
  });
  const refreshRequested = params.requestRefresh !== false && staleFiles.size > 0;
  if (refreshRequested) {
    requestCostUsageCacheRefresh({
      config: params.config,
      agentId: params.agentId,
      sessionFiles: [...staleFiles],
    });
  }
  const refreshRunning = isSessionCostUsageRefreshRunning(params.agentId, databasePath);
  return {
    summaries,
    cacheStatus: {
      status:
        staleFiles.size === 0
          ? "fresh"
          : refreshRunning || refreshRequested
            ? "refreshing"
            : cachedFiles > 0
              ? "partial"
              : "stale",
      cachedFiles,
      pendingFiles: staleFiles.size,
      staleFiles: staleFiles.size,
      refreshedAt: latestUsageCostRollupScan(rollups),
    },
  };
}

function requestCostUsageCacheRefresh(params: {
  config?: OpenClawConfig;
  agentId: string;
  sessionFiles?: string[];
}): void {
  const scopeSignal = getAsyncWorkSignal();
  if (scopeSignal?.aborted) {
    return;
  }
  const databasePath = resolveUsageCostCacheDatabasePath(params.agentId);
  const refreshes = usageCostRefreshes.get(scopeSignal) ?? new Map<string, UsageCostRefreshState>();
  const existing = refreshes.get(databasePath);
  if (existing) {
    mergeUsageCostRefreshRequest(existing, params);
    return;
  }

  const state: UsageCostRefreshState = {
    agentId: params.agentId,
    config: params.config,
    databasePath,
    fullRefreshRequested: false,
    pendingSessionFiles: new Set(),
    sessionsDir: resolveSessionTranscriptsDirForAgent(params.agentId),
  };
  mergeUsageCostRefreshRequest(state, params);
  usageCostRefreshes.set(scopeSignal, refreshes);
  // Register the initial timer and every retry now, not after a timer fires.
  refreshes.set(databasePath, state);
  void trackAsyncWork(() => runQueuedUsageCostRefresh(state, refreshes, scopeSignal));
}

function mergeUsageCostRefreshRequest(
  state: UsageCostRefreshState,
  params: {
    config?: OpenClawConfig;
    agentId: string;
    sessionFiles?: string[];
  },
): void {
  if (params.config) {
    state.config = params.config;
  }
  state.agentId = params.agentId;
  if (!params.sessionFiles) {
    state.fullRefreshRequested = true;
    return;
  }
  for (const sessionFile of params.sessionFiles) {
    state.pendingSessionFiles.add(sessionFile);
  }
}

function waitForUsageCostRefresh(signal: AbortSignal | undefined, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    // Zero must remain a real timer so cache reads return before refresh starts.
    const timer = setTimeout(finish, delayMs);
    timer.unref?.();
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
    signal?.addEventListener("abort", finish, { once: true });
    if (signal?.aborted) {
      finish();
    }
  });
}

async function runQueuedUsageCostRefresh(
  state: UsageCostRefreshState,
  refreshes: Map<string, UsageCostRefreshState>,
  signal: AbortSignal | undefined,
): Promise<void> {
  let busyRetryDelayMs = USAGE_COST_REFRESH_RETRY_MIN_MS;
  let retryDelayMs = 0;
  try {
    do {
      await waitForUsageCostRefresh(signal, retryDelayMs);
      if (signal?.aborted) {
        return;
      }
      retryDelayMs = 0;
      try {
        while (state.fullRefreshRequested || state.pendingSessionFiles.size > 0) {
          const fullRefreshRequested = state.fullRefreshRequested;
          const sessionFiles = fullRefreshRequested ? [] : [...state.pendingSessionFiles];
          if (!fullRefreshRequested) {
            state.pendingSessionFiles.clear();
          }
          state.fullRefreshRequested = false;
          const result = await refreshCostUsageCacheForAgent({
            config: state.config,
            agentId: state.agentId,
            databasePath: state.databasePath,
            sessionsDir: state.sessionsDir,
            sessionFiles: fullRefreshRequested ? undefined : sessionFiles,
          });
          if (signal?.aborted) {
            return;
          }
          if (result === "busy") {
            if (fullRefreshRequested) {
              state.fullRefreshRequested = true;
            } else {
              for (const sessionFile of sessionFiles) {
                state.pendingSessionFiles.add(sessionFile);
              }
            }
            retryDelayMs = busyRetryDelayMs;
            // Contention among many per-agent refreshes must degrade to polling, not a 20Hz spin.
            busyRetryDelayMs = Math.min(busyRetryDelayMs * 2, USAGE_COST_REFRESH_RETRY_MAX_MS);
            break;
          }
          busyRetryDelayMs = USAGE_COST_REFRESH_RETRY_MIN_MS;
        }
      } catch (error) {
        logger.warn(`background refresh failed: ${formatErrorMessage(error)}`, { error });
        if (signal?.aborted) {
          return;
        }
      }
    } while (state.fullRefreshRequested || state.pendingSessionFiles.size > 0);
  } finally {
    // Remove synchronously with completion; a late request must enqueue a new owner.
    refreshes.delete(state.databasePath);
    if (refreshes.size === 0) {
      usageCostRefreshes.delete(signal);
    }
  }
}
