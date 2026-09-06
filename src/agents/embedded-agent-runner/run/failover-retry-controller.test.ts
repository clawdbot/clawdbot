import { beforeEach, describe, expect, it, vi } from "vitest";
import { FailoverError } from "../../failover-error.js";

const mocks = vi.hoisted(() => ({
  sleepWithAbort: vi.fn(async (_ms: number, _abortSignal?: AbortSignal): Promise<void> => {}),
  warn: vi.fn((_message: string) => {}),
}));

vi.mock("../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../logger.js")>("../logger.js");
  return { ...actual, log: { ...actual.log, warn: mocks.warn } };
});

vi.mock("../../../infra/backoff.js", async () => {
  const actual = await vi.importActual<typeof import("../../../infra/backoff.js")>(
    "../../../infra/backoff.js",
  );
  return { ...actual, sleepWithAbort: mocks.sleepWithAbort };
});

import { createEmbeddedRunFailoverRetryController } from "./failover-retry-controller.js";

type ControllerInput = Parameters<typeof createEmbeddedRunFailoverRetryController>[0];

function createController(
  advanceAuthProfile: ControllerInput["advanceAuthProfile"],
  fallbackConfigured = false,
) {
  return createEmbeddedRunFailoverRetryController({
    runParams: {
      runId: "run:failover-retry-controller-test",
    } as ControllerInput["runParams"],
    provider: "openai",
    modelId: "gpt-5.6-luna",
    globalLane: "test",
    agentDir: "/tmp/openclaw-failover-retry-controller-test",
    fallbackConfigured,
    profileFailureStore: { version: 1, profiles: {} },
    getLastProfileId: () => "openai:p1",
    getSessionId: () => "session:failover-retry-controller-test",
    harnessOwnsTransport: () => false,
    getRuntimeAuthOwnerId: () => "embedded",
    getApiKeyInfo: () => null,
    advanceAuthProfile,
  });
}

const rateLimitContext = {
  failoverProvider: "openai",
  failoverModel: "gpt-5.6-luna",
  logFallbackDecision: vi.fn(),
};

