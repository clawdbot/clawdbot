/** Returns a number only when the input is already finite. */
export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Returns a finite number only when it satisfies the supplied inclusive/exclusive bounds. */
export function asFiniteNumberInRange(
  value: unknown,
  range: {
    min?: number;
    max?: number;
    minExclusive?: boolean;
    maxExclusive?: boolean;
  },
): number | undefined {
  const number = asFiniteNumber(value);
  if (number === undefined) {
    return undefined;
  }
  if (range.min !== undefined) {
    if (range.minExclusive ? number <= range.min : number < range.min) {
      return undefined;
    }
  }
  if (range.max !== undefined) {
    if (range.maxExclusive ? number >= range.max : number > range.max) {
      return undefined;
    }
  }
  return number;
}

/** Returns a safe integer only when it satisfies the supplied inclusive bounds. */
export function asSafeIntegerInRange(
  value: unknown,
  range: {
    min?: number;
    max?: number;
  },
): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return undefined;
  }
  if (range.min !== undefined && value < range.min) {
    return undefined;
  }
  if (range.max !== undefined && value > range.max) {
    return undefined;
  }
  return value;
}

function normalizeNumericString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Parses finite numbers from number values or strict numeric string tokens. */
export function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  return parseStrictFiniteNumber(value);
}

