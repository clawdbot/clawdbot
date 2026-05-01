import { html } from "lit";
import {
  buildUsageAggregateTail,
  mergeUsageDailyLatency,
  mergeUsageLatency,
} from "../../../../src/shared/usage-aggregates.js";
import { t } from "../../i18n/index.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import { UsageSessionEntry, UsageTotals, UsageAggregates } from "./usageTypes.ts";

const CHARS_PER_TOKEN = 4;

function charsToTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${(n / 1_000).toFixed(1)}K`;
  }
  return String(n);
}

function formatHourLabel(hour: number): string {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  return date.toLocaleTimeString(undefined, { hour: "numeric" });
}

function forEachSessionHourSlice(
  session: UsageSessionEntry,
  timeZone: "local" | "utc",
  visitor: (params: {
    usage: NonNullable<UsageSessionEntry["usage"]>;
    hour: number;
    weekday: number;
    share: number;
  }) => void,
) {
  const usage = session.usage;
  if (!usage) {
    return false;
  }

  const start = usage.firstActivity ?? session.updatedAt;
  const end = usage.lastActivity ?? session.updatedAt;
  if (!start || !end) {
    return false;
  }

  const startMs = Math.min(start, end);
  const endMs = Math.max(start, end);
  const durationMs = Math.max(endMs - startMs, 1);
  const totalMinutes = durationMs / 60000;

  let cursor = startMs;
  while (cursor < endMs) {
    const date = new Date(cursor);
    const nextHour = setToHourEnd(date, timeZone);
    const nextMs = Math.min(nextHour.getTime(), endMs);
    const minutes = Math.max((nextMs - cursor) / 60000, 0);
    visitor({
      usage,
      hour: getZonedHour(date, timeZone),
      weekday: getZonedWeekday(date, timeZone),
      share: minutes / totalMinutes,
    });
    cursor = nextMs + 1;
  }

  return true;
}

function buildPeakErrorHours(sessions: UsageSessionEntry[], timeZone: "local" | "utc") {
  const hourErrors = Array.from({ length: 24 }, () => 0);
  const hourMsgs = Array.from({ length: 24 }, () => 0);

  for (const session of sessions) {
    const usage = session.usage;
    if (!usage?.messageCounts || usage.messageCounts.total === 0) {
      continue;
    }

    // Prefer precise quarter-hour message counts when available.
    // Data is stored as UTC quarter-hour buckets (quarterIndex 0-95) with UTC date keys.
    // For local view, construct a Date from the UTC components and use getHours()
    // so the browser's DST-aware timezone logic handles offset automatically.
    if (usage.utcQuarterHourMessageCounts && usage.utcQuarterHourMessageCounts.length > 0) {
      for (const quarterHour of usage.utcQuarterHourMessageCounts) {
        const mapped = getHourAndWeekdayForUtcQuarterBucket(
          quarterHour.date,
          quarterHour.quarterIndex,
          timeZone,
        );
        if (!mapped) {
          continue;
        }
        hourErrors[mapped.hour] += quarterHour.errors;
        hourMsgs[mapped.hour] += quarterHour.total;
      }
      continue;
    }

    // Fallback: time-based proportional allocation (legacy algorithm)
    forEachSessionHourSlice(session, timeZone, ({ hour, share }) => {
      hourErrors[hour] += usage.messageCounts!.errors * share;
      hourMsgs[hour] += usage.messageCounts!.total * share;
    });
  }

  return hourMsgs
    .map((msgs, hour) => {
      const errors = hourErrors[hour];
      const rate = msgs > 0 ? errors / msgs : 0;
      return {
        hour,
        rate,
        errors,
        msgs,
      };
    })
    .filter((entry) => entry.msgs > 0 && entry.errors > 0)
    .toSorted((a, b) => b.rate - a.rate)
    .slice(0, 5)
    .map((entry) => ({
      label: formatHourLabel(entry.hour),
      value: `${(entry.rate * 100).toFixed(2)}%`,
      sub: `${Math.round(entry.errors)} ${normalizeLowercaseStringOrEmpty(t("usage.overview.errors"))} · ${Math.round(entry.msgs)} ${t("usage.overview.messagesAbbrev")}`,
    }));
}

type UsageMosaicStats = {
  hasData: boolean;
  totalTokens: number;
  hourTotals: number[];
  weekdayTotals: Array<{ label: string; tokens: number }>;
};

function getZonedHour(date: Date, zone: "local" | "utc"): number {
  return zone === "utc" ? date.getUTCHours() : date.getHours();
}

function getZonedWeekday(date: Date, zone: "local" | "utc"): number {
  return zone === "utc" ? date.getUTCDay() : date.getDay();
}

function getUtcQuarterHourBucketDate(dateStr: string, quarterIndex: number): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match || !Number.isInteger(quarterIndex) || quarterIndex < 0 || quarterIndex > 95) {
    return null;
  }
  const [, yStr, mStr, dStr] = match;
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  const date = new Date(Date.UTC(y, m - 1, d, 0, quarterIndex * 15));
  if (
    Number.isNaN(date.valueOf()) ||
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

function getHourAndWeekdayForUtcQuarterBucket(
  dateStr: string,
  quarterIndex: number,
  timeZone: "local" | "utc",
): { hour: number; weekday: number } | null {
  const date = getUtcQuarterHourBucketDate(dateStr, quarterIndex);
  if (!date) {
    return null;
  }
  return {
    hour: getZonedHour(date, timeZone),
    weekday: getZonedWeekday(date, timeZone),
  };
}

function setToHourEnd(date: Date, zone: "local" | "utc"): Date {
  const next = new Date(date);
  if (zone === "utc") {
    next.setUTCMinutes(59, 59, 999);
  } else {
    next.setMinutes(59, 59, 999);
  }
  return next;
}

function forEachSessionTokenUsageBucket(
  session: UsageSessionEntry,
  timeZone: "local" | "utc",
  visitor: (params: { hour: number; weekday: number; tokens: number }) => void,
): boolean {
  const buckets = session.usage?.utcQuarterHourTokenUsage;
  if (!buckets || buckets.length === 0) {
    return false;
  }
  let visited = false;
  for (const bucket of buckets) {
    if (bucket.totalTokens <= 0) {
      continue;
    }
    const mapped = getHourAndWeekdayForUtcQuarterBucket(bucket.date, bucket.quarterIndex, timeZone);
    if (!mapped) {
      continue;
    }
    visited = true;
    visitor({ hour: mapped.hour, weekday: mapped.weekday, tokens: bucket.totalTokens });
  }
  return visited;
}

function sessionSpanTouchesSelectedHours(
  session: UsageSessionEntry,
  hours: number[],
  timeZone: "local" | "utc",
): boolean {
  const usage = session.usage;
  const start = usage?.firstActivity ?? session.updatedAt;
  const end = usage?.lastActivity ?? session.updatedAt;
  if (!start || !end) {
    return false;
  }
  const startMs = Math.min(start, end);
  const endMs = Math.max(start, end);
  let cursor = startMs;
  while (cursor <= endMs) {
    const date = new Date(cursor);
    const hour = getZonedHour(date, timeZone);
    if (hours.includes(hour)) {
      return true;
    }
    const nextHour = setToHourEnd(date, timeZone);
    const nextMs = Math.min(nextHour.getTime(), endMs);
    cursor = nextMs + 1;
  }
  return false;
}

function sessionTouchesSelectedHours(
  session: UsageSessionEntry,
  hours: number[],
  timeZone: "local" | "utc",
): boolean {
  if (hours.length === 0) {
    return true;
  }
  let touches = false;
  const hasPreciseTokenBuckets = forEachSessionTokenUsageBucket(session, timeZone, ({ hour }) => {
    if (hours.includes(hour)) {
      touches = true;
    }
  });
  if (hasPreciseTokenBuckets) {
    return touches;
  }
  return sessionSpanTouchesSelectedHours(session, hours, timeZone);
}

function buildUsageMosaicStats(
  sessions: UsageSessionEntry[],
  timeZone: "local" | "utc",
): UsageMosaicStats {
  const hourTotals = Array.from({ length: 24 }, () => 0);
  const weekdayTotals = Array.from({ length: 7 }, () => 0);
  let totalTokens = 0;
  let hasData = false;

  for (const session of sessions) {
    const usage = session.usage;
    if (!usage || !usage.totalTokens || usage.totalTokens <= 0) {
      continue;
    }
    totalTokens += usage.totalTokens;

    if (
      forEachSessionTokenUsageBucket(session, timeZone, ({ hour, weekday, tokens }) => {
        hourTotals[hour] += tokens;
        weekdayTotals[weekday] += tokens;
      })
    ) {
      hasData = true;
      continue;
    }

    if (
      !forEachSessionHourSlice(session, timeZone, ({ usage, hour, weekday, share }) => {
        hourTotals[hour] += usage.totalTokens * share;
        weekdayTotals[weekday] += usage.totalTokens * share;
      })
    ) {
      continue;
    }
    hasData = true;
  }

  const weekdayLabels = [
    t("usage.mosaic.sun"),
    t("usage.mosaic.mon"),
    t("usage.mosaic.tue"),
    t("usage.mosaic.wed"),
    t("usage.mosaic.thu"),
    t("usage.mosaic.fri"),
    t("usage.mosaic.sat"),
  ].map((label, index) => ({
    label,
    tokens: weekdayTotals[index],
  }));

  return {
    hasData,
    totalTokens,
    hourTotals,
    weekdayTotals: weekdayLabels,
  };
}

function renderUsageMosaic(
  sessions: UsageSessionEntry[],
  timeZone: "local" | "utc",
  selectedHours: number[],
  onSelectHour: (hour: number, shiftKey: boolean) => void,
) {
  const stats = buildUsageMosaicStats(sessions, timeZone);
  if (!stats.hasData) {
    return html`
      <div class="card usage-mosaic">
        <div class="usage-mosaic-header">
          <div>
            <div class="usage-mosaic-title">${t("usage.mosaic.title")}</div>
            <div class="usage-mosaic-sub">${t("usage.mosaic.subtitleEmpty")}</div>
          </div>
          <div class="usage-mosaic-total">
            ${formatTokens(0)} ${normalizeLowercaseStringOrEmpty(t("usage.metrics.tokens"))}
          </div>
        </div>
        <div class="usage-empty-block usage-empty-block--compact">
          ${t("usage.mosaic.noTimelineData")}
        </div>
      </div>
    `;
  }

  const maxHour = Math.max(...stats.hourTotals, 1);
  const maxWeekday = Math.max(...stats.weekdayTotals.map((d) => d.tokens), 1);

  return html`
    <div class="card usage-mosaic">
      <div class="usage-mosaic-header">
        <div>
          <div class="usage-mosaic-title">${t("usage.mosaic.title")}</div>
          <div class="usage-mosaic-sub">
            ${t("usage.mosaic.subtitle", {
              zone:
                timeZone === "utc"
                  ? t("usage.filters.timeZoneUtc")
                  : t("usage.filters.timeZoneLocal"),
            })}
          </div>
        </div>
        <div class="usage-mosaic-total">
          ${formatTokens(stats.totalTokens)}
          ${normalizeLowercaseStringOrEmpty(t("usage.metrics.tokens"))}
        </div>
      </div>
      <div class="usage-mosaic-grid">
        <div class="usage-mosaic-section">
          <div class="usage-mosaic-section-title">${t("usage.mosaic.dayOfWeek")}</div>
          <div class="usage-daypart-grid">
            ${stats.weekdayTotals.map((part) => {
              const intensity = Math.min(part.tokens / maxWeekday, 1);
              const bg =
                part.tokens > 0
                  ? `color-mix(in srgb, var(--accent) ${(12 + intensity * 60).toFixed(1)}%, transparent)`
                  : "transparent";
              return html`
                <div class="usage-daypart-cell" style="background: ${bg};">
                  <div class="usage-daypart-label">${part.label}</div>
                  <div class="usage-daypart-value">${formatTokens(part.tokens)}</div>
                </div>
              `;
            })}
          </div>
        </div>
        <div class="usage-mosaic-section">
          <div class="usage-mosaic-section-title">
            <span>${t("usage.filters.hours")}</span>
            <span class="usage-mosaic-sub">0 → 23</span>
          </div>
          <div class="usage-hour-grid">
            ${stats.hourTotals.map((value, hour) => {
              const intensity = Math.min(value / maxHour, 1);
              const bg =
                value > 0
                  ? `color-mix(in srgb, var(--accent) ${(8 + intensity * 70).toFixed(1)}%, transparent)`
                  : "transparent";
              const title = `${hour}:00 · ${formatTokens(value)} ${normalizeLowercaseStringOrEmpty(
                t("usage.metrics.tokens"),
              )}`;
              const border =
                intensity > 0.7
                  ? "color-mix(in srgb, var(--accent) 60%, transparent)"
                  : "color-mix(in srgb, var(--accent) 24%, transparent)";
              const selected = selectedHours.includes(hour);
              return html`
                <div
                  class="usage-hour-cell ${selected ? "selected" : ""}"
                  style="background: ${bg}; border-color: ${border};"
                  title="${title}"
                  @click=${(e: MouseEvent) => onSelectHour(hour, e.shiftKey)}
                ></div>
              `;
            })}
          </div>
          <div class="usage-hour-labels">
            <span>${t("usage.mosaic.midnight")}</span>
            <span>${t("usage.mosaic.fourAm")}</span>
            <span>${t("usage.mosaic.eightAm")}</span>
            <span>${t("usage.mosaic.noon")}</span>
            <span>${t("usage.mosaic.fourPm")}</span>
            <span>${t("usage.mosaic.eightPm")}</span>
          </div>
          <div class="usage-hour-legend">
            <span></span>
            ${t("usage.mosaic.legend")}
          </div>
        </div>
      </div>
    </div>
  `;
}

function formatCost(n: number, decimals = 2): string {
  return `$${n.toFixed(decimals)}`;
}

function formatIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseYmdDate(dateStr: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    return null;
  }
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return Number.isNaN(date.valueOf()) ? null : date;
}

function formatDayLabel(dateStr: string): string {
  const date = parseYmdDate(dateStr);
  if (!date) {
    return dateStr;
  }
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatFullDate(dateStr: string): string {
  const date = parseYmdDate(dateStr);
  if (!date) {
    return dateStr;
  }
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

const emptyUsageTotals = (): UsageTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  totalCost: 0,
  inputCost: 0,
  outputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
});

const mergeUsageTotals = (target: UsageTotals, source: Partial<UsageTotals>) => {
  target.input += source.input ?? 0;
  target.output += source.output ?? 0;
  target.cacheRead += source.cacheRead ?? 0;
  target.cacheWrite += source.cacheWrite ?? 0;
  target.totalTokens += source.totalTokens ?? 0;
  target.totalCost += source.totalCost ?? 0;
  target.inputCost += source.inputCost ?? 0;
  target.outputCost += source.outputCost ?? 0;
  target.cacheReadCost += source.cacheReadCost ?? 0;
  target.cacheWriteCost += source.cacheWriteCost ?? 0;
  target.missingCostEntries += source.missingCostEntries ?? 0;
};

const buildAggregatesFromSessions = (
  sessions: UsageSessionEntry[],
  fallback?: UsageAggregates | null,
): UsageAggregates => {
  if (sessions.length === 0) {
    return (
      fallback ?? {
        messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
        tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
        byModel: [],
        byProvider: [],
        byAgent: [],
        byChannel: [],
        daily: [],
      }
    );
  }

  const messages = { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 };
  const toolMap = new Map<string, number>();
  const modelMap = new Map<
    string,
    { provider?: string; model?: string; count: number; totals: UsageTotals }
  >();
  const providerMap = new Map<
    string,
    { provider?: string; model?: string; count: number; totals: UsageTotals }
  >();
  const agentMap = new Map<string, UsageTotals>();
  const channelMap = new Map<string, UsageTotals>();
  const dailyMap = new Map<
    string,
    {
      date: string;
      tokens: number;
      cost: number;
      messages: number;
      toolCalls: number;
      errors: number;
    }
  >();
  const dailyLatencyMap = new Map<
    string,
    { date: string; count: number; sum: number; min: number; max: number; p95Max: number }
  >();
  const modelDailyMap = new Map<
    string,
    { date: string; provider?: string; model?: string; tokens: number; cost: number; count: number }
  >();
  const latencyTotals = { count: 0, sum: 0, min: Number.POSITIVE_INFINITY, max: 0, p95Max: 0 };

  for (const session of sessions) {
    const usage = session.usage;
    if (!usage) {
      continue;
    }
    if (usage.messageCounts) {
      messages.total += usage.messageCounts.total;
      messages.user += usage.messageCounts.user;
      messages.assistant += usage.messageCounts.assistant;
      messages.toolCalls += usage.messageCounts.toolCalls;
      messages.toolResults += usage.messageCounts.toolResults;
      messages.errors += usage.messageCounts.errors;
    }

    if (usage.toolUsage) {
      for (const tool of usage.toolUsage.tools) {
        toolMap.set(tool.name, (toolMap.get(tool.name) ?? 0) + tool.count);
      }
    }

    if (usage.modelUsage) {
      for (const entry of usage.modelUsage) {
        const modelKey = `${entry.provider ?? "unknown"}::${entry.model ?? "unknown"}`;
        const modelExisting = modelMap.get(modelKey) ?? {
          provider: entry.provider,
          model: entry.model,
          count: 0,
          totals: emptyUsageTotals(),
        };
        modelExisting.count += entry.count;
        mergeUsageTotals(modelExisting.totals, entry.totals);
        modelMap.set(modelKey, modelExisting);

        const providerKey = entry.provider ?? "unknown";
        const providerExisting = providerMap.get(providerKey) ?? {
          provider: entry.provider,
          model: undefined,
          count: 0,
          totals: emptyUsageTotals(),
        };
        providerExisting.count += entry.count;
        mergeUsageTotals(providerExisting.totals, entry.totals);
        providerMap.set(providerKey, providerExisting);
      }
    }

    mergeUsageLatency(latencyTotals, usage.latency);

    if (session.agentId) {
      const totals = agentMap.get(session.agentId) ?? emptyUsageTotals();
      mergeUsageTotals(totals, usage);
      agentMap.set(session.agentId, totals);
    }
    if (session.channel) {
      const totals = channelMap.get(session.channel) ?? emptyUsageTotals();
      mergeUsageTotals(totals, usage);
      channelMap.set(session.channel, totals);
    }

    for (const day of usage.dailyBreakdown ?? []) {
      const daily = dailyMap.get(day.date) ?? {
        date: day.date,
        tokens: 0,
        cost: 0,
        messages: 0,
        toolCalls: 0,
        errors: 0,
      };
      daily.tokens += day.tokens;
      daily.cost += day.cost;
      dailyMap.set(day.date, daily);
    }
    for (const day of usage.dailyMessageCounts ?? []) {
      const daily = dailyMap.get(day.date) ?? {
        date: day.date,
        tokens: 0,
        cost: 0,
        messages: 0,
        toolCalls: 0,
        errors: 0,
      };
      daily.messages += day.total;
      daily.toolCalls += day.toolCalls;
      daily.errors += day.errors;
      dailyMap.set(day.date, daily);
    }
    mergeUsageDailyLatency(dailyLatencyMap, usage.dailyLatency);
    for (const day of usage.dailyModelUsage ?? []) {
      const key = `${day.date}::${day.provider ?? "unknown"}::${day.model ?? "unknown"}`;
      const existing = modelDailyMap.get(key) ?? {
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
      modelDailyMap.set(key, existing);
    }
  }

  const tail = buildUsageAggregateTail({
    byChannelMap: channelMap,
    latencyTotals,
    dailyLatencyMap,
    modelDailyMap,
    dailyMap,
  });

  return {
    messages,
    tools: {
      totalCalls: Array.from(toolMap.values()).reduce((sum, count) => sum + count, 0),
      uniqueTools: toolMap.size,
      tools: Array.from(toolMap.entries())
        .map(([name, count]) => ({ name, count }))
        .toSorted((a, b) => b.count - a.count),
    },
    byModel: Array.from(modelMap.values()).toSorted(
      (a, b) => b.totals.totalCost - a.totals.totalCost,
    ),
    byProvider: Array.from(providerMap.values()).toSorted(
      (a, b) => b.totals.totalCost - a.totals.totalCost,
    ),
    byAgent: Array.from(agentMap.entries())
      .map(([agentId, totals]) => ({ agentId, totals }))
      .toSorted((a, b) => b.totals.totalCost - a.totals.totalCost),
    ...tail,
  };
};

type UsageInsightStats = {
  durationSumMs: number;
  durationCount: number;
  avgDurationMs: number;
  throughputTokensPerMin?: number;
  throughputCostPerMin?: number;
  errorRate: number;
  peakErrorDay?: { date: string; errors: number; messages: number; rate: number };
};

const buildUsageInsightStats = (
  sessions: UsageSessionEntry[],
  totals: UsageTotals | null,
  aggregates: UsageAggregates,
): UsageInsightStats => {
  let durationSumMs = 0;
  let durationCount = 0;
  for (const session of sessions) {
    const duration = session.usage?.durationMs ?? 0;
    if (duration > 0) {
      durationSumMs += duration;
      durationCount += 1;
    }
  }

  const avgDurationMs = durationCount ? durationSumMs / durationCount : 0;
  const throughputTokensPerMin =
    totals && durationSumMs > 0 ? totals.totalTokens / (durationSumMs / 60000) : undefined;
  const throughputCostPerMin =
    totals && durationSumMs > 0 ? totals.totalCost / (durationSumMs / 60000) : undefined;

  const errorRate = aggregates.messages.total
    ? aggregates.messages.errors / aggregates.messages.total
    : 0;
  let peakErrorDay: UsageInsightStats["peakErrorDay"];
  for (const day of aggregates.daily) {
    if (day.messages <= 0 || day.errors <= 0) {
      continue;
    }
    const candidate = {
      date: day.date,
      errors: day.errors,
      messages: day.messages,
      rate: day.errors / day.messages,
    };
    if (
      !peakErrorDay ||
      candidate.rate > peakErrorDay.rate ||
      (candidate.rate === peakErrorDay.rate && candidate.errors > peakErrorDay.errors)
    ) {
      peakErrorDay = candidate;
    }
  }

  return {
    durationSumMs,
    durationCount,
    avgDurationMs,
    throughputTokensPerMin,
    throughputCostPerMin,
    errorRate,
    peakErrorDay,
  };
};

export type { UsageInsightStats };
export {
  buildAggregatesFromSessions,
  buildPeakErrorHours,
  buildUsageInsightStats,
  charsToTokens,
  formatCost,
  formatDayLabel,
  formatFullDate,
  buildUsageMosaicStats,
  formatHourLabel,
  formatIsoDate,
  formatTokens,
  getHourAndWeekdayForUtcQuarterBucket,
  getZonedHour,
  renderUsageMosaic,
  sessionTouchesSelectedHours,
  setToHourEnd,
};
