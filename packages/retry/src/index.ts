const MAX_TIMER_TIMEOUT_MS = 2_147_000_000;

export type BackoffPolicy = {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
};

export function computeBackoff(policy: BackoffPolicy, attempt: number): number {
  const base = Math.min(policy.maxMs, policy.initialMs * policy.factor ** Math.max(attempt - 1, 0));
  const jitter = base * policy.jitter * Math.random();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}

export function computeBackoffSchedule(scheduleMs: readonly number[], attempt: number): number {
  const index = Math.min(attempt - 1, scheduleMs.length - 1);
  return attempt <= 0 ? 0 : (scheduleMs[index] ?? 0);
}

export async function sleepWithAbort(
  ms: number,
  abortSignal?: AbortSignal,
  options: { ref?: boolean } = {},
): Promise<void> {
  if (!Number.isFinite(ms) || ms <= 0) {
    return;
  }
  const delayMs = Math.min(Math.max(Math.floor(ms), 1), MAX_TIMER_TIMEOUT_MS);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => abortSignal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      timer = null;
      cleanup();
      reject(new Error("aborted", { cause: abortSignal?.reason ?? new Error("aborted") }));
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    if (abortSignal?.aborted) {
      onAbort();
      return;
    }
    timer = setTimeout(() => {
      settled = true;
      cleanup();
      timer = null;
      resolve();
    }, delayMs);
    // Retry loops can stay abortable without keeping an otherwise idle process alive.
    if (options.ref === false) {
      timer.unref?.();
    }
    if (abortSignal?.aborted) {
      onAbort();
    }
  });
}

export class RetrySupervisor {
  attempts = 0;
  nextDelayOverrideMs: number | undefined;
  private initialMs: number;
  private pendingAbort: AbortController | undefined;

  constructor(
    private readonly policy: BackoffPolicy,
    private readonly maxAttempts = Number.POSITIVE_INFINITY,
  ) {
    this.initialMs = policy.initialMs;
  }

  reset(initialMs = this.policy.initialMs): void {
    this.cancel();
    this.attempts = 0;
    this.initialMs = initialMs;
    this.nextDelayOverrideMs = undefined;
  }

  cancel(reason: unknown = new Error("retry cancelled")): void {
    this.pendingAbort?.abort(reason);
    this.pendingAbort = undefined;
  }

  next(abortSignal?: AbortSignal) {
    const override = this.nextDelayOverrideMs;
    this.nextDelayOverrideMs = undefined;
    if (override === undefined && ++this.attempts > Math.ceil(this.maxAttempts)) {
      return undefined;
    }
    const attempt = Math.max(this.attempts, 1);
    const delayMs =
      override ?? computeBackoff({ ...this.policy, initialMs: this.initialMs }, attempt);
    this.cancel();
    const pendingAbort = new AbortController();
    this.pendingAbort = pendingAbort;
    return {
      attempt,
      delayMs,
      signal: abortSignal
        ? AbortSignal.any([pendingAbort.signal, abortSignal])
        : pendingAbort.signal,
    };
  }
}

export type RetryConfig = {
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Fractional symmetric spread or full jitter. */
  jitter?: number | "full";
};

type RetryDelayContext = {
  attempt: number;
  maxAttempts: number;
  err: unknown;
  label?: string;
};

export type RetryInfo = RetryDelayContext & {
  delayMs: number;
};