/** Parses only safe integer numbers or base-10 integer strings. */
export function parseStrictInteger(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeNumericString(value);
  if (!normalized || !/^[+-]?\d+$/.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** Parses only finite decimal/scientific string tokens, rejecting partial numbers. */
export function parseStrictFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeNumericString(value);
  if (!normalized || !/^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))(?:e[+-]?\d+)?$/i.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Returns positive safe integers without string coercion. */
export function asPositiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Conservative upper bound for Node timer delays. */
export const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;
/** Timer bound expressed in whole seconds for env/config inputs. */
export const MAX_TIMER_TIMEOUT_SECONDS = Math.floor(MAX_TIMER_TIMEOUT_MS / 1000);
/** Largest timestamp accepted by JavaScript Date. */
export const MAX_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
/** Fallback ISO value for invalid timestamp inputs. */
export const UNIX_EPOCH_ISO_STRING = "1970-01-01T00:00:00.000Z";

/** Returns a Date-valid millisecond timestamp. */
export function asDateTimestampMs(value: unknown): number | undefined {
  return asFiniteNumberInRange(value, {
    min: -MAX_DATE_TIMESTAMP_MS,
    max: MAX_DATE_TIMESTAMP_MS,
  });
}

/** Checks whether a Date-valid timestamp is after the supplied/current time. */
export function isFutureDateTimestampMs(
  value: unknown,
  opts: { nowMs?: number } = {},
): value is number {
  const timestampMs = asDateTimestampMs(value);
  const nowMs = asDateTimestampMs(opts.nowMs ?? Date.now());
  return timestampMs !== undefined && nowMs !== undefined && timestampMs > nowMs;
}

/** Converts Date-valid millisecond timestamps to ISO strings. */
export function timestampMsToIsoString(value: unknown): string | undefined {
  const timestampMs = asDateTimestampMs(value);
  return timestampMs === undefined ? undefined : new Date(timestampMs).toISOString();
}

/** Resolves a Date-valid timestamp with a Date-valid fallback. */
export function resolveDateTimestampMs(
  value: unknown,
  fallbackValue: unknown = Date.now(),
): number {
  return asDateTimestampMs(value) ?? asDateTimestampMs(fallbackValue) ?? 0;
}

/** Resolves a Date-valid timestamp to ISO, falling back to Unix epoch if needed. */
export function resolveTimestampMsToIsoString(
  value: unknown,
  fallbackValue: unknown = Date.now(),
): string {
  return (
    timestampMsToIsoString(value) ?? timestampMsToIsoString(fallbackValue) ?? UNIX_EPOCH_ISO_STRING
  );
}

/** Formats Date-valid timestamps for filenames by replacing colon separators. */
export function timestampMsToIsoFileStamp(
  value: unknown,
  fallbackValue: unknown = Date.now(),
): string {
  return resolveTimestampMsToIsoString(value, fallbackValue).replaceAll(":", "-");
}

/** Clamps finite millisecond values into the Node-safe timer range. */
export function clampTimerTimeoutMs(valueMs: unknown, minMs = 1): number | undefined {
  const value = asFiniteNumber(valueMs);
  if (value === undefined) {
    return undefined;
  }
  const min = Math.max(1, Math.floor(minMs));
  return Math.min(Math.max(Math.floor(value), min), MAX_TIMER_TIMEOUT_MS);
}

/** Clamps positive finite millisecond values into the Node-safe timer range. */
export function clampPositiveTimerTimeoutMs(valueMs: unknown): number | undefined {
  const value = asFiniteNumber(valueMs);
  if (value === undefined || value <= 0) {
    return undefined;
  }
  return clampTimerTimeoutMs(value);
}

/** Resolves a positive timer timeout or falls back through safe timer clamping. */
export function resolvePositiveTimerTimeoutMs(valueMs: unknown, fallbackMs: number): number {
  return clampPositiveTimerTimeoutMs(valueMs) ?? resolveTimerTimeoutMs(fallbackMs, 1);
}

/** Resolves arbitrary timeout input with fallback and minimum timer bounds. */
export function resolveTimerTimeoutMs(valueMs: unknown, fallbackMs: number, minMs = 1): number {
  const value = asFiniteNumber(valueMs) ?? asFiniteNumber(fallbackMs);
  const min = Math.max(0, Math.floor(minMs));
  if (value === undefined) {
    return min;
  }
  return Math.min(Math.max(Math.floor(value), min), MAX_TIMER_TIMEOUT_MS);
}

/** Adds grace time to a finite timeout and clamps the result to Node-safe bounds. */
export function addTimerTimeoutGraceMs(timeoutMs: unknown, graceMs = 5_000): number | undefined {
  const timeout = asFiniteNumber(timeoutMs);
  const grace = asFiniteNumber(graceMs);
  if (timeout === undefined || grace === undefined) {
    return undefined;
  }
  const withGrace = timeout + grace;
  return Number.isFinite(withGrace) ? clampTimerTimeoutMs(withGrace) : MAX_TIMER_TIMEOUT_MS;
}

/** Converts finite positive seconds to Node-safe milliseconds. */
export function finiteSecondsToTimerSafeMilliseconds(
  value: unknown,
  opts: { floorSeconds?: boolean } = {},
): number | undefined {
  const seconds = asFiniteNumber(value);
  if (seconds === undefined || seconds <= 0) {
    return undefined;
  }
  const boundedSeconds = opts.floorSeconds ? Math.floor(seconds) : seconds;
  if (boundedSeconds >= MAX_TIMER_TIMEOUT_SECONDS) {
    return MAX_TIMER_TIMEOUT_MS;
  }
  const milliseconds = Math.floor(boundedSeconds * 1000);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return undefined;
  }
  return Math.min(milliseconds, MAX_TIMER_TIMEOUT_MS);
}

/** Resolves an integer option from finite numeric input or fallback, then clamps bounds. */
export function resolveIntegerOption(
  value: unknown,
  fallback: number,
  range: {
    min?: number;
    max?: number;
  } = {},
): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const floored = Math.floor(candidate);
  const minBounded = range.min === undefined ? floored : Math.max(range.min, floored);
  return range.max === undefined ? minBounded : Math.min(range.max, minBounded);
}

/** Resolves an optional integer option, returning undefined for non-finite input. */
export function resolveOptionalIntegerOption(
  value: unknown,
  range: {
    min?: number;
    max?: number;
  } = {},
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return resolveIntegerOption(value, value, range);
}

/** Resolves an integer option with a non-negative lower bound. */
export function resolveNonNegativeIntegerOption(value: unknown, fallback: number): number {
  return resolveIntegerOption(value, fallback, { min: 0 });
}

