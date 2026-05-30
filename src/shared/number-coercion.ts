export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

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

export function parseFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  return parseStrictFiniteNumber(value);
}

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

export function asPositiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;
export const MAX_TIMER_TIMEOUT_SECONDS = Math.floor(MAX_TIMER_TIMEOUT_MS / 1000);

export function clampTimerTimeoutMs(valueMs: unknown, minMs = 1): number | undefined {
  const value = asFiniteNumber(valueMs);
  if (value === undefined) {
    return undefined;
  }
  const min = Math.max(1, Math.floor(minMs));
  return Math.min(Math.max(Math.floor(value), min), MAX_TIMER_TIMEOUT_MS);
}

export function clampPositiveTimerTimeoutMs(valueMs: unknown): number | undefined {
  const value = asFiniteNumber(valueMs);
  if (value === undefined || value <= 0) {
    return undefined;
  }
  return clampTimerTimeoutMs(value);
}

export function resolvePositiveTimerTimeoutMs(valueMs: unknown, fallbackMs: number): number {
  return clampPositiveTimerTimeoutMs(valueMs) ?? resolveTimerTimeoutMs(fallbackMs, 1);
}

export function resolveTimerTimeoutMs(valueMs: unknown, fallbackMs: number, minMs = 1): number {
  const value = asFiniteNumber(valueMs) ?? asFiniteNumber(fallbackMs);
  const min = Math.max(0, Math.floor(minMs));
  if (value === undefined) {
    return min;
  }
  return Math.min(Math.max(Math.floor(value), min), MAX_TIMER_TIMEOUT_MS);
}

export function addTimerTimeoutGraceMs(timeoutMs: unknown, graceMs = 5_000): number | undefined {
  const timeout = asFiniteNumber(timeoutMs);
  const grace = asFiniteNumber(graceMs);
  if (timeout === undefined || grace === undefined) {
    return undefined;
  }
  const withGrace = timeout + grace;
  return Number.isFinite(withGrace) ? clampTimerTimeoutMs(withGrace) : MAX_TIMER_TIMEOUT_MS;
}

export function finiteSecondsToTimerSafeMilliseconds(
  value: unknown,
  opts: { floorSeconds?: boolean } = {},
): number | undefined {
  const seconds = asFiniteNumber(value);
  if (seconds === undefined || seconds <= 0) {
    return undefined;
  }
  const boundedSeconds = opts.floorSeconds ? Math.floor(seconds) : seconds;
  const milliseconds = Math.floor(boundedSeconds * 1000);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return undefined;
  }
  return Math.min(milliseconds, MAX_TIMER_TIMEOUT_MS);
}

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

export function resolveNonNegativeIntegerOption(value: unknown, fallback: number): number {
  return resolveIntegerOption(value, fallback, { min: 0 });
}

export function parseStrictPositiveInteger(value: unknown): number | undefined {
  const parsed = parseStrictInteger(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

export function parseStrictNonNegativeInteger(value: unknown): number | undefined {
  const parsed = parseStrictInteger(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

export function positiveSecondsToSafeMilliseconds(value: unknown): number | undefined {
  const seconds = parseStrictPositiveInteger(value);
  if (seconds === undefined) {
    return undefined;
  }
  const milliseconds = seconds * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

export function nonNegativeSecondsToSafeMilliseconds(value: unknown): number | undefined {
  const seconds = parseStrictNonNegativeInteger(value);
  if (seconds === undefined) {
    return undefined;
  }
  const milliseconds = seconds * 1000;
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

export function resolveExpiresAtMsFromDurationSeconds(
  value: unknown,
  opts: { nowMs?: number; bufferMs?: number; minRemainingMs?: number } = {},
): number | undefined {
  const durationMs = positiveSecondsToSafeMilliseconds(value);
  if (durationMs === undefined) {
    return undefined;
  }
  const nowMs = opts.nowMs ?? Date.now();
  const expiresAt = nowMs + durationMs - (opts.bufferMs ?? 0);
  if (!Number.isSafeInteger(expiresAt)) {
    return undefined;
  }
  const minRemainingMs = opts.minRemainingMs;
  return minRemainingMs === undefined ? expiresAt : Math.max(expiresAt, nowMs + minRemainingMs);
}

export function resolveExpiresAtMsFromEpochSeconds(
  value: unknown,
  opts: { bufferMs?: number } = {},
): number | undefined {
  const epochMs = positiveSecondsToSafeMilliseconds(value);
  if (epochMs === undefined) {
    return undefined;
  }
  const expiresAt = epochMs - (opts.bufferMs ?? 0);
  return Number.isSafeInteger(expiresAt) ? expiresAt : undefined;
}

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
    return positiveSecondsToSafeMilliseconds(parsed);
  }
  return parsed;
}
