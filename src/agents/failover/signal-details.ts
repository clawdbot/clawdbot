import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const MAX_FAILOVER_DETAIL_CANDIDATES = 12;
const MAX_FAILOVER_DETAIL_CHARS = 1_000;

function normalizeFailoverDetailString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > MAX_FAILOVER_DETAIL_CHARS
    ? truncateUtf16Safe(trimmed, MAX_FAILOVER_DETAIL_CHARS)
    : trimmed;
}

function appendFailoverDetailCandidate(candidates: string[], value: unknown): void {
  const normalized =
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? normalizeFailoverDetailString(String(value))
      : undefined;
  if (!normalized || candidates.includes(normalized)) {
    return;
  }
  candidates.push(normalized);
}

function collectFailoverDetailCandidates(
  value: unknown,
  candidates: string[],
  seen: Set<object>,
): void {
  if (
    candidates.length >= MAX_FAILOVER_DETAIL_CANDIDATES ||
    value === undefined ||
    value === null
  ) {
    return;
  }
  if (typeof value === "string") {
    appendFailoverDetailCandidate(candidates, value);
    const trimmed = value.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return;
    }
    try {
      collectFailoverDetailCandidates(JSON.parse(trimmed) as unknown, candidates, seen);
    } catch {
      // Non-JSON detail strings are still useful as direct classifier candidates.
    }
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    appendFailoverDetailCandidate(candidates, value);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of ["message", "param", "code", "type", "error", "detail", "body"]) {
    collectFailoverDetailCandidates(record[key], candidates, seen);
    if (candidates.length >= MAX_FAILOVER_DETAIL_CANDIDATES) {
      return;
    }
  }
}

export function extractFailoverSignalDetails(...values: unknown[]): string[] | undefined {
  const candidates: string[] = [];
  const seen = new Set<object>();
  for (const value of values) {
    collectFailoverDetailCandidates(value, candidates, seen);
    if (candidates.length >= MAX_FAILOVER_DETAIL_CANDIDATES) {
      break;
    }
  }
  return candidates.length > 0 ? candidates : undefined;
}
