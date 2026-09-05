// Duration parser shared by CLI flags, command directives, and config-backed timing values.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import milliseconds from "ms";

/** Options for choosing the unit used by bare numeric duration values. */
type DurationMsParseOptions = {
  defaultUnit?: "ms" | "s" | "m" | "h" | "d";
};

function invalidDuration(raw: string, reason?: string): Error {
  const value = raw.trim() ? `"${raw}"` : "empty value";
  const prefix = reason ? `Invalid duration (${reason}): ${value}.` : `Invalid duration: ${value}.`;
  return new Error(`${prefix} Use values like 500ms, 30s, 5m, 2h, or 1h30m.`);
}

function parseDurationToken(raw: string, value: string, unit: string): number {
  const parsed = milliseconds(`${value}${unit}` as Parameters<typeof milliseconds>[0]);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw invalidDuration(raw);
  }
  return parsed;
}

function roundSafeDurationMs(raw: string, value: number): number {
  const ms = Math.round(value);
  if (!Number.isSafeInteger(ms)) {
    throw invalidDuration(raw);
  }
  return ms;
}

/** Parse a non-negative duration into milliseconds, supporting single and composite units. */
export function parseDurationMs(raw: string, opts?: DurationMsParseOptions): number {
  const trimmed = normalizeLowercaseStringOrEmpty(normalizeOptionalString(raw) ?? "");
  if (!trimmed) {
    throw invalidDuration(raw, "empty");
  }

  // Fast path for a single token (supports default unit for bare numbers).
  const single = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(trimmed);
  if (single) {
    const value = single[1] ?? "";
    const unit = (single[2] ?? opts?.defaultUnit ?? "ms") as "ms" | "s" | "m" | "h" | "d";
    return roundSafeDurationMs(raw, parseDurationToken(raw, value, unit));
  }

  // Composite form (e.g. "1h30m", "2m500ms"); each token must include a unit.
  let totalMs = 0;
  let consumed = 0;
  const tokenRe = /(\d+(?:\.\d+)?)(ms|s|m|h|d)/g;
  for (const match of trimmed.matchAll(tokenRe)) {
    const [full, valueRaw, unitRaw] = match;
    const index = match.index ?? -1;
    if (!full || !valueRaw || !unitRaw || index < 0) {
      throw invalidDuration(raw);
    }
    if (index !== consumed) {
      throw invalidDuration(raw, "each composite segment needs a unit");
    }
    totalMs += parseDurationToken(raw, valueRaw, unitRaw);
    consumed += full.length;
  }

  if (consumed !== trimmed.length || consumed === 0) {
    throw invalidDuration(raw);
  }

  return roundSafeDurationMs(raw, totalMs);
}
