// Pure profile-page aggregation: turns usage.cost daily totals and
// sessions.usage aggregates into the hero stats, streaks, and heatmap model.
import type { SessionsUsageResult } from "../../../../src/shared/usage-types.js";

type DailyTokensEntry = { date: string; totalTokens: number };

export type ProfileHeatmapDay = {
  date: string;
  tokens: number;
  /** 0 = no activity, 1-4 = nonzero-quartile intensity buckets. */
  level: 0 | 1 | 2 | 3 | 4;
};

export type ProfileHeatmapWeek = {
  /** Sunday-first column; null pads days outside the covered range. */
  days: Array<ProfileHeatmapDay | null>;
};

export type ProfileHeatmap = {
  weeks: ProfileHeatmapWeek[];
  /** Month label slots aligned to week columns; empty string = no label. */
  monthLabels: string[];
};

export type ProfileStreaks = {
  current: number;
  longest: number;
};

export type ProfileTopTool = { name: string; count: number };
export type ProfileTopChannel = { channel: string; tokens: number };

export type ProfileInsights = {
  topModel: string | null;
  messages: number;
  toolCalls: number;
  uniqueTools: number;
  agents: number;
  sessions: number;
  sessionsCapped: boolean;
  topTools: ProfileTopTool[];
  topChannels: ProfileTopChannel[];
  longestSessionMs: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const HEATMAP_WEEKS = 52;

/** Interpret a YYYY-MM-DD label at UTC noon so day math never crosses DST edges. */
function dateToUtcNoon(date: string): number {
  return new Date(`${date}T12:00:00Z`).getTime();
}

function utcNoonToDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function localDateString(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Compact token count with billion/trillion tiers ("2.8T", "82.1B", "412k"). */
export function formatTokenScale(tokens: number | null | undefined): string {
  if (tokens == null || !Number.isFinite(tokens) || tokens <= 0) {
    return "0";
  }
  const tiers = [
    { threshold: 1e12, suffix: "T" },
    { threshold: 1e9, suffix: "B" },
    { threshold: 1e6, suffix: "M" },
    { threshold: 1e3, suffix: "k" },
  ];
  for (const tier of tiers) {
    if (tokens < tier.threshold) {
      continue;
    }
    const value = tokens / tier.threshold;
    const text = value < 100 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
    return `${text}${tier.suffix}`;
  }
  return String(Math.round(tokens));
}

/** Hour-scale duration ("59h 4m", "12m", "45s"); profile sessions can span days. */
export function formatLongDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 1000) {
    return "0s";
  }
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

function activeDates(daily: readonly DailyTokensEntry[]): string[] {
  return daily
    .filter((entry) => entry.totalTokens > 0)
    .map((entry) => entry.date)
    .toSorted();
}

/**
 * Streaks over active days. The current streak tolerates an inactive "today"
 * so it does not read 0 before the first request of the day lands.
 */
export function computeStreaks(daily: readonly DailyTokensEntry[], today: string): ProfileStreaks {
  const dates = activeDates(daily);
  if (dates.length === 0) {
    return { current: 0, longest: 0 };
  }
  let longest = 1;
  let run = 1;
  for (let index = 1; index < dates.length; index += 1) {
    const gapDays = Math.round(
      (dateToUtcNoon(dates[index]) - dateToUtcNoon(dates[index - 1])) / DAY_MS,
    );
    run = gapDays === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const last = dates[dates.length - 1];
  const sinceLast = Math.round((dateToUtcNoon(today) - dateToUtcNoon(last)) / DAY_MS);
  return { current: sinceLast <= 1 ? run : 0, longest };
}

function levelThresholds(values: number[]): [number, number, number] {
  const sorted = values.toSorted((a, b) => a - b);
  const pick = (ratio: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
  return [pick(0.25), pick(0.5), pick(0.75)];
}

// Strict-less-than buckets so days at or above a quartile edge take the darker
// level; a uniformly active profile then reads fully saturated, not faint.
function levelFor(
  tokens: number,
  thresholds: [number, number, number],
): ProfileHeatmapDay["level"] {
  if (tokens <= 0) {
    return 0;
  }
  if (tokens < thresholds[0]) {
    return 1;
  }
  if (tokens < thresholds[1]) {
    return 2;
  }
  if (tokens < thresholds[2]) {
    return 3;
  }
  return 4;
}

/**
 * GitHub-style 52-week grid ending today. Columns are Sunday-first weeks;
 * intensity buckets come from nonzero-day quartiles so sparse and heavy
 * profiles both spread across the palette.
 */
export function buildHeatmap(
  daily: readonly DailyTokensEntry[],
  today: string,
  locale?: string,
): ProfileHeatmap {
  const todayMs = dateToUtcNoon(today);
  const startMs = todayMs - (HEATMAP_WEEKS * 7 - 1) * DAY_MS;
  const tokensByDate = new Map(daily.map((entry) => [entry.date, entry.totalTokens]));
  const nonZero = daily
    .filter((entry) => entry.totalTokens > 0 && dateToUtcNoon(entry.date) >= startMs)
    .map((entry) => entry.totalTokens);
  const thresholds =
    nonZero.length > 0 ? levelThresholds(nonZero) : ([0, 0, 0] as [number, number, number]);

  // Align the first column to the Sunday on or before the range start.
  const startWeekday = new Date(startMs).getUTCDay();
  const gridStartMs = startMs - startWeekday * DAY_MS;

  const monthFormat = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
  const weeks: ProfileHeatmapWeek[] = [];
  const monthLabels: string[] = [];
  let previousMonth = -1;
  for (let weekMs = gridStartMs; weekMs <= todayMs; weekMs += 7 * DAY_MS) {
    const days: Array<ProfileHeatmapDay | null> = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const dayMs = weekMs + weekday * DAY_MS;
      if (dayMs < startMs || dayMs > todayMs) {
        days.push(null);
        continue;
      }
      const date = utcNoonToDate(dayMs);
      const tokens = tokensByDate.get(date) ?? 0;
      days.push({ date, tokens, level: levelFor(tokens, thresholds) });
    }
    weeks.push({ days });
    const month = new Date(weekMs).getUTCMonth();
    // Label a column when the week starts a new month; keeps labels sparse.
    monthLabels.push(month === previousMonth ? "" : monthFormat.format(new Date(weekMs)));
    previousMonth = month;
  }
  return { weeks, monthLabels };
}

export function peakDay(daily: readonly DailyTokensEntry[]): DailyTokensEntry | null {
  let peak: DailyTokensEntry | null = null;
  for (const entry of daily) {
    if (entry.totalTokens > 0 && entry.totalTokens > (peak?.totalTokens ?? 0)) {
      peak = entry;
    }
  }
  return peak;
}

export function firstActiveDate(daily: readonly DailyTokensEntry[]): string | null {
  return activeDates(daily)[0] ?? null;
}

const displayName = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export function buildInsights(result: SessionsUsageResult): ProfileInsights {
  const aggregates = result.aggregates;
  const topModelEntry = aggregates.byModel
    .filter((entry) => entry.model)
    .toSorted((a, b) => b.totals.totalTokens - a.totals.totalTokens)[0];
  const topTools = aggregates.tools.tools
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 5)
    .map((tool) => ({ name: tool.name, count: tool.count }));
  const topChannels = aggregates.byChannel
    .toSorted((a, b) => b.totals.totalTokens - a.totals.totalTokens)
    .slice(0, 3)
    .map((entry) => ({ channel: displayName(entry.channel), tokens: entry.totals.totalTokens }));
  // Prefer uncapped aggregates; fall back to the (limit-capped) rows only for
  // gateways that predate sessionCount/longestSessionDurationMs.
  let longestSessionMs = aggregates.longestSessionDurationMs ?? null;
  if (longestSessionMs == null) {
    for (const session of result.sessions) {
      const duration = session.usage?.durationMs;
      if (duration != null && duration > (longestSessionMs ?? 0)) {
        longestSessionMs = duration;
      }
    }
  }
  return {
    topModel: topModelEntry?.model ?? null,
    messages: aggregates.messages.total,
    toolCalls: aggregates.tools.totalCalls,
    uniqueTools: aggregates.tools.uniqueTools,
    agents: aggregates.byAgent.length,
    sessions: aggregates.sessionCount ?? result.sessions.length,
    sessionsCapped: aggregates.sessionCount == null && result.sessions.length >= 1000,
    topTools,
    topChannels,
    longestSessionMs,
  };
}
