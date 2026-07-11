// Provides generic retry timing and sleep helpers.
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { MAX_TIMER_TIMEOUT_MS, resolveTimerTimeoutMs } from "../shared/number-coercion.js";
import { sleep } from "../utils.js";
import { toErrorObject } from "./errors.js";
import { getRetryAttemptErrors, recordRetryAttemptErrors } from "./retry-attempt-errors.js";
import { generateSecureFraction } from "./secure-random.js";

/** Retry timing knobs shared by generic retry runners and channel retry policies. */
export type RetryConfig = {
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
  /**
   * Delay spread strategy. A fraction (0-1) spreads proportionally around the
   * backoff delay (existing behavior). `"full"` draws uniformly from
   * [delay, 2*delay): the backoff delay stays a hard floor and `maxDelayMs`
   * clamps after the draw, so capped attempts land exactly on the cap.
   */
  jitter?: number | "full";
};

/** Metadata emitted before a retry attempt sleeps and reruns the operation. */
export type RetryInfo = {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  err: unknown;
  label?: string;
};

/** Retry execution options, including predicates, Retry-After hooks, and retry callbacks. */
export type RetryOptions = RetryConfig & {
  label?: string;
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  retryAfterMs?: (err: unknown) => number | undefined;
  retryAfterMaxDelayMs?: number;
  onRetry?: (info: RetryInfo) => void;
  /** Random fraction source in [0, 1); injectable for deterministic tests. */
  random?: () => number;
};

const DEFAULT_RETRY_CONFIG = {
  attempts: 3,
  minDelayMs: 300,
  maxDelayMs: 30_000,
  jitter: 0,
};

function appendRetryAttemptError(attemptErrors: unknown[], err: unknown): void {
  const nestedAttempts = getRetryAttemptErrors(err);
  attemptErrors.push(...(nestedAttempts ?? [err]));
}

function createRetryFailure(attemptErrors: readonly unknown[]): Error {
  const failure = toErrorObject(
    attemptErrors.at(-1) ?? new Error("Retry failed"),
    "Non-Error thrown",
  );
  if (attemptErrors.length > 1) {
    // Preserve the public terminal-error identity while carrying every internal
    // attempt into duplicate-send decisions made outside the channel adapter.
    recordRetryAttemptErrors(failure, attemptErrors);
  }
  return failure;
}

const clampNumber = (value: unknown, fallback: number, min?: number, max?: number) => {
  const next = asFiniteNumber(value);
  if (next === undefined) {
    return fallback;
  }
  const floor = typeof min === "number" ? min : Number.NEGATIVE_INFINITY;
  const ceiling = typeof max === "number" ? max : Number.POSITIVE_INFINITY;
  return Math.min(Math.max(next, floor), ceiling);
};

function resolveAttemptCount(value: unknown, fallback: number): number {
  const candidate = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(1, Math.round(candidate));
}

function resolveRetryDelayMs(value: number): number {
  if (value === Number.POSITIVE_INFINITY) {
    return MAX_TIMER_TIMEOUT_MS;
  }
  return resolveTimerTimeoutMs(value, 0, 0);
}

function resolveJitterConfig(value: unknown, fallback: number | "full"): number | "full" {
  if (value === "full") {
    return "full";
  }
  const fraction = asFiniteNumber(value);
  if (fraction === undefined) {
    return fallback;
  }
  return Math.min(Math.max(fraction, 0), 1);
}

/** Resolves retry config overrides into clamped timer-safe settings. */
export function resolveRetryConfig(
  defaults: Required<RetryConfig> = DEFAULT_RETRY_CONFIG,
  overrides?: RetryConfig,
): Required<RetryConfig> {
  const attempts = resolveAttemptCount(
    clampNumber(overrides?.attempts, defaults.attempts, 1),
    defaults.attempts,
  );
  const minDelayMs = resolveRetryDelayMs(
    Math.round(clampNumber(overrides?.minDelayMs, defaults.minDelayMs, 0)),
  );
  const maxDelayMs = Math.max(
    minDelayMs,
    resolveRetryDelayMs(Math.round(clampNumber(overrides?.maxDelayMs, defaults.maxDelayMs, 0))),
  );
  const jitter = resolveJitterConfig(overrides?.jitter, defaults.jitter);
  return { attempts, minDelayMs, maxDelayMs, jitter };
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
      // Unsatisfiable over-cap Retry-After: an upward draw would be erased by
      // the caller's cap clamp and every client would land in lockstep at the
      // cap, so draw downward across one half-period instead. That preserves
      // spread (the invariant the numeric symmetric fallback below protects)
      // while staying as close to the server's hint as the cap allows.
      return Math.max(0, Math.round(delayMs * (0.5 + random() * 0.5)));
    }
    // Full jitter draws uniformly from [delay, 2*delay): the backoff delay is
    // a hard floor (never fire early), which also keeps honorable Retry-After
    // lower bounds. Callers clamp `maxDelayMs` after this, so capped attempts
    // land exactly on the cap (same boundary trade-off as `positive` mode
    // below). Ceil preserves the floor contract for fractional bases.
    return Math.max(0, Math.ceil(delayMs * (1 + random())));
  }
  if (jitter <= 0) {
    return delayMs;
  }
  // `symmetric` spreads within ±jitter around the base delay; correct for pure
  // exponential backoff where going slightly early is harmless. `positive`
  // only adds to the base delay; use it when the base delay is already a
  // lower bound the caller must respect (for example a server-supplied
  // Retry-After) so concurrent clients still spread without ever dipping
  // below the caller's floor.
  const fraction = random();
  const offset = mode === "positive" ? fraction * jitter : (fraction * 2 - 1) * jitter;
  const raw = delayMs * (1 + offset);
  // Rounding choice preserves the mode's contract. `positive` guarantees
  // `delay >= delayMs`, so a non-integer `delayMs` (e.g. retryAfterMs=1.4)
  // must round *up* — plain `Math.round(1.4)=1` would drop the delay below
  // the caller's lower bound and violate the Retry-After invariant the
  // positive branch exists to enforce. Symmetric has no floor contract so
  // it stays on `Math.round`.
  return Math.max(0, mode === "positive" ? Math.ceil(raw) : Math.round(raw));
}

