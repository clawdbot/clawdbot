import {
  addCostUsageTotals,
  cloneCostUsageTotals,
  createEmptyCostUsageTotals,
} from "./session-cost-usage-totals.js";
import type {
  CostUsageTotals,
  SessionCostSummary,
  SessionDailyLatency,
  SessionDailyMessageCounts,
  SessionDailyModelUsage,
  SessionLatencyStats,
  SessionMessageCounts,
  SessionModelUsage,
  SessionUtcQuarterHourMessageCounts,
  SessionUtcQuarterHourTokenUsage,
  SessionToolUsage,
} from "./session-cost-usage.types.js";

const MAX_LATENCY_MS = 12 * 60 * 60 * 1000;
const MAX_LATENCY_CENTROIDS = 64;
const ERROR_STOP_REASONS = new Set(["error", "aborted", "timeout"]);

type UsageDayKeyFormatter = (date: Date) => string;

type SessionUsageLatencyCentroid = {
  count: number;
  value: number;
};

type SessionUsageLatencyAggregate = {
  centroids: SessionUsageLatencyCentroid[];
  count: number;
  max: number;
  min?: number;
  sum: number;
};

type SessionUsageRollupBucket = {
  timestampMs: number;
  totals: CostUsageTotals;
  messageCounts: SessionMessageCounts;
  tools: Array<{ name: string; count: number }>;
  models: SessionModelUsage[];
  latency: SessionUsageLatencyAggregate;
};

type SessionUsageUntimestampedRollup = {
  totals: CostUsageTotals;
  messageCounts: SessionMessageCounts;
  tools: Array<{ name: string; count: number }>;
  models: SessionModelUsage[];
};

export type SessionUsageRollupData = {
  buckets: Record<string, SessionUsageRollupBucket>;
  lastUserTimestamp?: number;
  untimestamped: SessionUsageUntimestampedRollup;
};

type SessionUsageRollupContribution = {
  timestamp?: number;
  role?: "user" | "assistant";
  durationMs?: number;
  provider?: string;
  model?: string;
  stopReason?: string;
  toolNames: string[];
  toolResultCounts: { total: number; errors: number };
  usageTotals?: CostUsageTotals;
};

function emptyMessageCounts(): SessionMessageCounts {
  return { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 };
}

function createLatencyAggregate(): SessionUsageLatencyAggregate {
  return { centroids: [], count: 0, max: 0, sum: 0 };
}

function compressLatencyCentroids(aggregate: SessionUsageLatencyAggregate): void {
  while (aggregate.centroids.length > MAX_LATENCY_CENTROIDS) {
    aggregate.centroids.sort((a, b) => a.value - b.value);
    let mergeIndex = 0;
    let smallestGap = Number.POSITIVE_INFINITY;
    for (let index = 1; index < aggregate.centroids.length; index += 1) {
      const gap =
        (aggregate.centroids[index]?.value ?? 0) - (aggregate.centroids[index - 1]?.value ?? 0);
      if (gap < smallestGap) {
        smallestGap = gap;
        mergeIndex = index - 1;
      }
    }
    const left = aggregate.centroids[mergeIndex];
    const right = aggregate.centroids[mergeIndex + 1];
    if (!left || !right) {
      break;
    }
    const count = left.count + right.count;
    aggregate.centroids.splice(mergeIndex, 2, {
      count,
      value: (left.value * left.count + right.value * right.count) / count,
    });
  }
}

function addLatencyValue(aggregate: SessionUsageLatencyAggregate, value: number): void {
  const wasEmpty = aggregate.count === 0;
  aggregate.count += 1;
  aggregate.sum += value;
  aggregate.min = wasEmpty ? value : Math.min(aggregate.min ?? value, value);
  aggregate.max = Math.max(aggregate.max, value);
  aggregate.centroids.push({ count: 1, value });
  compressLatencyCentroids(aggregate);
}

