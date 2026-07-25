import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplyLimiter } from "./reply-limiter.js";

describe("ReplyLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares five atomic claims while typing reserves the final reply", () => {
    const limiter = new ReplyLimiter({ limit: 5 });

    expect(limiter.claim("msg-1", 1)).toMatchObject({ allowed: true, remaining: 4 });
    expect(limiter.claim("msg-1", 1)).toMatchObject({ allowed: true, remaining: 3 });
    expect(limiter.claim("msg-1", 1)).toMatchObject({ allowed: true, remaining: 2 });
    expect(limiter.claim("msg-1", 1)).toMatchObject({ allowed: true, remaining: 1 });
    expect(limiter.claim("msg-1", 1)).toMatchObject({
      allowed: false,
      remaining: 1,
      fallbackReason: "limit_exceeded",
    });

    expect(limiter.claim("msg-1")).toMatchObject({ allowed: true, remaining: 0 });
    expect(limiter.claim("msg-1")).toMatchObject({
      allowed: false,
      remaining: 0,
      fallbackReason: "limit_exceeded",
    });
    expect(limiter.getStats()).toEqual({ trackedMessages: 1, totalReplies: 5 });
  });

  it("does not reopen an expired passive reply window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const limiter = new ReplyLimiter({ ttlMs: 60_000 });
    expect(limiter.claim("msg-1").allowed).toBe(true);

    vi.setSystemTime(60_001);
    expect(limiter.claim("msg-1")).toMatchObject({
      allowed: false,
      remaining: 0,
      fallbackReason: "expired",
    });
  });
});
