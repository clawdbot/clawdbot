import { describe, expect, it } from "vitest";
import {
  createBoundedCounter,
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "./webhook-memory-guards.js";

describe("createFixedWindowRateLimiter", () => {
  it("enforces a fixed-window request limit", () => {
    const limiter = createFixedWindowRateLimiter({
      windowMs: 60_000,
      maxRequests: 3,
      maxTrackedKeys: 100,
    });

    expect(limiter.isRateLimited("k", 1_000)).toBe(false);
    expect(limiter.isRateLimited("k", 1_001)).toBe(false);
    expect(limiter.isRateLimited("k", 1_002)).toBe(false);
    expect(limiter.isRateLimited("k", 1_003)).toBe(true);
  });

  it.each([
    {
      name: "resets counters after the window elapses",
      calls: [100, 101, 111],
      expected: [false, true, false],
    },
  ])("$name", ({ calls, expected }) => {
    const limiter = createFixedWindowRateLimiter({
      windowMs: 10,
      maxRequests: 1,
      maxTrackedKeys: 100,
    });

    expect(calls.map((nowMs) => limiter.isRateLimited("k", nowMs))).toEqual(expected);
  });

  it("prunes stale keys", () => {
    const limiter = createFixedWindowRateLimiter({
      windowMs: 10,
      maxRequests: 10,
      maxTrackedKeys: 100,
      pruneIntervalMs: 10,
    });

    for (let i = 0; i < 20; i += 1) {
      limiter.isRateLimited(`key-${i}`, 100);
    }
    expect(limiter.size()).toBe(20);

    limiter.isRateLimited("fresh", 120);
    expect(limiter.size()).toBe(1);
  });
});

describe("webhook memory guard key caps", () => {
  it("createFixedWindowRateLimiter caps tracked keys", () => {
    const limiter = createFixedWindowRateLimiter({
      windowMs: 60_000,
      maxRequests: 10,
      maxTrackedKeys: 5,
    });

    for (let i = 0; i < 20; i += 1) {
      limiter.isRateLimited(`key-${i}`, 1_000 + i);
    }

    expect(limiter.size()).toBeLessThanOrEqual(5);
  });

  it("createBoundedCounter caps tracked keys", () => {
    const counter = createBoundedCounter({ maxTrackedKeys: 3 });

    for (let i = 0; i < 10; i += 1) {
      counter.increment(`k-${i}`, 1_000 + i);
    }

    expect(counter.size()).toBeLessThanOrEqual(3);
  });
});

describe("createBoundedCounter", () => {
  it("increments and returns per-key counts", () => {
    const counter = createBoundedCounter({ maxTrackedKeys: 100 });

    expect([1_000, 1_001, 1_002].map((nowMs) => counter.increment("k", nowMs))).toEqual([1, 2, 3]);
  });

  it("expires stale keys when ttl is set", () => {
    const counter = createBoundedCounter({
      maxTrackedKeys: 100,
      ttlMs: 10,
      pruneIntervalMs: 10,
    });

    counter.increment("old-1", 100);
    counter.increment("old-2", 100);
    expect(counter.size()).toBe(2);

    counter.increment("fresh", 120);
    expect(counter.size()).toBe(1);
  });
});

describe("defaults", () => {
  it("exports shared webhook limit profiles", () => {
    expect(WEBHOOK_RATE_LIMIT_DEFAULTS).toEqual({
      windowMs: 60_000,
      maxRequests: 120,
      maxTrackedKeys: 4_096,
    });
    expect(WEBHOOK_ANOMALY_COUNTER_DEFAULTS.maxTrackedKeys).toBe(4_096);
    expect(WEBHOOK_ANOMALY_COUNTER_DEFAULTS.ttlMs).toBe(21_600_000);
    expect(WEBHOOK_ANOMALY_COUNTER_DEFAULTS.logEvery).toBe(25);
  });
});

describe("createWebhookAnomalyTracker", () => {
  it("increments only tracked status codes and logs at configured cadence", () => {
    const logs: string[] = [];
    const tracker = createWebhookAnomalyTracker({
      trackedStatusCodes: [401],
      logEvery: 2,
    });

    const counts = [
      {
        statusCode: 415,
        message: (count: number) => `ignored:${count}`,
      },
      {
        statusCode: 401,
        message: (count: number) => `hit:${count}`,
      },
      {
        statusCode: 401,
        message: (count: number) => `hit:${count}`,
      },
    ].map(({ statusCode, message }) =>
      tracker.record({
        key: "k",
        statusCode,
        message,
        log: (msg) => logs.push(msg),
      }),
    );

    expect(counts).toEqual([0, 1, 2]);
    expect(logs).toEqual(["hit:1", "hit:2"]);
  });
});
