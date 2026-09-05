import { expectDefined } from "@openclaw/normalization-core";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  addCostUsageTotals,
  createEmptyCostUsageTotals,
} from "../../infra/session-cost-usage-totals.js";
import {
  loadCostUsageSummaryFromCache,
  type CostUsageSummary,
  type CostUsageTotals,
  type UsageCacheStatus,
  type UsageDailyBucket,
} from "../../infra/session-cost-usage.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { trackAsyncWork } from "../../shared/async-work-scope.js";
import type { SessionsUsageResult } from "../../shared/usage-types.js";
import { listGatewayAgentsBasic } from "../agent-list.js";
import { mergeUsageCacheStatus, runUsageAgentTasks } from "./usage-session-loading.js";
import type { UsageGroupingMode } from "./usage-session-selection.js";

const USAGE_CACHE_TTL_MS = 30_000;
const USAGE_CACHE_MAX = 256;

type UsageCacheEntry<T extends object> = {
  configRef: object;
  value?: T;
  updatedAt?: number;
  inFlight?: Promise<T>;
};

export const costUsageCache = new Map<string, UsageCacheEntry<CostUsageSummary>>();
export const sessionsUsageCache = new Map<string, UsageCacheEntry<SessionsUsageResult>>();

function setUsageCache<T extends object>(
  cache: Map<string, UsageCacheEntry<T>>,
  cacheKey: string,
  entry: UsageCacheEntry<T>,
): void {
  if (!cache.has(cacheKey) && cache.size >= USAGE_CACHE_MAX) {
    let evictionKey = cache.keys().next().value;
    // Preserve active loads whenever a settled entry can be evicted instead.
    for (const [key, candidate] of cache) {
      if (!candidate.inFlight) {
        evictionKey = key;
        break;
      }
    }
    if (evictionKey !== undefined) {
      cache.delete(evictionKey);
    }
  }
  cache.set(cacheKey, entry);
}

async function loadUsageResultCached<T extends object>(params: {
  cache: Map<string, UsageCacheEntry<T>>;
  cacheKey: string;
  configRef: object;
  load: () => Promise<T>;
  isComplete?: (value: T) => boolean;
}): Promise<T> {
  const { cache, cacheKey, configRef } = params;
  const candidate = cache.get(cacheKey);
  const cached = candidate?.configRef === configRef ? candidate : undefined;
  if (cached?.value && cached.updatedAt && Date.now() - cached.updatedAt < USAGE_CACHE_TTL_MS) {
    return cached.value;
  }
  if (cached?.inFlight) {
    return cached.value && cached.updatedAt ? cached.value : await cached.inFlight;
  }

  const entry: UsageCacheEntry<T> = cached ?? { configRef };
  // Stale responses and cache eviction do not release the initiating owner's work.
  const inFlight = trackAsyncWork(() =>
    params
      .load()
      .then((value) => {
        if (cache.get(cacheKey) !== entry) {
          return value;
        }
        if (params.isComplete?.(value) ?? true) {
          entry.value = value;
          entry.updatedAt = Date.now();
        } else if (!entry.value) {
          // Partial snapshots serve cold callers without masking the next refresh.
          entry.value = value;
          delete entry.updatedAt;
        }
        return value;
      })
      .catch((error: unknown) => {
        if (entry.value) {
          return entry.value;
        }
        throw error;
      })
      .finally(() => {
        const current = cache.get(cacheKey);
        if (current === entry && current.inFlight === inFlight) {
          current.inFlight = undefined;
        }
      }),
  );

  entry.inFlight = inFlight;
  setUsageCache(cache, cacheKey, entry);
  return entry.value && entry.updatedAt ? entry.value : await inFlight;
}

function usageDayBucketCacheKey(dayBucket: UsageDailyBucket | undefined): string {
  return dayBucket
    ? dayBucket.mode === "time-zone"
      ? `time-zone:${dayBucket.timeZone}`
      : `utc-offset:${dayBucket.utcOffsetMinutes}`
    : "gateway";
}

type SessionsUsageCacheKeyParams = {
  configRef: object;
  visibilityIdentity?: string;
  agentId?: string;
  agentScope?: "all";
  startMs: number;
  endMs: number;
  includeUntimestamped?: boolean;
  dayBucket?: UsageDailyBucket;
  limit: number;
  groupingMode: UsageGroupingMode;
  specificKey: string | null;
  includeContextWeight: boolean;
};

