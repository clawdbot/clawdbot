type UsageHeatmapDay = {
  date: string;
  tokens: number;
  /** 0 = no activity, 1-4 = nonzero-quartile intensity buckets. */
  level: 0 | 1 | 2 | 3 | 4;
};

type UsageHeatmapWeek = {
  /** Sunday-first column; null pads days outside the covered range. */
  days: Array<UsageHeatmapDay | null>;
};

export type UsageHeatmap = {
  weeks: UsageHeatmapWeek[];
  /** Month label slots aligned to week columns; empty string = no label. */
  monthLabels: string[];
};

type DailyTokensEntry = { date: string; totalTokens: number };

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HEATMAP_DAYS = 52 * 7;

/** Interpret a YYYY-MM-DD label at UTC noon so day math never crosses DST edges. */
function dateToUtcNoon(date: string): number {
  return new Date(`${date}T12:00:00Z`).getTime();
}

function utcNoonToDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function levelThresholds(values: number[]): [number, number, number] {
  const sorted = values.toSorted((a, b) => a - b);
  const pick = (ratio: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0;
  return [pick(0.25), pick(0.5), pick(0.75)];
}

// Strict-less-than buckets put days at a quartile edge in the darker level;
// uniformly active ranges then read fully saturated instead of faint.
function levelFor(tokens: number, thresholds: [number, number, number]): UsageHeatmapDay["level"] {
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
 * GitHub-style grid for the selected range, capped at its trailing 52 weeks.
 * Columns are Sunday-first; intensity buckets come from nonzero-day quartiles
 * so sparse and heavy ranges both spread across the palette.
 */
export function buildUsageHeatmap(
  daily: readonly DailyTokensEntry[],
  rangeStartDate: string,
  rangeEndDate: string,
  locale?: string,
): UsageHeatmap {
  const endMs = dateToUtcNoon(rangeEndDate);
  const startMs = Math.max(dateToUtcNoon(rangeStartDate), endMs - (MAX_HEATMAP_DAYS - 1) * DAY_MS);
  const tokensByDate = new Map(daily.map((entry) => [entry.date, entry.totalTokens]));
  const nonZero = daily
    .filter((entry) => {
      const entryMs = dateToUtcNoon(entry.date);
      return entry.totalTokens > 0 && entryMs >= startMs && entryMs <= endMs;
    })
    .map((entry) => entry.totalTokens);
  const thresholds =
    nonZero.length > 0 ? levelThresholds(nonZero) : ([0, 0, 0] as [number, number, number]);

  const startWeekday = new Date(startMs).getUTCDay();
  const gridStartMs = startMs - startWeekday * DAY_MS;
  const monthFormat = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
  const weeks: UsageHeatmapWeek[] = [];
  const monthLabels: string[] = [];
  let previousMonth = -1;
  for (let weekMs = gridStartMs; weekMs <= endMs; weekMs += 7 * DAY_MS) {
    const days: Array<UsageHeatmapDay | null> = [];
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const dayMs = weekMs + weekday * DAY_MS;
      if (dayMs < startMs || dayMs > endMs) {
        days.push(null);
        continue;
      }
      const date = utcNoonToDate(dayMs);
      const tokens = tokensByDate.get(date) ?? 0;
      days.push({ date, tokens, level: levelFor(tokens, thresholds) });
    }
    weeks.push({ days });
    const firstVisibleDay = days.find((day): day is UsageHeatmapDay => day !== null);
    const firstVisibleMs = dateToUtcNoon(firstVisibleDay?.date ?? rangeEndDate);
    const month = new Date(firstVisibleMs).getUTCMonth();
    monthLabels.push(month === previousMonth ? "" : monthFormat.format(new Date(firstVisibleMs)));
    previousMonth = month;
  }
  return { weeks, monthLabels };
}
