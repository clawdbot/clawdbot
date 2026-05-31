//#region packages/normalization-core/src/number-coercion.d.ts
declare function asFiniteNumber(value: unknown): number | undefined;
declare function asFiniteNumberInRange(value: unknown, range: {
  min?: number;
  max?: number;
  minExclusive?: boolean;
  maxExclusive?: boolean;
}): number | undefined;
declare function asSafeIntegerInRange(value: unknown, range: {
  min?: number;
  max?: number;
}): number | undefined;
declare function parseFiniteNumber(value: unknown): number | undefined;
declare function parseStrictInteger(value: unknown): number | undefined;
declare function parseStrictFiniteNumber(value: unknown): number | undefined;
declare function asPositiveSafeInteger(value: unknown): number | undefined;
declare const MAX_TIMER_TIMEOUT_MS = 2147000000;
declare const MAX_TIMER_TIMEOUT_SECONDS: number;
declare const MAX_DATE_TIMESTAMP_MS = 8640000000000000;
declare const UNIX_EPOCH_ISO_STRING = "1970-01-01T00:00:00.000Z";
declare function asDateTimestampMs(value: unknown): number | undefined;
declare function isFutureDateTimestampMs(value: unknown, opts?: {
  nowMs?: number;
}): value is number;
declare function timestampMsToIsoString(value: unknown): string | undefined;
declare function resolveDateTimestampMs(value: unknown, fallbackValue?: unknown): number;
declare function resolveTimestampMsToIsoString(value: unknown, fallbackValue?: unknown): string;
declare function timestampMsToIsoFileStamp(value: unknown, fallbackValue?: unknown): string;
declare function clampTimerTimeoutMs(valueMs: unknown, minMs?: number): number | undefined;
declare function clampPositiveTimerTimeoutMs(valueMs: unknown): number | undefined;
declare function resolvePositiveTimerTimeoutMs(valueMs: unknown, fallbackMs: number): number;
declare function resolveTimerTimeoutMs(valueMs: unknown, fallbackMs: number, minMs?: number): number;
declare function addTimerTimeoutGraceMs(timeoutMs: unknown, graceMs?: number): number | undefined;
declare function finiteSecondsToTimerSafeMilliseconds(value: unknown, opts?: {
  floorSeconds?: boolean;
}): number | undefined;
declare function resolveIntegerOption(value: unknown, fallback: number, range?: {
  min?: number;
  max?: number;
}): number;
declare function resolveOptionalIntegerOption(value: unknown, range?: {
  min?: number;
  max?: number;
}): number | undefined;
declare function resolveNonNegativeIntegerOption(value: unknown, fallback: number): number;
declare function parseStrictPositiveInteger(value: unknown): number | undefined;
declare function parseStrictNonNegativeInteger(value: unknown): number | undefined;
declare function positiveSecondsToSafeMilliseconds(value: unknown): number | undefined;
declare function nonNegativeSecondsToSafeMilliseconds(value: unknown): number | undefined;
declare function resolveExpiresAtMsFromDurationMs(value: unknown, opts?: {
  nowMs?: number;
  bufferMs?: number;
  minRemainingMs?: number;
}): number | undefined;
declare function resolveExpiresAtMsFromDurationSeconds(value: unknown, opts?: {
  nowMs?: number;
  bufferMs?: number;
  minRemainingMs?: number;
}): number | undefined;
declare function resolveExpiresAtMsFromEpochSeconds(value: unknown, opts?: {
  bufferMs?: number;
  maxMs?: number;
}): number | undefined;
declare function resolveExpiresAtMsFromDurationOrEpoch(value: unknown, opts?: {
  nowMs?: number;
  relativeSecondsThreshold?: number;
  absoluteMillisecondsThreshold?: number;
}): number | undefined;
//#endregion
export { MAX_DATE_TIMESTAMP_MS, MAX_TIMER_TIMEOUT_MS, MAX_TIMER_TIMEOUT_SECONDS, UNIX_EPOCH_ISO_STRING, addTimerTimeoutGraceMs, asDateTimestampMs, asFiniteNumber, asFiniteNumberInRange, asPositiveSafeInteger, asSafeIntegerInRange, clampPositiveTimerTimeoutMs, clampTimerTimeoutMs, finiteSecondsToTimerSafeMilliseconds, isFutureDateTimestampMs, nonNegativeSecondsToSafeMilliseconds, parseFiniteNumber, parseStrictFiniteNumber, parseStrictInteger, parseStrictNonNegativeInteger, parseStrictPositiveInteger, positiveSecondsToSafeMilliseconds, resolveDateTimestampMs, resolveExpiresAtMsFromDurationMs, resolveExpiresAtMsFromDurationOrEpoch, resolveExpiresAtMsFromDurationSeconds, resolveExpiresAtMsFromEpochSeconds, resolveIntegerOption, resolveNonNegativeIntegerOption, resolveOptionalIntegerOption, resolvePositiveTimerTimeoutMs, resolveTimerTimeoutMs, resolveTimestampMsToIsoString, timestampMsToIsoFileStamp, timestampMsToIsoString };