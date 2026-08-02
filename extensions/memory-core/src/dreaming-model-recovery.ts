/** Pure recovery policy for Dreaming model calls. */

export const DREAMING_MODEL_JIT_FIRST_BYTE_GRACE_MS = 10 * 60_000;
export const DREAMING_MODEL_JIT_TOTAL_GRACE_MS = 30 * 60_000;

const RETRY_BACKOFF_BASE_MS = 15_000;
const RETRY_BACKOFF_CAP_MS = 300_000;

export type DreamingModelTransportFailure =
  | "connection-refused"
  | "connection-reset"
  | "disconnected"
  | "dns"
  | "timeout";

export type DreamingModelFailure = {
  /** True once response content or a model-requested action has been observed. */
  outputObserved: boolean;
  httpStatus?: number;
  transportFailure?: DreamingModelTransportFailure;
};

export type DreamingModelRecoveryOutcome =
  | { kind: "retryable-before-output" }
  | { kind: "interrupted-after-output" }
  | { kind: "terminal" };

export type DreamingModelJitGrace = {
  firstByteMs: number;
  totalMs: number;
};

const RETRYABLE_HTTP_STATUSES = new Set([408, 429, 502, 503, 504]);

/**
 * Classifies only transport facts owned by the caller. Once output exists,
 * replay is ambiguous because the model may already have requested actions.
 */
export function classifyDreamingModelFailure(
  failure: DreamingModelFailure,
): DreamingModelRecoveryOutcome {
  if (failure.outputObserved) {
    return { kind: "interrupted-after-output" };
  }
  if (failure.transportFailure !== undefined) {
    return { kind: "retryable-before-output" };
  }
  if (
    failure.httpStatus !== undefined &&
    RETRYABLE_HTTP_STATUSES.has(Math.trunc(failure.httpStatus))
  ) {
    return { kind: "retryable-before-output" };
  }
  return { kind: "terminal" };
}

/** Returns 15s, 30s, 60s, 120s, 240s, then the bounded 300s delay. */
export function computeDreamingModelRetryDelayMs(consecutiveFailure: number): number {
  if (!Number.isFinite(consecutiveFailure) || consecutiveFailure <= 1) {
    return RETRY_BACKOFF_BASE_MS;
  }
  const exponent = Math.min(30, Math.floor(consecutiveFailure) - 1);
  return Math.min(RETRY_BACKOFF_CAP_MS, RETRY_BACKOFF_BASE_MS * 2 ** exponent);
}

/**
 * Resolves the quiet JIT-load window separately from the complete call budget.
 * The total budget may not be shorter than the first-byte grace period.
 */
export function resolveDreamingModelJitGrace(
  override: Partial<DreamingModelJitGrace> = {},
): DreamingModelJitGrace {
  const firstByteMs = resolvePositiveDuration(
    override.firstByteMs,
    DREAMING_MODEL_JIT_FIRST_BYTE_GRACE_MS,
  );
  const totalMs = resolvePositiveDuration(override.totalMs, DREAMING_MODEL_JIT_TOTAL_GRACE_MS);
  return { firstByteMs, totalMs: Math.max(firstByteMs, totalMs) };
}

function resolvePositiveDuration(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
