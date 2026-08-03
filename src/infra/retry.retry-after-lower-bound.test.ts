// Regression: retryAsync's symmetric jitter violated server-supplied
// Retry-After as a lower bound. When `retryAfterMs` returned a finite value
// (for example from a 429/503 with a Retry-After header), the code went:
//
//   baseDelay = max(retryAfterMs, minDelayMs)
//   delay = min(baseDelay, maxDelayMs)
//   delay = applyJitter(delay, jitter)          // (-jitter .. +jitter) !!
//   delay = min(max(delay, minDelayMs), maxDelayMs)
//
// The `applyJitter` call used a symmetric window, so roughly half the
// retries landed at baseDelay * (1 - jitter) < retryAfterMs. The final clamp
// only restored the local minDelayMs floor, not the server's Retry-After
// value, so concurrent clients could retry before the rate limiter's hint —
// the exact anti-pattern Retry-After exists to avoid.
//
// Fix: when retryAfterMs is in effect, use positive-only jitter so the delay
// never drops below the server-supplied lower bound.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { retryAsync } from "./retry.js";

const randomMocks = vi.hoisted(() => ({
  generateSecureFraction: vi.fn(),
}));

vi.mock("./secure-random.js", () => ({
  generateSecureFraction: randomMocks.generateSecureFraction,
}));

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  randomMocks.generateSecureFraction.mockReset();
});

describe("retryAsync respects server-supplied Retry-After as a lower bound", () => {
  it("honors Retry-After at the maxDelayMs boundary without undercut", async () => {
    // When `retryAfterMs === maxDelayMs`, positive jitter plus the final clamp
    // collapses every retry to exactly maxDelayMs. That is thundering-herd-
    // shaped but the entire herd fires at — not before — the server-cleared
    // instant, which is strictly preferable to a symmetric spread that would
    // let ~50% of retries land below retryAfterMs and violate the Retry-After
    // contract. Only the strict `>` case (retryAfterMs above the local cap,
    // already unsatisfiable) falls back to symmetric jitter.
    //
    // Pick fraction=0 as the adversarial case: symmetric would produce 500 ms
    // here, which is the violation we are guarding against.
    randomMocks.generateSecureFraction.mockReturnValue(0);

    vi.useFakeTimers();
    const delays: number[] = [];
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("429 retry-after at cap"))
      .mockResolvedValueOnce("ok");

    const promise = retryAsync(fn, {
      attempts: 2,
      minDelayMs: 1,
      maxDelayMs: 1_000,
      jitter: 0.5,
      retryAfterMs: () => 1_000, // exactly at cap
      onRetry: (info) => delays.push(info.delayMs),
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");

    expect(delays).toHaveLength(1);
    // Strict Retry-After honor at the boundary: exactly the server-supplied
    // lower bound, never below it.
    expect(delays[0]).toBe(1_000);
  });

  it("preserves symmetric jitter when retryAfterMs exceeds maxDelayMs (avoids thundering herd)", async () => {
    // When the server asks for a delay larger than our local maxDelayMs, the
    // Retry-After contract is already unsatisfiable. Using positive-only jitter
    // in that case is worse than symmetric because the final clamp snaps every
    // retry back to maxDelayMs — concurrent clients re-attempt in lockstep.
    // Fall back to symmetric jitter so spread is preserved.
    randomMocks.generateSecureFraction.mockReturnValue(0);

    vi.useFakeTimers();
    const delays: number[] = [];
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("429 retry-after too large"))
      .mockResolvedValueOnce("ok");

    const promise = retryAsync(fn, {
      attempts: 2,
      minDelayMs: 1,
      maxDelayMs: 1_000, // hard cap
      jitter: 0.5,
      retryAfterMs: () => 10_000, // server asks more than we allow
      onRetry: (info) => delays.push(info.delayMs),
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");

    expect(delays).toHaveLength(1);
    // With fraction=0 and symmetric jitter, delay = 1000 * (1 - 0.5) = 500.
    // If we had stayed on "positive" mode, delay would have been exactly 1000
    // for every retry in this scenario.
    expect(delays[0]).toBeLessThan(1_000);
  });

  it("does not round a non-integer retryAfterMs below its lower bound", async () => {
    // Retry-After is typed as `number` (milliseconds), so non-integer values
    // are legal. With `Math.round` in positive mode, `retryAfterMs=1.4` and
    // `fraction=0` produce `Math.round(1.4 * 1) = 1`, which dips below the
    // caller's lower bound. `Math.ceil` in positive mode closes that gap.
    randomMocks.generateSecureFraction.mockReturnValue(0);

    vi.useFakeTimers();
    const delays: number[] = [];
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("429 non-integer retry-after"))
      .mockResolvedValueOnce("ok");

    const promise = retryAsync(fn, {
      attempts: 2,
      minDelayMs: 0,
      maxDelayMs: 10,
      jitter: 0.5,
      retryAfterMs: () => 1.4,
      onRetry: (info) => delays.push(info.delayMs),
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");

    expect(delays).toHaveLength(1);
    // Ceil-to-integer invariant: delay is at least the ceiling of the
    // caller-supplied lower bound, never below it.
    expect(delays[0]).toBeGreaterThanOrEqual(2);
  });

  it("never schedules a delay below retryAfterMs even at the low end of jitter", async () => {
    // fraction = 0 is the adversarial case: symmetric jitter yields -jitter,
    // i.e. delay = base * (1 - jitter), which would violate the Retry-After
    // lower bound. Positive jitter keeps delay = base (no change).
    randomMocks.generateSecureFraction.mockReturnValue(0);

    vi.useFakeTimers();
    const delays: number[] = [];
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("429 retry-after"))
      .mockResolvedValueOnce("ok");

    const promise = retryAsync(fn, {
      attempts: 2,
      minDelayMs: 1,
      maxDelayMs: 60_000,
      jitter: 0.5,
      retryAfterMs: () => 1_000,
      onRetry: (info) => delays.push(info.delayMs),
    });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");

    expect(delays).toHaveLength(1);
    // The critical assertion: the scheduled delay must not undercut the
    // server-supplied Retry-After even on the low end of the jitter window.
    expect(delays[0]).toBeGreaterThanOrEqual(1_000);
  });
});