/** Runs an async operation until it succeeds, retry policy stops, or attempts are exhausted. */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  attemptsOrOptions: number | RetryOptions = 3,
  initialDelayMs = 300,
): Promise<T> {
  if (typeof attemptsOrOptions === "number") {
    const attempts = resolveAttemptCount(attemptsOrOptions, DEFAULT_RETRY_CONFIG.attempts);
    const attemptErrors: unknown[] = [];
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await fn();
      } catch (err) {
        appendRetryAttemptError(attemptErrors, err);
        if (i === attempts - 1) {
          break;
        }
        const delay = resolveRetryDelayMs(initialDelayMs * 2 ** i);
        await sleep(delay);
      }
    }
    throw createRetryFailure(attemptErrors);
  }

  const options = attemptsOrOptions;

  const resolved = resolveRetryConfig(DEFAULT_RETRY_CONFIG, options);
  const maxAttempts = resolved.attempts;
  const minDelayMs = resolved.minDelayMs;
  const maxDelayMs =
    Number.isFinite(resolved.maxDelayMs) && resolved.maxDelayMs > 0
      ? resolved.maxDelayMs
      : Number.POSITIVE_INFINITY;
  const retryAfterMaxDelayMs =
    options.retryAfterMaxDelayMs === undefined
      ? maxDelayMs
      : Math.max(
          minDelayMs,
          resolveRetryDelayMs(Math.round(clampNumber(options.retryAfterMaxDelayMs, maxDelayMs, 0))),
        );
  const jitter = resolved.jitter;
  const random = options.random ?? generateSecureFraction;
  const shouldRetry = options.shouldRetry ?? (() => true);
  const attemptErrors: unknown[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      appendRetryAttemptError(attemptErrors, err);
      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
        break;
      }

      const retryAfterMs = options.retryAfterMs?.(err);
      const hasRetryAfter = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs);
      const baseDelay = hasRetryAfter
        ? Math.max(retryAfterMs, minDelayMs)
        : minDelayMs * 2 ** (attempt - 1);
      const delayCap = hasRetryAfter ? retryAfterMaxDelayMs : maxDelayMs;
      let delay = Math.min(baseDelay, delayCap);
      // Server-supplied Retry-After is a lower-bound contract with the
      // upstream rate limiter; symmetric jitter would let roughly half the
      // retries land before the requested time and invite escalation. Use
      // positive-only jitter in that case so clients still spread but never
      // dip below the server's hint.
      //
      // Exception: when retryAfterMs > maxDelayMs the base is already capped
      // to maxDelayMs, so positive jitter would be erased by the final clamp
      // below and every retry would land at exactly maxDelayMs — reintroducing
      // the thundering herd we are trying to avoid. In that case the server
      // contract is already unsatisfiable, so fall back to symmetric jitter
      // to preserve spread.
      // Use `<=` so the `retryAfterMs === maxDelayMs` boundary keeps the
      // positive-jitter contract. At the boundary, positive jitter followed by
      // the final clamp collapses every retry to exactly maxDelayMs — clients
      // do land in lockstep at that instant, which is thundering-herd-shaped
      // locally. The trade-off is deliberate: symmetric jitter at the boundary
      // would schedule roughly half the retries below maxDelayMs (=
      // retryAfterMs), which is a *Retry-After contract violation* and invites
      // upstream escalation (429 → extended cooldown / bans on Telegram,
      // Discord, etc.). A synchronized retry at the exact server-cleared
      // instant is strictly preferable to a spread that undercuts the server's
      // hint. Only switch to symmetric when the hint exceeds our local cap
      // (`retryAfterMs > maxDelayMs`), where the contract is already
      // unsatisfiable and we gain spread without adding a violation.
      const canHonorRetryAfter =
        hasRetryAfter && typeof retryAfterMs === "number" && retryAfterMs <= delayCap;
      // Full jitter's upward draw is inherently positive, so it serves both
      // plain backoff and honorable Retry-After floors; only the unsatisfiable
      // over-cap hint must switch to the symmetric downward spread. Numeric
      // jitter keeps the original positive/symmetric split.
      const overCapRetryAfter = hasRetryAfter && !canHonorRetryAfter;
      const wantsPositiveDraw = jitter === "full" ? !overCapRetryAfter : canHonorRetryAfter;
      delay = applyJitter(delay, jitter, wantsPositiveDraw ? "positive" : "symmetric", random);
      delay = Math.min(Math.max(delay, minDelayMs), delayCap);

      options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs: delay,
        err,
        label: options.label,
      });
      if (delay > 0) {
        await sleep(delay);
      }
    }
  }

  throw createRetryFailure(attemptErrors);
}
