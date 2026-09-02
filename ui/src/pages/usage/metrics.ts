import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
// Control UI view renders usage metrics screen content.
import { html } from "lit";
import {
  addCostUsageTotals,
  createEmptyCostUsageTotals,
} from "../../../../src/infra/session-cost-usage-totals.js";
import { createUsageAggregateAccumulator } from "../../../../src/shared/usage-aggregates.js";
import { renderSettingsSection } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatCompactTokenCount } from "../../lib/format.ts";
import type { UsageSessionEntry, UsageTotals, UsageAggregates } from "./types.ts";

const CHARS_PER_TOKEN = 4;
const DAY_MS = 86_400_000;

type UsageCostWindowSummary = {
  days: number;
  startDate: string;
  endDate: string;
  totals: UsageTotals;
};

function charsToTokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

function formatUsageTokens(n: number): string {
  return formatCompactTokenCount(n, { thousandsSuffix: "K", trimTrailingZero: false });
}

// Usage charts choose fixed precision from the surrounding scale; the shared
// adaptive cost formatter would change labels as values cross its thresholds.
function formatUsageCost(n: number, decimals = 2): string {
  return `$${n.toFixed(decimals)}`;
}

function formatHourLabel(hour: number): string {
  // The bucket hour is already zoned; a fixed UTC date avoids local DST normalization.
  const date = new Date(Date.UTC(1970, 0, 1, hour));
  return date.toLocaleTimeString(undefined, { hour: "numeric", timeZone: "UTC" });
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

  if (startMs === endMs) {
    const date = new Date(startMs);
    visitor({
      usage,
      hour: getZonedHour(date, timeZone),
      weekday: getZonedWeekday(date, timeZone),
      share: 1,
    });
    return true;
  }

  const totalMinutes = (endMs - startMs) / 60000;
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
    const messageCounts = usage.messageCounts;

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
        hourErrors[mapped.hour] = (hourErrors[mapped.hour] ?? 0) + quarterHour.errors;
        hourMsgs[mapped.hour] = (hourMsgs[mapped.hour] ?? 0) + quarterHour.total;
      }
      continue;
    }

    // Fallback: time-based proportional allocation (legacy algorithm)
    forEachSessionHourSlice(session, timeZone, ({ hour, share }) => {
      hourErrors[hour] = (hourErrors[hour] ?? 0) + (messageCounts.errors ?? 0) * share;
      hourMsgs[hour] = (hourMsgs[hour] ?? 0) + messageCounts.total * share;
    });
  }

  return hourMsgs
    .map((msgs, hour) => {
      const errors = hourErrors[hour] ?? 0;
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
        hourTotals[hour] = (hourTotals[hour] ?? 0) + tokens;
        weekdayTotals[weekday] = (weekdayTotals[weekday] ?? 0) + tokens;
      })
    ) {
      hasData = true;
      continue;
    }

    if (
      !forEachSessionHourSlice(session, timeZone, ({ usage: usageLocal, hour, weekday, share }) => {
        hourTotals[hour] = (hourTotals[hour] ?? 0) + usageLocal.totalTokens * share;
        weekdayTotals[weekday] = (weekdayTotals[weekday] ?? 0) + usageLocal.totalTokens * share;
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
    tokens: weekdayTotals[index] ?? 0,
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
    return renderSettingsSection(
      {
        title: t("usage.mosaic.title"),
        description: t("usage.mosaic.subtitleEmpty"),
        actions: html`
          <div class="usage-mosaic-total">
            ${formatUsageTokens(0)} ${normalizeLowercaseStringOrEmpty(t("usage.metrics.tokens"))}
          </div>
        `,
      },
      html`
        <div class="usage-panel usage-mosaic">
          <div class="usage-empty-block usage-empty-block--compact">
            ${t("usage.mosaic.noTimelineData")}
          </div>
        </div>
      `,
    );
  }

  const maxHour = Math.max(...stats.hourTotals, 1);
  const maxWeekday = Math.max(...stats.weekdayTotals.map((d) => d.tokens), 1);

  return renderSettingsSection(
    {
      title: t("usage.mosaic.title"),
      description: t("usage.mosaic.subtitle", {
        zone:
          timeZone === "utc" ? t("usage.filters.timeZoneUtc") : t("usage.filters.timeZoneLocal"),
      }),
      actions: html`
        <div class="usage-mosaic-total">
          ${formatUsageTokens(stats.totalTokens)}
          ${normalizeLowercaseStringOrEmpty(t("usage.metrics.tokens"))}
        </div>
      `,
    },
    html`
      <div class="usage-panel usage-mosaic">
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
                    <div class="usage-daypart-value">${formatUsageTokens(part.tokens)}</div>
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
                const title = `${hour}:00 · ${formatUsageTokens(value)} ${normalizeLowercaseStringOrEmpty(
                  t("usage.metrics.tokens"),
                )}`;
                const border =
                  intensity > 0.7
                    ? "color-mix(in srgb, var(--accent) 60%, transparent)"
                    : "color-mix(in srgb, var(--accent) 24%, transparent)";
                const selected = selectedHours.includes(hour);
                return html`
                  <button
                    type="button"
                    class="usage-hour-cell ${selected ? "selected" : ""}"
                    style="background: ${bg}; border-color: ${border};"
                    title="${title}"
                    aria-label=${title}
                    aria-pressed=${selected ? "true" : "false"}
                    @click=${(e: MouseEvent) => onSelectHour(hour, e.shiftKey)}
                  ></button>
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
    `,
  );
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
  const year = Number(y);
  const monthIndex = Number(m) - 1;
  const day = Number(d);
  const date = new Date(year, monthIndex, day);
  if (
    Number.isNaN(date.valueOf()) ||
    date.getFullYear() !== year ||
    date.getMonth() !== monthIndex ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function parseIsoDayIndex(dateStr: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return timestamp / DAY_MS;
}

function formatIsoDayIndex(dayIndex: number): string {
  return new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
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

function buildUsageCostWindowSummary(
  daily: Array<UsageTotals & { date: string }>,
  startDate: string,
  endDate: string,
): UsageCostWindowSummary | null {
  const startDay = parseIsoDayIndex(startDate);
  const endDay = parseIsoDayIndex(endDate);
  if (startDay === null || endDay === null || startDay > endDay) {
    return null;
  }

  const totals = createEmptyCostUsageTotals();
  for (const entry of daily) {
    const day = parseIsoDayIndex(entry.date);
    if (day !== null && day >= startDay && day <= endDay) {
      addCostUsageTotals(totals, entry);
    }
  }

  return {
    days: endDay - startDay + 1,
    startDate,
    endDate,
    totals,
  };
}

function buildUsageCostWindows(
  daily: Array<UsageTotals & { date: string }>,
  rangeStartDate: string,
  rangeEndDate: string,
  periods: number[] = [1, 7, 30, 90],
): UsageCostWindowSummary[] {
  const rangeStartDay = parseIsoDayIndex(rangeStartDate);
  const rangeEndDay = parseIsoDayIndex(rangeEndDate);
  if (rangeStartDay === null || rangeEndDay === null || rangeStartDay > rangeEndDay) {
    return [];
  }

  const rangeDays = rangeEndDay - rangeStartDay + 1;
  return Array.from(new Set(periods.map((days) => Math.max(1, Math.trunc(days)))))
    .filter((days) => days < rangeDays)
    .toSorted((left, right) => left - right)
    .map((days) => {
      const startDate = formatIsoDayIndex(rangeEndDay - days + 1);
      return buildUsageCostWindowSummary(daily, startDate, rangeEndDate);
    })
    .filter((summary): summary is UsageCostWindowSummary => summary !== null);
}

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

  const accumulator = createUsageAggregateAccumulator();
  for (const session of sessions) {
    accumulator.add(session);
  }
  return accumulator.finish();
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
  buildUsageCostWindowSummary,
  buildUsageCostWindows,
  buildPeakErrorHours,
  buildUsageInsightStats,
  charsToTokens,
  formatUsageCost,
  formatDayLabel,
  formatFullDate,
  formatIsoDate,
  formatUsageTokens,
  renderUsageMosaic,
  sessionTouchesSelectedHours,
};