function mergeLatencyAggregate(
  target: SessionUsageLatencyAggregate,
  source: SessionUsageLatencyAggregate,
): void {
  if (source.count === 0) {
    return;
  }
  const targetWasEmpty = target.count === 0;
  const sourceMin = source.min ?? source.max;
  target.count += source.count;
  target.sum += source.sum;
  target.min = targetWasEmpty ? sourceMin : Math.min(target.min ?? target.max, sourceMin);
  target.max = Math.max(target.max, source.max);
  target.centroids.push(
    ...source.centroids.map((centroid) => ({ count: centroid.count, value: centroid.value })),
  );
  compressLatencyCentroids(target);
}

function createUntimestampedRollup(): SessionUsageUntimestampedRollup {
  return {
    totals: createEmptyCostUsageTotals(),
    messageCounts: emptyMessageCounts(),
    tools: [],
    models: [],
  };
}

export function createSessionUsageRollupData(): SessionUsageRollupData {
  return { buckets: {}, untimestamped: createUntimestampedRollup() };
}

function incrementTool(tools: Array<{ name: string; count: number }>, name: string): void {
  const existing = tools.find((entry) => entry.name === name);
  if (existing) {
    existing.count += 1;
  } else {
    tools.push({ name, count: 1 });
  }
}

function mergeTools(
  target: Map<string, number>,
  tools: ReadonlyArray<{ name: string; count: number }>,
): void {
  for (const tool of tools) {
    target.set(tool.name, (target.get(tool.name) ?? 0) + tool.count);
  }
}

function modelKey(provider?: string, model?: string): string {
  return `${provider ?? "unknown"}\0${model ?? "unknown"}`;
}

function addModelUsage(
  models: SessionModelUsage[],
  provider: string | undefined,
  model: string | undefined,
  totals: CostUsageTotals,
): void {
  if (!provider && !model) {
    return;
  }
  const modelRef = modelKey(provider, model);
  let existing = models.find((entry) => modelKey(entry.provider, entry.model) === modelRef);
  if (!existing) {
    existing = { provider, model, count: 0, totals: createEmptyCostUsageTotals() };
    models.push(existing);
  }
  existing.count += 1;
  addCostUsageTotals(existing.totals, totals);
}

function mergeModels(target: Map<string, SessionModelUsage>, models: SessionModelUsage[]): void {
  for (const model of models) {
    const modelRef = modelKey(model.provider, model.model);
    const existing = target.get(modelRef) ?? {
      provider: model.provider,
      model: model.model,
      count: 0,
      totals: createEmptyCostUsageTotals(),
    };
    existing.count += model.count;
    addCostUsageTotals(existing.totals, model.totals);
    target.set(modelRef, existing);
  }
}

function addMessageContribution(
  target: SessionMessageCounts,
  contribution: SessionUsageRollupContribution,
): void {
  if (contribution.role === "user") {
    target.user += 1;
    target.total += 1;
  } else if (contribution.role === "assistant") {
    target.assistant += 1;
    target.total += 1;
  }
  target.toolCalls += contribution.toolNames.length;
  target.toolResults += contribution.toolResultCounts.total;
  target.errors += contribution.toolResultCounts.errors;
  if (contribution.stopReason && ERROR_STOP_REASONS.has(contribution.stopReason)) {
    target.errors += 1;
  }
}

function createBucket(timestampMs: number): SessionUsageRollupBucket {
  return {
    timestampMs,
    totals: createEmptyCostUsageTotals(),
    messageCounts: emptyMessageCounts(),
    tools: [],
    models: [],
    latency: createLatencyAggregate(),
  };
}