export type RetryOptions = RetryConfig & {
  label?: string;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  retryAfterMs?: (err: unknown) => number | undefined;
  retryAfterMaxDelayMs?: number;
  delayMs?: number | ((context: RetryDelayContext) => number);
  onRetry?: (info: RetryInfo) => unknown;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type RetryRuntime = {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  createFailure?: (attemptErrors: readonly unknown[]) => Error;
};

const DEFAULT_RETRY_CONFIG: Required<RetryConfig> = {
  attempts: 3,
  minDelayMs: 300,
  maxDelayMs: 30_000,
  jitter: 0,
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampNumber(value: unknown, fallback: number, min?: number, max?: number): number {
  const next = asFiniteNumber(value);
  if (next === undefined) {
    return fallback;
  }
  return Math.min(Math.max(next, min ?? Number.NEGATIVE_INFINITY), max ?? Number.POSITIVE_INFINITY);
}

function resolveAttemptCount(value: unknown, fallback: number): number {
  return Math.max(1, Math.round(asFiniteNumber(value) ?? fallback));
}

function resolveRetryDelayMs(value: number): number {
  const finite =
    value === Number.POSITIVE_INFINITY ? MAX_TIMER_TIMEOUT_MS : (asFiniteNumber(value) ?? 0);
  return Math.min(Math.max(Math.round(finite), 0), MAX_TIMER_TIMEOUT_MS);
}

function resolveJitterConfig(value: unknown, fallback: number | "full"): number | "full" {
  if (value === "full") {
    return "full";
  }
  const fraction = asFiniteNumber(value);
  return fraction === undefined ? fallback : Math.min(Math.max(fraction, 0), 1);
}

export function resolveRetryConfig(
  defaults: Required<RetryConfig> = DEFAULT_RETRY_CONFIG,
  overrides?: RetryConfig,
): Required<RetryConfig> {
  const attempts = resolveAttemptCount(overrides?.attempts, defaults.attempts);
  const minDelayMs = resolveRetryDelayMs(
    clampNumber(overrides?.minDelayMs, defaults.minDelayMs, 0),
  );
  const maxDelayMs = Math.max(
    minDelayMs,
    resolveRetryDelayMs(clampNumber(overrides?.maxDelayMs, defaults.maxDelayMs, 0)),
  );
  return {
    attempts,
    minDelayMs,
    maxDelayMs,
    jitter: resolveJitterConfig(overrides?.jitter, defaults.jitter),
  };
}

type JitterMode = "symmetric" | "positive";

function applyJitter(
  delayMs: number,
  jitter: number | "full",
  mode: JitterMode,
  random: () => number,
): number {
  if (jitter === "full") {
    if (mode === "symmetric") {
      // Over-cap Retry-After cannot be honored. Spread downward instead of
      // letting the final cap collapse every client onto the same instant.
      return Math.max(0, Math.round(delayMs * (0.5 + random() * 0.5)));
    }
    return Math.max(0, Math.ceil(delayMs * (1 + random())));
  }
  if (jitter <= 0) {
    return mode === "positive" ? Math.ceil(delayMs) : delayMs;
  }
  const fraction = random();
  const offset = mode === "positive" ? fraction * jitter : (fraction * 2 - 1) * jitter;
  const raw = delayMs * (1 + offset);
  // Retry-After is a lower bound. Positive jitter must round upward or a
  // fractional server hint can be undercut even with a zero random draw.
  return Math.max(0, mode === "positive" ? Math.ceil(raw) : Math.round(raw));
}

export function toRetryError(value: unknown, fallbackMessage = "Non-Error thrown"): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}

export function createRetryRunner(runtime: RetryRuntime = {}) {
  const runtimeSleep = runtime.sleep ?? defaultSleep;
  const runtimeRandom = runtime.random ?? Math.random;
  const createFailure =
    runtime.createFailure ??
    ((errors: readonly unknown[]) => toRetryError(errors.at(-1) ?? new Error("Retry failed")));

  return async function retryAsync<T>(
    fn: () => Promise<T>,
    attemptsOrOptions: number | RetryOptions = 3,
    initialDelayMs = 300,
  ): Promise<T> {
    const attemptErrors: unknown[] = [];
    if (typeof attemptsOrOptions === "number") {
      const attempts = resolveAttemptCount(attemptsOrOptions, DEFAULT_RETRY_CONFIG.attempts);
      for (let index = 0; index < attempts; index += 1) {
        try {
          return await fn();
        } catch (err) {
          attemptErrors.push(err);
          if (index === attempts - 1) {
            break;
          }
          await runtimeSleep(resolveRetryDelayMs(initialDelayMs * 2 ** index));
        }
      }
      throw createFailure(attemptErrors);
    }

    const options = attemptsOrOptions;
    const resolved = resolveRetryConfig(DEFAULT_RETRY_CONFIG, options);
    const maxAttempts = resolved.attempts;
    const minDelayMs = resolved.minDelayMs;
    const maxDelayMs = resolved.maxDelayMs > 0 ? resolved.maxDelayMs : Number.POSITIVE_INFINITY;
    const retryAfterMaxDelayMs =
      options.retryAfterMaxDelayMs === undefined
        ? maxDelayMs
        : Math.max(
            minDelayMs,
            resolveRetryDelayMs(clampNumber(options.retryAfterMaxDelayMs, maxDelayMs, 0)),
          );
    const random = options.random ?? runtimeRandom;
    const sleep = options.sleep ?? runtimeSleep;
    const shouldRetry = options.shouldRetry ?? (() => true);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (err) {
        attemptErrors.push(err);
        if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
          break;
        }

        const context: RetryDelayContext = {
          attempt,
          maxAttempts,
          err,
          label: options.label,
        };
        const retryAfterMs = options.retryAfterMs?.(err);
        const hasRetryAfter = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs);
        const configuredDelay =
          typeof options.delayMs === "function" ? options.delayMs(context) : options.delayMs;
        const resolvedConfiguredDelay =
          configuredDelay === undefined ? undefined : resolveRetryDelayMs(configuredDelay);
        const baseDelay = hasRetryAfter
          ? Math.max(retryAfterMs, minDelayMs)
          : resolvedConfiguredDelay === undefined
            ? minDelayMs * 2 ** (attempt - 1)
            : Math.max(resolvedConfiguredDelay, minDelayMs);
        const delayCap = hasRetryAfter ? retryAfterMaxDelayMs : maxDelayMs;
        let delay = Math.min(baseDelay, delayCap);

        // Honorable Retry-After hints use positive jitter. Only an over-cap,
        // already-unsatisfiable hint may spread downward to avoid lockstep.
        const canHonorRetryAfter = hasRetryAfter && (retryAfterMs ?? 0) <= delayCap;
        const wantsPositiveDraw =
          resolved.jitter === "full" ? !hasRetryAfter || canHonorRetryAfter : canHonorRetryAfter;
        delay = applyJitter(
          delay,
          resolved.jitter,
          wantsPositiveDraw ? "positive" : "symmetric",
          random,
        );
        delay = Math.min(Math.max(delay, minDelayMs), delayCap);

        await options.onRetry?.({ ...context, delayMs: delay });
        if (delay > 0) {
          await sleep(delay);
        }
      }
    }

    throw createFailure(attemptErrors);
  };
}

export const retryAsync = createRetryRunner();
