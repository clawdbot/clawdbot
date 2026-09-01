import {
  addCostUsageTotals,
  createEmptyCostUsageTotals,
} from "../infra/session-cost-usage-totals.js";
import type {
  CostUsageTotals,
  SessionDailyModelUsage,
  SessionLatencyStats,
  SessionModelUsage,
} from "../infra/session-cost-usage.types.js";
import type { SessionUsageEntry, SessionsUsageAggregates } from "./usage-types.js";

type LatencyAccumulator = {
  count: number;
  sum: number;
  min: number;
  max: number;
  p95Max: number;
};

/** Builds a collision-free identity while preserving legacy missing-as-unknown grouping. */
export function usageModelIdentity(provider?: string, model?: string): string {
  return JSON.stringify([provider ?? "unknown", model ?? "unknown"]);
}

/** Extends the model identity with its calendar bucket without delimiter ambiguity. */
export function usageDailyModelIdentity(date: string, provider?: string, model?: string): string {
  return JSON.stringify([date, provider ?? "unknown", model ?? "unknown"]);
}

function createLatencyAccumulator(): LatencyAccumulator {
  return { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: 0, p95Max: 0 };
}

// Session summaries carry no raw samples: weight averages by count and retain the largest p95.
function mergeLatency(target: LatencyAccumulator, source: SessionLatencyStats): void {
  target.count += source.count;
  target.sum += source.avgMs * source.count;
  target.min = Math.min(target.min, source.minMs);
  target.max = Math.max(target.max, source.maxMs);
  target.p95Max = Math.max(target.p95Max, source.p95Ms);
}

function summarizeLatency(value: LatencyAccumulator): SessionLatencyStats {
  return {
    count: value.count,
    avgMs: value.count ? value.sum / value.count : 0,
    // Empty daily buckets must not expose the sentinel used for min comparisons.
    minMs: value.min === Number.POSITIVE_INFINITY ? 0 : value.min,
    maxMs: value.max,
    p95Ms: value.p95Max,
  };
}

function mergeModelUsage(
  map: Map<string, SessionModelUsage>,
  key: string,
  entry: SessionModelUsage,
): void {
  const existing = map.get(key) ?? {
    provider: entry.provider,
    model: entry.model,
    count: 0,
    totals: createEmptyCostUsageTotals(),
  };
  existing.count += entry.count;
  addCostUsageTotals(existing.totals, entry.totals);
  map.set(key, existing);
}

function mergeGroupedTotals(
  map: Map<string, CostUsageTotals>,
  key: string | undefined,
  usage: CostUsageTotals,
): void {
  if (!key) {
    return;
  }
  const totals = map.get(key) ?? createEmptyCostUsageTotals();
  addCostUsageTotals(totals, usage);
  map.set(key, totals);
}

function compareModelUsage(left: SessionModelUsage, right: SessionModelUsage): number {
  return (
    right.totals.totalCost - left.totals.totalCost ||
    right.totals.totalTokens - left.totals.totalTokens
  );
}