// Every normalized query axis that can change response bytes belongs in this
// key; the 30s TTL mirrors usage.cost and keeps dashboard refreshes coherent.
function sessionsUsageCacheKey(params: SessionsUsageCacheKeyParams): string {
  return JSON.stringify([
    params.agentScope === "all" ? "all" : `agent:${params.agentId}`,
    params.startMs,
    params.endMs,
    params.includeUntimestamped === true,
    usageDayBucketCacheKey(params.dayBucket),
    params.limit,
    params.groupingMode,
    params.specificKey,
    params.includeContextWeight,
    ...(params.visibilityIdentity ? [params.visibilityIdentity] : []),
  ]);
}

export async function loadSessionsUsageResultCached(
  params: SessionsUsageCacheKeyParams & {
    load: () => Promise<SessionsUsageResult>;
  },
): Promise<SessionsUsageResult> {
  return await loadUsageResultCached({
    cache: sessionsUsageCache,
    cacheKey: sessionsUsageCacheKey(params),
    configRef: params.configRef,
    load: params.load,
    // Incomplete lower-cache snapshots must not acquire the outer freshness TTL.
    isComplete: (result) => !result.cacheStatus || result.cacheStatus.status === "fresh",
  });
}

export async function loadCostUsageSummaryCached(params: {
  startMs: number;
  endMs: number;
  dayBucket?: UsageDailyBucket;
  config: OpenClawConfig;
  agentId?: string;
  agentScope?: "all";
}): Promise<CostUsageSummary> {
  const allAgents = params.agentScope === "all";
  const agentId = allAgents
    ? undefined
    : normalizeAgentId(params.agentId ?? resolveSessionAgentId({ config: params.config }));
  const dayBucketKey = usageDayBucketCacheKey(params.dayBucket);
  const cacheKey = `${allAgents ? "all" : `agent:${agentId}`}:${params.startMs}-${params.endMs}:${dayBucketKey}`;
  return await loadUsageResultCached({
    cache: costUsageCache,
    cacheKey,
    configRef: params.config,
    load: () =>
      allAgents
        ? loadAllAgentCostUsageSummary({
            startMs: params.startMs,
            endMs: params.endMs,
            dayBucket: params.dayBucket,
            config: params.config,
          })
        : loadCostUsageSummaryFromCache({
            startMs: params.startMs,
            endMs: params.endMs,
            dayBucket: params.dayBucket,
            config: params.config,
            agentId: expectDefined(agentId, "non-aggregate usage agent id"),
            requestRefresh: true,
            refreshMode: "background",
          }),
  });
}

async function loadAllAgentCostUsageSummary(params: {
  startMs: number;
  endMs: number;
  dayBucket?: UsageDailyBucket;
  config: OpenClawConfig;
}): Promise<CostUsageSummary> {
  // Same agent universe as discoverAllSessionsForUsage: enumerating configured
  // ids only would list system-agent sessions whose cost never reaches totals.
  const agentIds = listGatewayAgentsBasic(params.config).agents.map((agent) =>
    normalizeAgentId(agent.id),
  );
  const summaries = await runUsageAgentTasks(
    agentIds.map(
      (agentId) => () =>
        loadCostUsageSummaryFromCache({
          startMs: params.startMs,
          endMs: params.endMs,
          dayBucket: params.dayBucket,
          config: params.config,
          agentId,
          requestRefresh: true,
          refreshMode: "background",
        }),
    ),
  );
  const dailyByDate = new Map<string, CostUsageTotals & { date: string }>();
  const totals = createEmptyCostUsageTotals();
  let cacheStatus: UsageCacheStatus | undefined;
  let updatedAt = 0;
  let days = 0;
  for (const summary of summaries) {
    updatedAt = Math.max(updatedAt, summary.updatedAt);
    days = Math.max(days, summary.days);
    addCostUsageTotals(totals, summary.totals);
    if (summary.cacheStatus) {
      cacheStatus = mergeUsageCacheStatus(cacheStatus, summary.cacheStatus);
    }
    for (const day of summary.daily) {
      const entry = dailyByDate.get(day.date) ?? {
        date: day.date,
        ...createEmptyCostUsageTotals(),
      };
      addCostUsageTotals(entry, day);
      dailyByDate.set(day.date, entry);
    }
  }
  return {
    updatedAt,
    days,
    daily: Array.from(dailyByDate.values()).toSorted((a, b) => a.date.localeCompare(b.date)),
    totals,
    ...(cacheStatus ? { cacheStatus } : {}),
  };
}
