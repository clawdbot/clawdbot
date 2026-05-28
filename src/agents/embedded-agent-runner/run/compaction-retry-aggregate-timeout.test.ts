import { describe, expect, it, vi } from "vitest";
import { waitForCompactionRetryWithAggregateTimeout } from "./compaction-retry-aggregate-timeout.js";

type AggregateTimeoutParams = Parameters<typeof waitForCompactionRetryWithAggregateTimeout>[0];
type TimeoutCallback = NonNullable<AggregateTimeoutParams["onTimeout"]>;
type TimeoutCallbackMock = ReturnType<typeof vi.fn<TimeoutCallback>>;

async function withFakeTimers(run: () => Promise<void>) {
  vi.useFakeTimers();
  vi.clearAllTimers();
  try {
    await run();
  } finally {
    await vi.runOnlyPendingTimersAsync();
    vi.clearAllTimers();
    vi.useRealTimers();
  }
}

function expectClearedTimeoutState(onTimeout: TimeoutCallbackMock, timedOut: boolean) {
  if (timedOut) {
    expect(onTimeout).toHaveBeenCalledTimes(1);
  } else {
    expect(onTimeout).not.toHaveBeenCalled();
  }
  expect(vi.getTimerCount()).toBe(0);
}

function buildAggregateTimeoutParams(
  overrides: Partial<AggregateTimeoutParams> &
    Pick<AggregateTimeoutParams, "waitForCompactionRetry">,
): AggregateTimeoutParams & { onTimeout: TimeoutCallbackMock } {
  const onTimeout =
    (overrides.onTimeout as TimeoutCallbackMock | undefined) ?? vi.fn<TimeoutCallback>();
  return {
    waitForCompactionRetry: overrides.waitForCompactionRetry,
    abortable: overrides.abortable ?? (async (promise) => await promise),
    aggregateTimeoutMs: overrides.aggregateTimeoutMs ?? 60_000,
    isCompactionStillInFlight: overrides.isCompactionStillInFlight,
    onTimeout,
  };
}

describe("waitForCompactionRetryWithAggregateTimeout", () => {
  it("times out and fires callback when compaction retry never resolves", async () => {
    await withFakeTimers(async () => {
      const waitForCompactionRetry = vi.fn(async () => await new Promise<void>(() => {}));
      const params = buildAggregateTimeoutParams({ waitForCompactionRetry });

      const resultPromise = waitForCompactionRetryWithAggregateTimeout(params);

      await vi.advanceTimersByTimeAsync(60_000);
      const result = await resultPromise;

      expect(result.timedOut).toBe(true);
      expectClearedTimeoutState(params.onTimeout, true);
    });
  });

  it("keeps waiting while compaction remains in flight", async () => {
    await withFakeTimers(async () => {
      let compactionInFlight = true;
      const waitForCompactionRetry = vi.fn(
        async () =>
          await new Promise<void>((resolve) => {
            setTimeout(() => {
              compactionInFlight = false;
              resolve();
            }, 170_000);
          }),
      );
      const params = buildAggregateTimeoutParams({
        waitForCompactionRetry,
        isCompactionStillInFlight: () => compactionInFlight,
      });

      const resultPromise = waitForCompactionRetryWithAggregateTimeout(params);

      await vi.advanceTimersByTimeAsync(170_000);
      const result = await resultPromise;

      expect(result.timedOut).toBe(false);
      expectClearedTimeoutState(params.onTimeout, false);
    });
  });

  it("times out after an idle timeout window", async () => {
    await withFakeTimers(async () => {
      let compactionInFlight = true;
      const waitForCompactionRetry = vi.fn(async () => await new Promise<void>(() => {}));
      setTimeout(() => {
        compactionInFlight = false;
      }, 90_000);
      const params = buildAggregateTimeoutParams({
        waitForCompactionRetry,
        isCompactionStillInFlight: () => compactionInFlight,
      });

      const resultPromise = waitForCompactionRetryWithAggregateTimeout(params);

      await vi.advanceTimersByTimeAsync(120_000);
      const result = await resultPromise;

      expect(result.timedOut).toBe(true);
      expectClearedTimeoutState(params.onTimeout, true);
    });
  });

  it("does not time out when compaction retry resolves", async () => {
    await withFakeTimers(async () => {
      const waitForCompactionRetry = vi.fn(async () => {});
      const params = buildAggregateTimeoutParams({ waitForCompactionRetry });

      const result = await waitForCompactionRetryWithAggregateTimeout(params);

      expect(result.timedOut).toBe(false);
      expectClearedTimeoutState(params.onTimeout, false);
    });
  });

  it("propagates immediate waitForCompactionRetry failures", async () => {
    await withFakeTimers(async () => {
      const waitError = new Error("compaction wait failed");
      const waitForCompactionRetry = vi.fn(async () => {
        throw waitError;
      });
      const params = buildAggregateTimeoutParams({ waitForCompactionRetry });

      await expect(waitForCompactionRetryWithAggregateTimeout(params)).rejects.toThrow(
        "compaction wait failed",
      );

      expectClearedTimeoutState(params.onTimeout, false);
    });
  });

  it("handles waitForCompactionRetry rejection after timeout wins", async () => {
    await withFakeTimers(async () => {
      let rejectWait: ((error: Error) => void) | undefined;
      const waitForCompactionRetry = vi.fn(
        async () =>
          await new Promise<void>((_resolve, reject) => {
            rejectWait = reject;
          }),
      );
      const params = buildAggregateTimeoutParams({ waitForCompactionRetry });

      const resultPromise = waitForCompactionRetryWithAggregateTimeout(params);

      await vi.advanceTimersByTimeAsync(60_000);
      const result = await resultPromise;

      rejectWait?.(new Error("cancelled after timeout"));
      await Promise.resolve();

      expect(result.timedOut).toBe(true);
      expectClearedTimeoutState(params.onTimeout, true);
    });
  });

  it("propagates abort errors from abortable and clears timer", async () => {
    await withFakeTimers(async () => {
      const abortError = new Error("aborted");
      abortError.name = "AbortError";
      const waitForCompactionRetry = vi.fn(async () => await new Promise<void>(() => {}));
      const params = buildAggregateTimeoutParams({
        waitForCompactionRetry,
        abortable: async () => {
          throw abortError;
        },
      });

      await expect(waitForCompactionRetryWithAggregateTimeout(params)).rejects.toThrow("aborted");

      expectClearedTimeoutState(params.onTimeout, false);
    });
  });
});
