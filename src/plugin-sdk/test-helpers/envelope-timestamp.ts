import {
  formatUtcTimestamp,
  formatZonedTimestamp,
} from "../../infra/format-time/format-datetime.js";

export { escapeRegExp } from "../../utils.js";

type EnvelopeTimestampZone = string;

export function formatEnvelopeTimestamp(date: Date, zone: EnvelopeTimestampZone = "utc"): string {
  const trimmedZone = zone.trim();
  const normalized = trimmedZone.toLowerCase();
  const weekday = (() => {
    try {
      if (normalized === "utc" || normalized === "gmt") {
        return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(date);
      }
      if (normalized === "local" || normalized === "host") {
        return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(date);
      }
      return new Intl.DateTimeFormat("en-US", { timeZone: trimmedZone, weekday: "short" }).format(
        date,
      );
    } catch {
      return undefined;
    }
  })();

  if (normalized === "utc" || normalized === "gmt") {
    const ts = formatUtcTimestamp(date);
    return weekday ? `${weekday} ${ts}` : ts;
  }
  if (normalized === "local" || normalized === "host") {
    const ts = formatZonedTimestamp(date) ?? formatUtcTimestamp(date);
    return weekday ? `${weekday} ${ts}` : ts;
  }
  const ts = formatZonedTimestamp(date, { timeZone: trimmedZone }) ?? formatUtcTimestamp(date);
  return weekday ? `${weekday} ${ts}` : ts;
}

export function formatLocalEnvelopeTimestamp(date: Date): string {
  return formatEnvelopeTimestamp(date, "local");
}
