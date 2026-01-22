type EnvelopeTimestampZone = string;

function formatUtcTimestamp(date: Date): string {
  const yyyy = String(date.getUTCFullYear()).padStart(4, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const min = String(date.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${min}Z`;
}

function formatZonedTimestamp(date: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
  }).formatToParts(date);

  const pick = (type: string) => parts.find((part) => part.type === type)?.value;
  const yyyy = pick("year");
  const mm = pick("month");
  const dd = pick("day");
  const hh = pick("hour");
  const min = pick("minute");
  const tz = [...parts]
    .reverse()
    .find((part) => part.type === "timeZoneName")
    ?.value?.trim();

  if (!yyyy || !mm || !dd || !hh || !min) {
    throw new Error("Missing date parts for envelope timestamp formatting.");
  }

  return `${yyyy}-${mm}-${dd} ${hh}:${min}${tz ? ` ${tz}` : ""}`;
}

export function formatEnvelopeTimestamp(date: Date, zone: EnvelopeTimestampZone = "utc"): string {
  const normalized = zone.trim().toLowerCase();
  if (normalized === "utc" || normalized === "gmt") return formatUtcTimestamp(date);
  if (normalized === "local" || normalized === "host") return formatZonedTimestamp(date);
  return formatZonedTimestamp(date, zone);
}

export function formatLocalEnvelopeTimestamp(date: Date): string {
  return formatEnvelopeTimestamp(date, "local");
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