export function appendSessionUsageRollupContribution(
  rollup: SessionUsageRollupData,
  contribution: SessionUsageRollupContribution,
): void {
  const timestamp = contribution.timestamp;
  if (timestamp === undefined) {
    addMessageContribution(rollup.untimestamped.messageCounts, contribution);
    for (const toolName of contribution.toolNames) {
      incrementTool(rollup.untimestamped.tools, toolName);
    }
    if (contribution.usageTotals) {
      addCostUsageTotals(rollup.untimestamped.totals, contribution.usageTotals);
      addModelUsage(
        rollup.untimestamped.models,
        contribution.provider,
        contribution.model,
        contribution.usageTotals,
      );
    }
    return;
  }
  const bucket = (rollup.buckets[String(timestamp)] ??= createBucket(timestamp));
  addMessageContribution(bucket.messageCounts, contribution);
  for (const toolName of contribution.toolNames) {
    incrementTool(bucket.tools, toolName);
  }
  if (contribution.usageTotals) {
    addCostUsageTotals(bucket.totals, contribution.usageTotals);
    addModelUsage(
      bucket.models,
      contribution.provider,
      contribution.model,
      contribution.usageTotals,
    );
  }
  if (contribution.role === "assistant") {
    const sourceUserTimestamp =
      contribution.durationMs === undefined ? rollup.lastUserTimestamp : undefined;
    const latencyMs =
      contribution.durationMs ??
      (sourceUserTimestamp !== undefined
        ? Math.max(0, timestamp - sourceUserTimestamp)
        : undefined);
    if (latencyMs !== undefined && Number.isFinite(latencyMs) && latencyMs <= MAX_LATENCY_MS) {
      addLatencyValue(bucket.latency, latencyMs);
    }
  }
  if (contribution.role === "user") {
    rollup.lastUserTimestamp = timestamp;
  }
}

function computeLatencyStats(
  aggregate: SessionUsageLatencyAggregate,
): SessionLatencyStats | undefined {
  if (aggregate.count === 0) {
    return undefined;
  }
  const targetCount = Math.ceil(aggregate.count * 0.95);
  let seen = 0;
  let p95Ms = aggregate.max;
  for (const centroid of aggregate.centroids.toSorted((a, b) => a.value - b.value)) {
    seen += centroid.count;
    if (seen >= targetCount) {
      p95Ms = centroid.value;
      break;
    }
  }
  return {
    count: aggregate.count,
    avgMs: aggregate.sum / aggregate.count,
    p95Ms,
    minMs: aggregate.min ?? aggregate.max,
    maxMs: aggregate.max,
  };
}

function getUtcQuarterHourBucketKey(date: Date): {
  date: string;
  quarterIndex: number;
  bucketId: string;
} {
  const dateKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  const quarterIndex = Math.floor((date.getUTCHours() * 60 + date.getUTCMinutes()) / 15);
  return { date: dateKey, quarterIndex, bucketId: `${dateKey}\0${quarterIndex}` };
}

function addMessageCounts(target: SessionMessageCounts, source: SessionMessageCounts): void {
  target.total += source.total;
  target.user += source.user;
  target.assistant += source.assistant;
  target.toolCalls += source.toolCalls;
  target.toolResults += source.toolResults;
  target.errors += source.errors;
}

function sortedModelUsage(models: Map<string, SessionModelUsage>): SessionModelUsage[] | undefined {
  if (models.size === 0) {
    return undefined;
  }
  return Array.from(models.values()).toSorted((a, b) => {
    const costDiff = b.totals.totalCost - a.totals.totalCost;
    return costDiff || b.totals.totalTokens - a.totals.totalTokens;
  });
}

function buildToolUsage(tools: Map<string, number>): SessionToolUsage | undefined {
  if (tools.size === 0) {
    return undefined;
  }
  const entries = Array.from(tools.entries())
    .map(([name, count]) => ({ name, count }))
    .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return {
    totalCalls: entries.reduce((sum, entry) => sum + entry.count, 0),
    uniqueTools: entries.length,
    tools: entries,
  };
}

function usageBucketsInRange(
  rollup: SessionUsageRollupData,
  startMs: number,
  endMs: number,
): SessionUsageRollupBucket[] {
  return Object.values(rollup.buckets)
    .filter((bucket) => bucket.timestampMs >= startMs && bucket.timestampMs <= endMs)
    .toSorted((a, b) => a.timestampMs - b.timestampMs);
}