describe("createEmbeddedRunFailoverRetryController", () => {
  beforeEach(() => {
    mocks.sleepWithAbort.mockReset().mockResolvedValue(undefined);
    mocks.warn.mockClear();
    rateLimitContext.logFallbackDecision.mockClear();
  });

  it("records the truncation when the window ends a budget that still has attempts", async () => {
    let nowMs = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      const controller = createController(vi.fn(async () => false));
      // A raised budget only delivers the attempts the 90s window fits; without this
      // record an operator cannot tell why the configured retries never ran.
      controller.setTransientRetryBudget(8);
      await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(true);
      nowMs += 90_000;
      await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(false);

      expect(controller.transientRetryCount).toBe(1);
      const truncationLog = mocks.warn.mock.calls.at(-1)?.[0];
      expect(truncationLog).toContain("transient retry window elapsed");
      expect(truncationLog).toContain("after 1/8 retries");
    } finally {
      dateNow.mockRestore();
    }
  });

  it("bounds transient retries across reasons and honors Retry-After", async () => {
    // The 90s budget is wall-clock from the first consult, so the mocked sleep
    // must advance the clock for the exhaustion branch to be reachable.
    let nowMs = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    mocks.sleepWithAbort.mockImplementation(async (delayMs: number) => {
      nowMs += delayMs;
    });
    try {
      const controller = createController(vi.fn(async () => false));

      await expect(
        controller.maybeRetryTransient({ reason: "server_error", retryAfterMs: 60_000 }),
      ).resolves.toBe(true);
      await expect(
        controller.maybeRetryTransient({ reason: "timeout", retryAfterMs: 30_000 }),
      ).resolves.toBe(true);
      await expect(controller.maybeRetryTransient({ reason: "overloaded" })).resolves.toBe(false);

      expect(controller.transientRetryCount).toBe(2);
      expect(mocks.sleepWithAbort).toHaveBeenCalledTimes(2);
      expect(mocks.sleepWithAbort.mock.calls[0]?.[0]).toBe(60_000);
      expect(mocks.sleepWithAbort.mock.calls[1]?.[0]).toBe(30_000);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("counts failed-request wall time against the retry budget", async () => {
    let nowMs = 1_000_000;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    try {
      const controller = createController(vi.fn(async () => false));
      await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(true);
      // A slow provider failure burns the window even though no backoff slept.
      nowMs += 90_000;
      await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(false);
      expect(controller.transientRetryCount).toBe(1);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("keeps profile rotation separate from transient retry accounting", async () => {
    const advanceAuthProfile = vi.fn(async () => true);
    const controller = createController(advanceAuthProfile);

    await expect(controller.advanceRateLimitAuthProfile(rateLimitContext)).resolves.toBe(true);
    await expect(controller.maybeRetryTransient({ reason: "rate_limit" })).resolves.toBe(true);

    expect(advanceAuthProfile).toHaveBeenCalledTimes(1);
    expect(controller.transientRetryCount).toBe(1);
    expect(mocks.sleepWithAbort).toHaveBeenCalledTimes(1);
  });

  it("allows eight transient retries across failure reasons when the ceiling has room", async () => {
    const controller = createController(vi.fn(async () => false));

    for (let attempt = 0; attempt < 2; attempt += 1) {
      for (const reason of ["rate_limit", "overloaded", "timeout", "server_error"] as const) {
        await expect(controller.maybeRetryTransient({ reason })).resolves.toBe(true);
      }
    }
    await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(false);
    expect(controller.transientRetryCount).toBe(8);
  });

  it("honors the saved provider retry budget", async () => {
    const controller = createController(vi.fn(async () => false));
    controller.setTransientRetryBudget(1);

    await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(true);
    await expect(controller.maybeRetryTransient({ reason: "server_error" })).resolves.toBe(false);
    expect(controller.transientRetryCount).toBe(1);
  });

  it("reports the scheduled recovery before waiting for backoff", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    mocks.sleepWithAbort.mockImplementation(
      (delayMs) =>
        new Promise<void>((resolve) => {
          setTimeout(resolve, delayMs);
        }),
    );
    try {
      const controller = createController(vi.fn(async () => false));
      const onRetry = vi.fn();
      const retry = controller.maybeRetryTransient({ reason: "server_error", onRetry });
      expect(onRetry).toHaveBeenCalledWith({
        attempt: 1,
        maxRetries: 8,
        delayMs: 500,
        reason: "server_error",
      });
      expect(controller.transientRetryCount).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
      await expect(retry).resolves.toBe(true);
      expect(mocks.sleepWithAbort).toHaveBeenCalledWith(500, undefined);
    } finally {
      random.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    ["429 Provider returned error", true],
    ["rate limit exceeded", true],
    ["Provider API error (429): Provider returned error", true],
    ["HTTP 429 Too Many Requests: requests per minute exceeded", true],
    ["429 RESOURCE_EXHAUSTED: tokens per minute limit exceeded", true],
    ["Quota exceeded for quota metric 'Generate requests per minute'", true],
    ["429 insufficient_quota: You exceeded your current quota", false],
    ["Provider API error (429): Quota exceeded [code=quota_exceeded]", false],
    ["429 usage limit reached for this billing period", false],
    ["429 rate_limit_exceeded; Retry-After: 3600", false],
  ] as const)(
    "budgets transient rate limits without retrying long quota limits: %s",
    async (message, expected) => {
      const controller = createController(vi.fn(async () => false));
      await expect(controller.maybeRetryTransient({ reason: "rate_limit", message })).resolves.toBe(
        expected,
      );
      expect(controller.transientRetryCount).toBe(expected ? 1 : 0);
      expect(mocks.sleepWithAbort).toHaveBeenCalledTimes(expected ? 1 : 0);
    },
  );

  it.each([
    ["429 rate_limit_exceeded; Retry-After: 30 seconds", 30_000],
    ["429 requests per minute exceeded. Please try again in 11.054s.", 11_054],
    ["429 tokens per minute exceeded. Please try again in 500ms.", 500],
  ] as const)("honors provider retry pacing: %s", async (message, delayMs) => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const controller = createController(vi.fn(async () => false));
      await expect(controller.maybeRetryTransient({ reason: "rate_limit", message })).resolves.toBe(
        true,
      );
      expect(mocks.sleepWithAbort).toHaveBeenCalledWith(delayMs, undefined);
    } finally {
      random.mockRestore();
    }
  });

  it("honors a short Retry-After HTTP date and skips one beyond the retry window", async () => {
    const nowMs = Date.parse("2026-06-11T00:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(nowMs);
    try {
      const controller = createController(vi.fn(async () => false));
      await expect(
        controller.maybeRetryTransient({
          reason: "rate_limit",
          message: "429 rate_limit_exceeded; Retry-After: Thu, 11 Jun 2026 00:00:30 GMT",
        }),
      ).resolves.toBe(true);
      await expect(
        controller.maybeRetryTransient({
          reason: "rate_limit",
          message: "429 rate_limit_exceeded; Retry-After: Thu, 11 Jun 2026 01:05:00 GMT",
        }),
      ).resolves.toBe(false);
      expect(mocks.sleepWithAbort.mock.calls).toEqual([[30_000, undefined]]);
      expect(controller.transientRetryCount).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(["auth", "billing", "format", "context_overflow"] as const)(
    "does not retry %s failures despite retry-shaped text",
    async (reason) => {
      const controller = createController(vi.fn(async () => false));
      await expect(
        controller.maybeRetryTransient({ reason, message: "Retry-After: 1" }),
      ).resolves.toBe(false);
      expect(mocks.sleepWithAbort).not.toHaveBeenCalled();
    },
  );

  it("escalates after one successful rate-limit rotation without advancing again", async () => {
    const advanceAuthProfile = vi.fn(async () => true);
    const controller = createController(advanceAuthProfile, true);

    await expect(controller.advanceRateLimitAuthProfile(rateLimitContext)).resolves.toBe(true);
    await expect(controller.advanceRateLimitAuthProfile(rateLimitContext)).rejects.toMatchObject({
      name: "FailoverError",
      reason: "rate_limit",
      status: 429,
    } satisfies Partial<FailoverError>);
    await expect(controller.advanceRateLimitAuthProfile(rateLimitContext)).rejects.toBeInstanceOf(
      FailoverError,
    );

    expect(advanceAuthProfile).toHaveBeenCalledTimes(1);
    expect(rateLimitContext.logFallbackDecision).toHaveBeenCalledTimes(2);
    expect(rateLimitContext.logFallbackDecision).toHaveBeenNthCalledWith(1, "fallback_model", {
      status: 429,
    });
  });
});
