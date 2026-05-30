// Numeric coercion helpers for plugin runtime inputs.

export {
  asFiniteNumberInRange,
  asSafeIntegerInRange,
  parseFiniteNumber,
  clampTimerTimeoutMs,
  clampPositiveTimerTimeoutMs,
  addTimerTimeoutGraceMs,
  resolvePositiveTimerTimeoutMs,
  resolveTimerTimeoutMs,
  finiteSecondsToTimerSafeMilliseconds,
  MAX_TIMER_TIMEOUT_MS,
  MAX_TIMER_TIMEOUT_SECONDS,
  resolveIntegerOption,
  resolveNonNegativeIntegerOption,
  resolveOptionalIntegerOption,
  parseStrictInteger,
  parseStrictFiniteNumber,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
  positiveSecondsToSafeMilliseconds,
  nonNegativeSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromDurationSeconds,
  resolveExpiresAtMsFromDurationOrEpoch,
  resolveExpiresAtMsFromEpochSeconds,
} from "../shared/number-coercion.js";
export { MAX_TCP_PORT, parseTcpPort } from "../infra/tcp-port.js";