/** Parses strict positive integer values from numbers or strings. */
export function parseStrictPositiveInteger(value: unknown): number | undefined {
  const parsed = parseStrictInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

/** Parses strict non-negative integer values from numbers or strings. */
export function parseStrictNonNegativeInteger(value: unknown): number | undefined {
  const parsed = parseStrictInteger(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

/** Converts strict positive seconds to safe millisecond counts. */
export function positiveSecondsToSafeMilliseconds(value: unknown): number | undefined {
  const seconds = parseStrictPositiveInteger(value);
  if (seconds === undefined) {
    return undefined;
  }
  const milliseconds = seconds * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

/** Converts strict non-negative seconds to safe millisecond counts. */
export function nonNegativeSecondsToSafeMilliseconds(value: unknown): number | undefined {
  const seconds = parseStrictNonNegativeInteger(value);
  if (seconds === undefined) {
    return undefined;
  }
  const milliseconds = seconds * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

/** Resolves an absolute expiration timestamp from a positive duration in milliseconds. */
export function resolveExpiresAtMsFromDurationMs(
  value: unknown,
  opts: { nowMs?: number; bufferMs?: number; minRemainingMs?: number } = {},
): number | undefined {
  const durationMs = asPositiveSafeInteger(value);
  if (durationMs === undefined) {
    return undefined;
  }
  const nowMs = asDateTimestampMs(opts.nowMs ?? Date.now());
  const bufferMs = asFiniteNumber(opts.bufferMs ?? 0);
  if (nowMs === undefined || bufferMs === undefined) {
    return undefined;
  }
  const expiresAt = nowMs + durationMs - bufferMs;
  if (!Number.isSafeInteger(expiresAt) || timestampMsToIsoString(expiresAt) === undefined) {
    return undefined;
  }
  const minRemainingMs = opts.minRemainingMs;
  if (minRemainingMs === undefined) {
    return expiresAt;
  }
  const minExpiresAt = nowMs + minRemainingMs;
  if (!Number.isSafeInteger(minExpiresAt) || timestampMsToIsoString(minExpiresAt) === undefined) {
    return expiresAt;
  }
  return Math.max(expiresAt, minExpiresAt);
}

/** Resolves an absolute expiration timestamp from a positive duration in seconds. */
export function resolveExpiresAtMsFromDurationSeconds(
  value: unknown,
  opts: { nowMs?: number; bufferMs?: number; minRemainingMs?: number } = {},
): number | undefined {
  const durationMs = positiveSecondsToSafeMilliseconds(value);
  return durationMs === undefined ? undefined : resolveExpiresAtMsFromDurationMs(durationMs, opts);
}

/** Resolves an absolute expiration timestamp from Unix epoch seconds. */
export function resolveExpiresAtMsFromEpochSeconds(
  value: unknown,
  opts: { bufferMs?: number; maxMs?: number } = {},
): number | undefined {
  const epochMs =
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.trunc(value) * 1000
      : positiveSecondsToSafeMilliseconds(value);
  if (epochMs === undefined) {
    return undefined;
  }
  const expiresAt = epochMs - (opts.bufferMs ?? 0);
  if (!Number.isSafeInteger(expiresAt)) {
    return undefined;
  }
  if (timestampMsToIsoString(expiresAt) === undefined) {
    return undefined;
  }
  const maxMs = opts.maxMs;
  return maxMs === undefined || expiresAt <= maxMs ? expiresAt : undefined;
}

/** Resolves expiration input that may be relative seconds, epoch seconds, or epoch milliseconds. */
export function resolveExpiresAtMsFromDurationOrEpoch(
  value: unknown,
  opts: {
    nowMs?: number;
    relativeSecondsThreshold?: number;
    absoluteMillisecondsThreshold?: number;
  } = {},
): number | undefined {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    return undefined;
  }
  const relativeSecondsThreshold = opts.relativeSecondsThreshold ?? 1_000_000_000;
  if (parsed < relativeSecondsThreshold) {
    return resolveExpiresAtMsFromDurationSeconds(parsed, { nowMs: opts.nowMs });
  }
  const absoluteMillisecondsThreshold = opts.absoluteMillisecondsThreshold ?? 1_000_000_000_000;
  if (parsed < absoluteMillisecondsThreshold) {
    return resolveExpiresAtMsFromEpochSeconds(parsed);
  }
  return asDateTimestampMs(parsed);
}
