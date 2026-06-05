// Usage aggregate helpers accumulate token, cost, and latency usage totals.
type LatencyTotalsLike = {
  count: number;
  sum: number;
  min: number;
  max: number;
  p95Max: number;
};

type DailyLatencyLike = {
  date: string;
  count: number;
  sum: number;
  min: number;
  max: number;
  p95Max: number;
};

type DailyLike = {
  date: string;
};

type LatencyLike = {
  count: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
};

type DailyLatencyInput = LatencyLike & { date: string };

/** Merges latency summaries by keeping weighted averages as sum/count accumulator state. */
export function mergeUsageLatency(
  totals: LatencyTotalsLike,
  latency: LatencyLike | undefined,
): void {
  if (!latency || latency.count <= 0) {
    return;
  }
  totals.count += latency.count;
  totals.sum += latency.avgMs * latency.count;
  totals.min = Math.min(totals.min, latency.minMs);
  totals.max = Math.max(totals.max, latency.maxMs);
  totals.p95Max = Math.max(totals.p95Max, latency.p95Ms);
}

/** Groups daily latency summaries by date while preserving weighted averages for output. */
export function mergeUsageDailyLatency(
  dailyLatencyMap: Map<string, DailyLatencyLike>,
  dailyLatency?: DailyLatencyInput[] | null,
): void {
  for (const day of dailyLatency ?? []) {
    const existing = dailyLatencyMap.get(day.date) ?? {
      date: day.date,
      count: 0,
      sum: 0,
      min: Number.POSITIVE_INFINITY,
      max: 0,
      p95Max: 0,
    };
    existing.count += day.count;
    existing.sum += day.avgMs * day.count;
    existing.min = Math.min(existing.min, day.minMs);
    existing.max = Math.max(existing.max, day.maxMs);
    existing.p95Max = Math.max(existing.p95Max, day.p95Ms);
    dailyLatencyMap.set(day.date, existing);
  }
}

/** Builds deterministic usage aggregate arrays for API responses and UI rendering. */
export function buildUsageAggregateTail<
  TTotals extends { totalCost: number },
  TDaily extends DailyLike,
  TModelDaily extends { date: string; cost: number },
>(params: {
  byChannelMap: Map<string, TTotals>;
  latencyTotals: LatencyTotalsLike;
  dailyLatencyMap: Map<string, DailyLatencyLike>;
  modelDailyMap: Map<string, TModelDaily>;
  dailyMap: Map<string, TDaily>;
}) {
  return {
    byChannel: Array.from(params.byChannelMap.entries())
      .map(([channel, totals]) => ({ channel, totals }))
      .toSorted((a, b) => b.totals.totalCost - a.totals.totalCost),
    latency:
      params.latencyTotals.count > 0
        ? {
            count: params.latencyTotals.count,
            avgMs: params.latencyTotals.sum / params.latencyTotals.count,
            // Empty aggregates keep Infinity internally so later real samples win min comparisons.
            minMs:
              params.latencyTotals.min === Number.POSITIVE_INFINITY ? 0 : params.latencyTotals.min,
            maxMs: params.latencyTotals.max,
            p95Ms: params.latencyTotals.p95Max,
          }
        : undefined,
    dailyLatency: Array.from(params.dailyLatencyMap.values())
      .map((entry) => ({
        date: entry.date,
        count: entry.count,
        avgMs: entry.count ? entry.sum / entry.count : 0,
        minMs: entry.min === Number.POSITIVE_INFINITY ? 0 : entry.min,
        maxMs: entry.max,
        p95Ms: entry.p95Max,
      }))
      .toSorted((a, b) => a.date.localeCompare(b.date)),
    modelDaily: Array.from(params.modelDailyMap.values()).toSorted(
      (a, b) => a.date.localeCompare(b.date) || b.cost - a.cost,
    ),
    daily: Array.from(params.dailyMap.values()).toSorted((a, b) => a.date.localeCompare(b.date)),
  };
}
