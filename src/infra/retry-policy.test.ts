import { afterEach, describe, expect, it, vi } from "vitest";

import { createTelegramRetryRunner } from "./retry-policy.js";

describe("createTelegramRetryRunner", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries when custom shouldRetry matches non-telegram error", async () => {
    vi.useFakeTimers();
    const runner = createTelegramRetryRunner({
      retry: { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 },
      shouldRetry: (err) => err instanceof Error && err.message === "boom",
    });
    const fn = vi
      .fn<[], Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue("ok");

    const promise = runner(fn, "request");
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
