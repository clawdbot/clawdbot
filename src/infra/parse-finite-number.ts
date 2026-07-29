// Number parsing facade for legacy infra imports; implementation lives in
// normalization-core so config, timers, and CLI parsing share one contract.
export {
  parseFiniteNumber,
  parseStrictFiniteNumber,
  parseStrictInteger,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
  clampTimerTimeoutMs,
  finiteSecondsToTimerSafeMilliseconds,
  MAX_TIMER_TIMEOUT_MS,
  MAX_TIMER_TIMEOUT_SECONDS,
  positiveSecondsToSafeMilliseconds,
  nonNegativeSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromDurationSeconds,
  resolveExpiresAtMsFromDurationOrEpoch,
  resolveExpiresAtMsFromEpochSeconds,
} from "../../packages/normalization-core/src/number-coercion.js";
