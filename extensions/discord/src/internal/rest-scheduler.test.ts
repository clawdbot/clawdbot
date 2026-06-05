// Discord tests cover rest scheduler plugin behavior.
import { MAX_DATE_TIMESTAMP_MS, MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { describe, expect, it, vi } from "vitest";
import { RateLimitError } from "./rest-errors.js";
import { RestScheduler, type RestSchedulerOptions } from "./rest-scheduler.js";
import { createJsonResponse } from "./test-builders.test-support.js";

function createOptions(overrides: Partial<RestSchedulerOptions> = {}): RestSchedulerOptions {
  return {
    lanes: {
      critical: { maxQueueSize: 10, weight: 3 },
      standard: { maxQueueSize: 10, weight: 2 },
      background: { maxQueueSize: 10, staleAfterMs: 20_000, weight: 1 },
    },
    maxConcurrency: 2,
    maxQueueSize: 20,
    maxRateLimitRetries: 1,
    ...overrides,
  };
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("RestScheduler", () => {
  it("defaults non-finite scheduler options before dispatching", async () => {
    const executor = vi.fn(async () => ({ ok: true }));
    const scheduler = new RestScheduler(
      createOptions({
        lanes: {
          critical: { maxQueueSize: Number.NaN, weight: Number.POSITIVE_INFINITY },
          standard: { maxQueueSize: Number.NaN, weight: Number.NaN },
          background: {
            maxQueueSize: Number.NaN,
            staleAfterMs: Number.NaN,
            weight: Number.NEGATIVE_INFINITY,
          },
        },
        maxConcurrency: Number.NaN,
        maxQueueSize: Number.NaN,
        maxRateLimitRetries: Number.NaN,
      }),
      executor,
    );

    await expect(
      scheduler.enqueue({ method: "GET", path: "/guilds/g1/roles", priority: "background" }),
    ).resolves.toEqual({ ok: true });

    expect(executor).toHaveBeenCalledTimes(1);
    expect(scheduler.getMetrics().maxConcurrentWorkers).toBe(1);
  });

  it("does not retry forever when maxRateLimitRetries is non-finite", async () => {
    const executor = vi.fn(async () => {
      throw new RateLimitError(
        createJsonResponse(
          { message: "Rate limited", retry_after: 0.1, global: false },
          { status: 429 },
        ),
        { message: "Rate limited", retry_after: 0.1, global: false },
      );
    });
    const scheduler = new RestScheduler(
      createOptions({ maxRateLimitRetries: Number.POSITIVE_INFINITY }),
      executor,
    );

    await expect(
      scheduler.enqueue({ method: "GET", path: "/channels/c1/messages", priority: "background" }),
    ).rejects.toBeInstanceOf(RateLimitError);

    expect(executor).toHaveBeenCalledTimes(1);
    expect(scheduler.queueSize).toBe(0);
  });

  it("ignores 429 retry deadlines that exceed the Date range", () => {
    vi.useFakeTimers();
    vi.setSystemTime(MAX_DATE_TIMESTAMP_MS);
    try {
      const scheduler = new RestScheduler(createOptions(), vi.fn());
      scheduler.recordResponse(
        "GET /channels/c1/messages",
        "/channels/c1/messages",
        createJsonResponse(
          { message: "Rate limited", retry_after: 1, global: true },
          { status: 429 },
        ),
        { message: "Rate limited", retry_after: 1, global: true },
      );

      expect(scheduler.getMetrics().globalRateLimitUntil).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps immediate 429 retry deadlines working", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T12:00:00.000Z"));
    try {
      const scheduler = new RestScheduler(createOptions(), vi.fn());
      scheduler.recordResponse(
        "GET /channels/c1/messages",
        "/channels/c1/messages",
        createJsonResponse(
          { message: "Rate limited", retry_after: 0, global: true },
          { status: 429 },
        ),
        { message: "Rate limited", retry_after: 0, global: true },
      );

      expect(scheduler.getMetrics().globalRateLimitUntil).toBe(Date.now());
    } finally {
      vi.useRealTimers();
    }
  });

  it("rounds fractional millisecond 429 retry deadlines up", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-28T12:00:00.000Z"));
    try {
      const scheduler = new RestScheduler(createOptions(), vi.fn());
      scheduler.recordResponse(
        "GET /channels/c1/messages",
        "/channels/c1/messages",
        createJsonResponse(
          { message: "Rate limited", retry_after: 0.0004, global: true },
          { status: 429 },
        ),
        { message: "Rate limited", retry_after: 0.0004, global: true },
      );

      expect(scheduler.getMetrics().globalRateLimitUntil).toBe(Date.now() + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps oversized route rate-limit drain waits before scheduling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const first = createDeferred<unknown>();
      const executor = vi.fn(async () => await first.promise);
      const scheduler = new RestScheduler(createOptions({ maxConcurrency: 1 }), executor);

      const active = scheduler.enqueue({
        method: "POST",
        path: "/channels/c1/messages",
        priority: "standard",
      });
      await vi.waitFor(() => expect(executor).toHaveBeenCalledTimes(1));
      scheduler.recordResponse(
        "POST /channels/c1/messages",
        "/channels/c1/messages",
        createJsonResponse(
          { message: "Rate limited", retry_after: 0, global: false },
          {
            status: 429,
            headers: {
              "X-RateLimit-Bucket": "bucket-1",
              "X-RateLimit-Remaining": "0",
              "X-RateLimit-Reset-After": String((MAX_TIMER_TIMEOUT_MS + 1_000_000) / 1000),
            },
          },
        ),
        { message: "Rate limited", retry_after: 0, global: false },
      );

      const queued = scheduler.enqueue({
        method: "POST",
        path: "/channels/c1/messages",
        priority: "standard",
      });
      first.resolve({ ok: true });
      await expect(active).resolves.toEqual({ ok: true });

      expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
      queued.catch(() => undefined);
    } finally {
      schedulerCleanup(timeoutSpy);
      vi.useRealTimers();
    }
  });
});

function schedulerCleanup(timeoutSpy: ReturnType<typeof vi.spyOn>): void {
  timeoutSpy.mockRestore();
}
