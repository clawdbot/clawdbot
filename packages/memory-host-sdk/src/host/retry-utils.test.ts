import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../../../gateway-client/src/timeouts.js";
import { resolveRetryConfig, retryAsync } from "./retry-utils.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveRetryConfig", () => {
  const defaults = {
    attempts: 4,
    minDelayMs: 0,
    maxDelayMs: 0,
    jitter: 0,
  };

  it("does not round malformed attempt counts", () => {
    expect(resolveRetryConfig(defaults, { attempts: 1.5 }).attempts).toBe(4);
    expect(resolveRetryConfig(defaults, { attempts: Number.POSITIVE_INFINITY }).attempts).toBe(4);
    expect(resolveRetryConfig(defaults, { attempts: Number.NaN }).attempts).toBe(4);
  });

  it("caps oversized retry delays at the timer-safe ceiling", () => {
    const config = resolveRetryConfig(defaults, {
      minDelayMs: Number.MAX_SAFE_INTEGER,
      maxDelayMs: Number.MAX_SAFE_INTEGER,
    });

    expect(config.minDelayMs).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(config.maxDelayMs).toBe(MAX_SAFE_TIMEOUT_DELAY_MS);
  });
});

describe("retryAsync", () => {
  it("falls back to the default attempt count for malformed numeric counts", async () => {
    const run = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(retryAsync(run, Number.NaN, 0)).rejects.toThrow("boom");

    expect(run).toHaveBeenCalledTimes(3);
  });

  it("caps legacy numeric retry sleeps at the timer-safe ceiling", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    await expect(retryAsync(run, 2, Number.MAX_SAFE_INTEGER)).resolves.toBe("ok");

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_SAFE_TIMEOUT_DELAY_MS);
  });

  it("caps retryAfterMs sleeps at the timer-safe ceiling", async () => {
    const run = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce("ok");
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
      if (typeof callback === "function") {
        callback();
      }
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    await expect(
      retryAsync(run, {
        attempts: 2,
        minDelayMs: 0,
        maxDelayMs: Number.MAX_SAFE_INTEGER,
        retryAfterMs: () => Number.MAX_SAFE_INTEGER,
      }),
    ).resolves.toBe("ok");

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_SAFE_TIMEOUT_DELAY_MS);
  });
});
