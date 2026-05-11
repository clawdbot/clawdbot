import { describe, expect, it } from "vitest";
import { createFixedWindowRateLimiter } from "./fixed-window-rate-limit.js";

function expectConsumeResult(
  result: { allowed: boolean; remaining: number; retryAfterMs: number },
  expected: { allowed: boolean; remaining: number; retryAfterMs: number },
): void {
  expect(result.allowed).toBe(expected.allowed);
  expect(result.remaining).toBe(expected.remaining);
  expect(result.retryAfterMs).toBe(expected.retryAfterMs);
}

describe("fixed-window rate limiter", () => {
  it("blocks after max requests until window reset", () => {
    let nowMs = 1_000;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 2,
      windowMs: 1_000,
      now: () => nowMs,
    });

    expectConsumeResult(limiter.consume(), { allowed: true, remaining: 1, retryAfterMs: 0 });
    expectConsumeResult(limiter.consume(), { allowed: true, remaining: 0, retryAfterMs: 0 });
    expectConsumeResult(limiter.consume(), { allowed: false, remaining: 0, retryAfterMs: 1_000 });

    nowMs += 1_000;
    expectConsumeResult(limiter.consume(), { allowed: true, remaining: 1, retryAfterMs: 0 });
  });

  it("clamps maxRequests and windowMs to at least one", () => {
    let nowMs = 100;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 0.2,
      windowMs: 0.4,
      now: () => nowMs,
    });

    expectConsumeResult(limiter.consume(), { allowed: true, remaining: 0, retryAfterMs: 0 });
    expectConsumeResult(limiter.consume(), { allowed: false, remaining: 0, retryAfterMs: 1 });

    nowMs += 1;
    expectConsumeResult(limiter.consume(), { allowed: true, remaining: 0, retryAfterMs: 0 });
  });

  it("reports the remaining retry window after later blocked attempts", () => {
    let nowMs = 1_000;
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 1,
      windowMs: 1_000,
      now: () => nowMs,
    });

    expectConsumeResult(limiter.consume(), { allowed: true, remaining: 0, retryAfterMs: 0 });

    nowMs += 250;
    expectConsumeResult(limiter.consume(), { allowed: false, remaining: 0, retryAfterMs: 750 });
  });

  it("supports explicit reset", () => {
    const limiter = createFixedWindowRateLimiter({
      maxRequests: 1,
      windowMs: 10_000,
    });
    expect(limiter.consume().allowed).toBe(true);
    expect(limiter.consume().allowed).toBe(false);
    limiter.reset();
    expect(limiter.consume().allowed).toBe(true);
  });
});
