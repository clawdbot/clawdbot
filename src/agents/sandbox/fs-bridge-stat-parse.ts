/**
 * Stat output parsers for sandbox filesystem bridges.
 *
 * Handles GNU/BSD size and mtime formats returned through backend shell commands.
 */
import { parseStrictNonNegativeInteger } from "../../infra/parse-finite-number.js";
import { asDateTimestampMs } from "../../shared/number-coercion.js";

/** Parses file sizes, capping huge integer strings at the largest safe JS integer. */
export function parseSandboxStatSize(value: string | undefined): number {
  const raw = value ?? "0";
  const parsed = parseStrictNonNegativeInteger(raw);
  if (parsed !== undefined) {
    return parsed;
  }
  return /^\d+$/.test(raw) ? Number.MAX_SAFE_INTEGER : 0;
}

/** Parses stat mtimes from epoch seconds or date strings into millisecond timestamps. */
export function parseSandboxStatMtimeMs(value: string | undefined): number {
  const raw = value ?? "0";
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const mtimeMs = Number(raw) * 1000;
    return asDateTimestampMs(mtimeMs) ?? 0;
  }
  const parsed = Date.parse(raw);
  return asDateTimestampMs(parsed) ?? 0;
}
