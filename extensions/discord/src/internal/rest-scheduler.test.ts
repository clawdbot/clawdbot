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
});