export function buildSessionCostSummaryFromRollup(params: {
  rollup: SessionUsageRollupData;
  sessionId?: string;
  sessionFile: string;
  startMs: number;
  endMs: number;
  includeUntimestamped: boolean;
  formatDay: UsageDayKeyFormatter;
}): SessionCostSummary {
  const totals = createEmptyCostUsageTotals();
  const messageCounts = emptyMessageCounts();
  const tools = new Map<string, number>();
  const models = new Map<string, SessionModelUsage>();
  const activityDates = new Set<string>();
  const dailyUsage = new Map<string, { tokens: number; cost: number }>();
  const dailyMessages = new Map<string, SessionDailyMessageCounts>();
  const quarterMessages = new Map<string, SessionUtcQuarterHourMessageCounts>();
  const quarterTokens = new Map<string, SessionUtcQuarterHourTokenUsage>();
  const dailyLatencies = new Map<string, SessionUsageLatencyAggregate>();
  const dailyModels = new Map<string, SessionDailyModelUsage>();
  const allLatencies = createLatencyAggregate();
  let firstActivity: number | undefined;
  let lastActivity: number | undefined;

  const mergeBucket = (bucket: SessionUsageRollupBucket): void => {
    const date = new Date(bucket.timestampMs);
    const dayKey = params.formatDay(date);
    const quarter = getUtcQuarterHourBucketKey(date);
    firstActivity =
      firstActivity === undefined
        ? bucket.timestampMs
        : Math.min(firstActivity, bucket.timestampMs);
    lastActivity =
      lastActivity === undefined ? bucket.timestampMs : Math.max(lastActivity, bucket.timestampMs);
    activityDates.add(dayKey);
    addCostUsageTotals(totals, bucket.totals);
    addMessageCounts(messageCounts, bucket.messageCounts);
    mergeTools(tools, bucket.tools);
    mergeModels(models, bucket.models);

    const daily = dailyUsage.get(dayKey) ?? { tokens: 0, cost: 0 };
    daily.tokens += bucket.totals.totalTokens;
    daily.cost += bucket.totals.totalCost;
    dailyUsage.set(dayKey, daily);

    const dailyMessage = dailyMessages.get(dayKey) ?? { date: dayKey, ...emptyMessageCounts() };
    addMessageCounts(dailyMessage, bucket.messageCounts);
    dailyMessages.set(dayKey, dailyMessage);

    const quarterMessage = quarterMessages.get(quarter.bucketId) ?? {
      date: quarter.date,
      quarterIndex: quarter.quarterIndex,
      ...emptyMessageCounts(),
    };
    addMessageCounts(quarterMessage, bucket.messageCounts);
    quarterMessages.set(quarter.bucketId, quarterMessage);

    const quarterUsage = quarterTokens.get(quarter.bucketId) ?? {
      date: quarter.date,
      quarterIndex: quarter.quarterIndex,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      totalCost: 0,
    };
    quarterUsage.input += bucket.totals.input;
    quarterUsage.output += bucket.totals.output;
    quarterUsage.cacheRead += bucket.totals.cacheRead;
    quarterUsage.cacheWrite += bucket.totals.cacheWrite;
    quarterUsage.totalTokens += bucket.totals.totalTokens;
    quarterUsage.totalCost += bucket.totals.totalCost;
    quarterTokens.set(quarter.bucketId, quarterUsage);

    for (const model of bucket.models) {
      const modelBucketId = `${dayKey}\0${modelKey(model.provider, model.model)}`;
      const existing = dailyModels.get(modelBucketId) ?? {
        date: dayKey,
        provider: model.provider,
        model: model.model,
        tokens: 0,
        cost: 0,
        count: 0,
      };
      existing.tokens += model.totals.totalTokens;
      existing.cost += model.totals.totalCost;
      existing.count += model.count;
      dailyModels.set(modelBucketId, existing);
    }

    mergeLatencyAggregate(allLatencies, bucket.latency);
    const dailyLatency = dailyLatencies.get(dayKey) ?? createLatencyAggregate();
    mergeLatencyAggregate(dailyLatency, bucket.latency);
    dailyLatencies.set(dayKey, dailyLatency);
  };

  for (const bucket of usageBucketsInRange(params.rollup, params.startMs, params.endMs)) {
    mergeBucket(bucket);
  }
  if (params.includeUntimestamped) {
    addCostUsageTotals(totals, params.rollup.untimestamped.totals);
    addMessageCounts(messageCounts, params.rollup.untimestamped.messageCounts);
    mergeTools(tools, params.rollup.untimestamped.tools);
    mergeModels(models, params.rollup.untimestamped.models);
  }

  const dailyLatency = Array.from(dailyLatencies.entries())
    .map(([date, aggregate]) => {
      const stats = computeLatencyStats(aggregate);
      return stats ? Object.assign({ date }, stats) : null;
    })
    .filter((entry): entry is SessionDailyLatency => entry !== null)
    .toSorted((a, b) => a.date.localeCompare(b.date));
  const utcQuarterHourMessageCounts = Array.from(quarterMessages.values()).toSorted(
    (a, b) => a.date.localeCompare(b.date) || a.quarterIndex - b.quarterIndex,
  );
  const utcQuarterHourTokenUsage = Array.from(quarterTokens.values()).toSorted(
    (a, b) => a.date.localeCompare(b.date) || a.quarterIndex - b.quarterIndex,
  );

  return {
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    firstActivity,
    lastActivity,
    durationMs:
      firstActivity !== undefined && lastActivity !== undefined
        ? Math.max(0, lastActivity - firstActivity)
        : undefined,
    activityDates: Array.from(activityDates).toSorted(),
    dailyBreakdown: Array.from(dailyUsage.entries())
      .map(([date, usage]) => Object.assign({ date }, usage))
      .toSorted((a, b) => a.date.localeCompare(b.date)),
    dailyMessageCounts: Array.from(dailyMessages.values()).toSorted((a, b) =>
      a.date.localeCompare(b.date),
    ),
    utcQuarterHourMessageCounts: utcQuarterHourMessageCounts.length
      ? utcQuarterHourMessageCounts
      : undefined,
    utcQuarterHourTokenUsage: utcQuarterHourTokenUsage.length
      ? utcQuarterHourTokenUsage
      : undefined,
    dailyLatency: dailyLatency.length ? dailyLatency : undefined,
    dailyModelUsage: dailyModels.size
      ? Array.from(dailyModels.values()).toSorted(
          (a, b) => a.date.localeCompare(b.date) || b.cost - a.cost,
        )
      : undefined,
    messageCounts,
    toolUsage: buildToolUsage(tools),
    modelUsage: sortedModelUsage(models),
    latency: computeLatencyStats(allLatencies),
    ...totals,
  };
}

