/**
 * Generic ingress retry backoff and dead-letter decisions.
 *
 * Channel-specific non-retryable classification stays out of core; pass it in.
 */

export const DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS = 8;
export const DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_INGRESS_RETRY_BASE_MS = 1_000;
export const DEFAULT_INGRESS_RETRY_MAX_MS = 3 * 60_000;

export type IngressRetryPolicyConfig = {
  maxAttempts?: number;
  deadLetterMinAgeMs?: number;
  baseMs?: number;
  maxMs?: number;
};

type IngressRetryEventFacts = {
  receivedAt: number;
  attempts?: number;
  lastAttemptAt?: number;
  lastError?: string;
};

export type IngressNonRetryableFailure = {
  reason: string;
  message: string;
};

type IngressFailureDisposition =
  | {
      kind: "fail";
      reason: string;
      message: string;
      attempt: number;
    }
  | {
      kind: "release";
      attempt: number;
      message: string;
    };

function resolveConfig(config?: IngressRetryPolicyConfig) {
  return {
    maxAttempts: config?.maxAttempts ?? DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
    deadLetterMinAgeMs: config?.deadLetterMinAgeMs ?? DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
    baseMs: config?.baseMs ?? DEFAULT_INGRESS_RETRY_BASE_MS,
    maxMs: config?.maxMs ?? DEFAULT_INGRESS_RETRY_MAX_MS,
  };
}

/** Next attempt number after a failed dispatch (1-based for the attempt just finished). */
function resolveIngressAttemptNumber(event: IngressRetryEventFacts): number {
  return (event.attempts ?? 0) + 1;
}

/** Remaining backoff delay before a released event may be claimed again. */
export function resolveIngressRetryDelayMs(
  event: IngressRetryEventFacts,
  config?: IngressRetryPolicyConfig,
  now = Date.now(),
): number {
  const { baseMs, maxMs } = resolveConfig(config);
  const attempts = event.attempts ?? 0;
  if (!event.lastError || event.lastAttemptAt === undefined || attempts <= 0) {
    return 0;
  }
  const exponent = Math.min(attempts - 1, 8);
  const delayMs = Math.min(maxMs, baseMs * 2 ** exponent);
  return Math.max(0, event.lastAttemptAt + delayMs - now);
}

/**
 * Dead-letter requires BOTH attempt floor and minimum age.
 * Over-limit events keep retrying at the capped delay until age is met.
 */
export function shouldDeadLetterRetryableIngressEvent(
  event: IngressRetryEventFacts,
  attempt: number,
  config?: IngressRetryPolicyConfig,
  now = Date.now(),
): boolean {
  const { maxAttempts, deadLetterMinAgeMs } = resolveConfig(config);
  return attempt >= maxAttempts && now - event.receivedAt >= deadLetterMinAgeMs;
}

/** Resolve release vs fail for a dispatch error using optional non-retryable hook. */
export function resolveIngressFailureDisposition(params: {
  err: unknown;
  event: IngressRetryEventFacts;
  formatError: (err: unknown) => string;
  resolveNonRetryableFailure?: (err: unknown) => IngressNonRetryableFailure | null;
  config?: IngressRetryPolicyConfig;
  now?: number;
}): IngressFailureDisposition {
  const now = params.now ?? Date.now();
  const attempt = resolveIngressAttemptNumber(params.event);
  const message = params.formatError(params.err);
  const nonRetryable = params.resolveNonRetryableFailure?.(params.err) ?? null;
  if (nonRetryable) {
    return {
      kind: "fail",
      reason: nonRetryable.reason,
      message: nonRetryable.message,
      attempt,
    };
  }
  if (shouldDeadLetterRetryableIngressEvent(params.event, attempt, params.config, now)) {
    return {
      kind: "fail",
      reason: "retry-limit-exceeded",
      message,
      attempt,
    };
  }
  return { kind: "release", attempt, message };
}

/** Abortable delay used by drain retry/backoff loops. */
export function sleepIngressRetryDelay(ms: number, abortSignal?: AbortSignal): Promise<void> {
  const abortError = () =>
    abortSignal?.reason instanceof Error ? abortSignal.reason : new Error("ingress-aborted");
  if (abortSignal?.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}
