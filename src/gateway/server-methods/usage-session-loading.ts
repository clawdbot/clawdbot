import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { mergeSessionCostSummaryInto } from "../../infra/session-cost-usage-rollup.js";
import { createEmptyCostUsageTotals } from "../../infra/session-cost-usage-totals.js";
import {
  discoverAllSessions,
  loadSessionCostSummariesFromCache,
  type DiscoveredSession,
  type SessionCostSummary,
  type UsageDailyBucket,
  type UsageCacheStatus,
} from "../../infra/session-cost-usage.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { listGatewayAgentsBasic } from "../agent-list.js";
import type { UsageSessionSelection } from "./usage-session-selection.js";

type DiscoveredSessionWithAgent = DiscoveredSession & { agentId: string };

const USAGE_AGENT_LOAD_CONCURRENCY = 12;

export async function runUsageAgentTasks<T>(tasks: Array<() => Promise<T>>): Promise<T[]> {
  const result = await runTasksWithConcurrency({
    tasks,
    limit: USAGE_AGENT_LOAD_CONCURRENCY,
    errorMode: "stop",
  });
  // These fan-outs historically rejected as one unit. Never return partial
  // per-agent usage; successful results retain their input order.
  if (result.hasError) {
    throw result.firstError;
  }
  return result.results;
}

export async function discoverAllSessionsForUsage(params: {
  config: OpenClawConfig;
  agentId?: string;
  startMs: number;
  endMs: number;
}): Promise<DiscoveredSessionWithAgent[]> {
  const requestedAgentId = normalizeOptionalString(params.agentId);
  const agents = requestedAgentId
    ? [{ id: normalizeAgentId(requestedAgentId) }]
    : listGatewayAgentsBasic(params.config).agents;
  const discovered = await runUsageAgentTasks(
    agents.map((agent) => async () => {
      const agentId = normalizeAgentId(agent.id);
      const sessions = await discoverAllSessions({
        agentId,
        startMs: params.startMs,
        endMs: params.endMs,
        includeFirstUserMessage: false,
      });
      return sessions.map((session) => Object.assign({}, session, { agentId }));
    }),
  );
  return discovered.flat().toSorted((a, b) => b.mtime - a.mtime);
}

export function mergeUsageCacheStatus(
  target: UsageCacheStatus | undefined,
  source: UsageCacheStatus,
): UsageCacheStatus {
  if (!target) {
    return { ...source };
  }
  const statusRank = { fresh: 0, partial: 1, stale: 2, refreshing: 3 } as const;
  return {
    status: statusRank[source.status] > statusRank[target.status] ? source.status : target.status,
    cachedFiles: target.cachedFiles + source.cachedFiles,
    pendingFiles: target.pendingFiles + source.pendingFiles,
    staleFiles: target.staleFiles + source.staleFiles,
    refreshedAt:
      target.refreshedAt === undefined
        ? source.refreshedAt
        : source.refreshedAt === undefined
          ? target.refreshedAt
          : Math.max(target.refreshedAt, source.refreshedAt),
  };
}

export async function loadUsageSessionSummaries(params: {
  entries: UsageSessionSelection[];
  config: OpenClawConfig;
  startMs: number;
  endMs: number;
  includeUntimestamped?: boolean;
  dayBucket?: UsageDailyBucket;
}) {
  const {
    entries: mergedEntries,
    config,
    startMs,
    endMs,
    includeUntimestamped,
    dayBucket,
  } = params;
  let cacheStatus: UsageCacheStatus | undefined;
  const usageByEntryIndex: Array<SessionCostSummary | null> = Array.from(
    { length: mergedEntries.length },
    () => null,
  );

  // Batch all included instances by agent so cache reads do not scale with the row limit.
  const sessionsByAgent = new Map<
    string,
    Array<{ entryIndex: number; sessionId: string; sessionFile: string }>
  >();
  for (const [entryIndex, merged] of mergedEntries.entries()) {
    for (const { sessionId, sessionFile } of merged.instances) {
      const agentSessions = sessionsByAgent.get(merged.agentId) ?? [];
      agentSessions.push({
        entryIndex,
        sessionId,
        sessionFile,
      });
      sessionsByAgent.set(merged.agentId, agentSessions);
    }
  }

  const agentLoads = await runUsageAgentTasks(
    Array.from(sessionsByAgent.entries()).map(([agentId, agentSessions]) => async () => ({
      agentSessions,
      loaded: await loadSessionCostSummariesFromCache({
        sessions: agentSessions,
        config,
        agentId,
        startMs,
        endMs,
        includeUntimestamped,
        dayBucket,
      }),
    })),
  );
  for (const { agentSessions, loaded } of agentLoads) {
    cacheStatus = mergeUsageCacheStatus(cacheStatus, loaded.cacheStatus);
    for (const [index, summary] of loaded.summaries.entries()) {
      if (!summary) {
        continue;
      }
      const session = expectDefined(agentSessions[index], "agent sessions entry at index");
      const merged = expectDefined(
        mergedEntries[session.entryIndex],
        "merged entries entry at session.entry index",
      );
      const usage: SessionCostSummary =
        usageByEntryIndex[session.entryIndex] ?? createEmptyCostUsageTotals();
      usage.sessionId = merged.sessionId;
      usage.sessionFile = merged.sessionFile;
      mergeSessionCostSummaryInto(usage, summary);
      usageByEntryIndex[session.entryIndex] = usage;
    }
  }

  return { summaries: usageByEntryIndex, cacheStatus };
}