/** Shared accounting for gateway-wide results and filtered Control UI session rows. */
export function createUsageAggregateAccumulator() {
  const totals = createEmptyCostUsageTotals();
  const messages = { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 };
  const tools = new Map<string, number>();
  const models = new Map<string, SessionModelUsage>();
  const providers = new Map<string, SessionModelUsage>();
  const agents = new Map<string, CostUsageTotals>();
  const channels = new Map<string, CostUsageTotals>();
  const days = new Map<string, SessionsUsageAggregates["daily"][number]>();
  const dailyLatency = new Map<string, LatencyAccumulator>();
  const dailyModels = new Map<string, SessionDailyModelUsage>();
  const latency = createLatencyAccumulator();
  let sessionCount = 0;
  let longestSessionDurationMs = 0;

  function getDay(date: string) {
    let day = days.get(date);
    if (!day) {
      day = { date, tokens: 0, cost: 0, messages: 0, toolCalls: 0, errors: 0 };
      days.set(date, day);
    }
    return day;
  }

  function add({
    usage,
    agentId,
    channel,
  }: Pick<SessionUsageEntry, "usage" | "agentId" | "channel">) {
    if (!usage) {
      return;
    }
    addCostUsageTotals(totals, usage);
    longestSessionDurationMs = Math.max(longestSessionDurationMs, usage.durationMs ?? 0);
    // Discovery can include recently modified transcripts with no activity in the requested range.
    if (usage.firstActivity !== undefined || (usage.messageCounts?.total ?? 0) > 0) {
      sessionCount += 1;
    }
    if (usage.messageCounts) {
      messages.total += usage.messageCounts.total;
      messages.user += usage.messageCounts.user;
      messages.assistant += usage.messageCounts.assistant;
      messages.toolCalls += usage.messageCounts.toolCalls;
      messages.toolResults += usage.messageCounts.toolResults;
      messages.errors += usage.messageCounts.errors;
    }
    for (const tool of usage.toolUsage?.tools ?? []) {
      tools.set(tool.name, (tools.get(tool.name) ?? 0) + tool.count);
    }
    for (const entry of usage.modelUsage ?? []) {
      mergeModelUsage(models, usageModelIdentity(entry.provider, entry.model), entry);
      mergeModelUsage(providers, entry.provider ?? "unknown", { ...entry, model: undefined });
    }
    mergeGroupedTotals(agents, agentId, usage);
    mergeGroupedTotals(channels, channel, usage);
    if (usage.latency && usage.latency.count > 0) {
      mergeLatency(latency, usage.latency);
    }
    for (const day of usage.dailyLatency ?? []) {
      const existing = dailyLatency.get(day.date) ?? createLatencyAccumulator();
      mergeLatency(existing, day);
      dailyLatency.set(day.date, existing);
    }
    for (const day of usage.dailyBreakdown ?? []) {
      const existing = getDay(day.date);
      existing.tokens += day.tokens;
      existing.cost += day.cost;
    }
    for (const day of usage.dailyMessageCounts ?? []) {
      const existing = getDay(day.date);
      existing.messages += day.total;
      existing.toolCalls += day.toolCalls;
      existing.errors += day.errors;
    }
    for (const day of usage.dailyModelUsage ?? []) {
      const key = usageDailyModelIdentity(day.date, day.provider, day.model);
      const existing = dailyModels.get(key) ?? {
        date: day.date,
        provider: day.provider,
        model: day.model,
        tokens: 0,
        cost: 0,
        count: 0,
      };
      existing.tokens += day.tokens;
      existing.cost += day.cost;
      existing.count += day.count;
      dailyModels.set(key, existing);
    }
  }

  function finish(): SessionsUsageAggregates {
    const toolEntries = Array.from(tools, ([name, count]) => ({ name, count })).toSorted(
      (a, b) => b.count - a.count,
    );
    return {
      sessionCount,
      ...(longestSessionDurationMs > 0 ? { longestSessionDurationMs } : {}),
      messages,
      tools: {
        totalCalls: toolEntries.reduce((sum, { count }) => sum + count, 0),
        uniqueTools: tools.size,
        tools: toolEntries,
      },
      byModel: Array.from(models.values()).toSorted(compareModelUsage),
      byProvider: Array.from(providers.values()).toSorted(compareModelUsage),
      byAgent: Array.from(agents, ([agentId, groupTotals]) => ({
        agentId,
        totals: groupTotals,
      })).toSorted((a, b) => b.totals.totalCost - a.totals.totalCost),
      byChannel: Array.from(channels, ([channel, groupTotals]) => ({
        channel,
        totals: groupTotals,
      })).toSorted((a, b) => b.totals.totalCost - a.totals.totalCost),
      latency: latency.count > 0 ? summarizeLatency(latency) : undefined,
      dailyLatency: Array.from(dailyLatency, ([date, value]) => ({
        date,
        ...summarizeLatency(value),
      })).toSorted((a, b) => a.date.localeCompare(b.date)),
      modelDaily: Array.from(dailyModels.values()).toSorted(
        (a, b) => a.date.localeCompare(b.date) || b.cost - a.cost,
      ),
      daily: Array.from(days.values()).toSorted((a, b) => a.date.localeCompare(b.date)),
    };
  }

  return { totals, add, finish };
}
