const DEFAULT_SESSION_BACKFILL_LIMIT_DAYS = 92;
const MEMORY_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeMemoryDay(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const day = value.trim();
  if (!MEMORY_DAY_RE.test(day)) {
    throw new Error(`${flag} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new Error(`${flag} must be a valid calendar day.`);
  }
  return day;
}

export function normalizeSessionBackfillSelection(
  params: { from?: string; to?: string; limitDays?: number },
  labels: { from: string; to: string; limitDays: string } = {
    from: "--from",
    to: "--to",
    limitDays: "--limit-days",
  },
): { from?: string; to?: string; limitDays: number } {
  const from = normalizeMemoryDay(params.from, labels.from);
  const to = normalizeMemoryDay(params.to, labels.to);
  if (from !== undefined && to !== undefined && from > to) {
    throw new Error(`${labels.from} must not be after ${labels.to}.`);
  }
  const limitDays = params.limitDays ?? DEFAULT_SESSION_BACKFILL_LIMIT_DAYS;
  if (!Number.isInteger(limitDays) || limitDays <= 0) {
    throw new Error(`${labels.limitDays} must be a positive integer.`);
  }
  return {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    limitDays,
  };
}