export function addRollupToCostUsageSummary(params: {
  rollup: SessionUsageRollupData;
  startMs: number;
  endMs: number;
  formatDay: UsageDayKeyFormatter;
  daily: Map<string, CostUsageTotals>;
  totals: CostUsageTotals;
}): void {
  for (const bucket of usageBucketsInRange(params.rollup, params.startMs, params.endMs)) {
    const dayKey = params.formatDay(new Date(bucket.timestampMs));
    const daily = params.daily.get(dayKey) ?? createEmptyCostUsageTotals();
    addCostUsageTotals(daily, bucket.totals);
    params.daily.set(dayKey, daily);
    addCostUsageTotals(params.totals, bucket.totals);
  }
}

export function cloneSessionUsageRollupData(
  rollup: SessionUsageRollupData,
): SessionUsageRollupData {
  return {
    buckets: Object.fromEntries(
      Object.entries(rollup.buckets).map(([bucketId, bucket]) => [
        bucketId,
        {
          ...bucket,
          totals: cloneCostUsageTotals(bucket.totals),
          messageCounts: { ...bucket.messageCounts },
          tools: bucket.tools.map((tool) => ({ ...tool })),
          models: bucket.models.map((model) => ({
            ...model,
            totals: cloneCostUsageTotals(model.totals),
          })),
          latency: {
            count: bucket.latency.count,
            max: bucket.latency.max,
            sum: bucket.latency.sum,
            ...(bucket.latency.min !== undefined ? { min: bucket.latency.min } : {}),
            centroids: bucket.latency.centroids.map((centroid) => ({
              count: centroid.count,
              value: centroid.value,
            })),
          },
        },
      ]),
    ),
    ...(rollup.lastUserTimestamp !== undefined
      ? { lastUserTimestamp: rollup.lastUserTimestamp }
      : {}),
    untimestamped: {
      totals: cloneCostUsageTotals(rollup.untimestamped.totals),
      messageCounts: { ...rollup.untimestamped.messageCounts },
      tools: rollup.untimestamped.tools.map((tool) => ({ ...tool })),
      models: rollup.untimestamped.models.map((model) => ({
        ...model,
        totals: cloneCostUsageTotals(model.totals),
      })),
    },
  };
}
