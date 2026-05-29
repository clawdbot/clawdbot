import { describe, expect, it, vi } from "vitest";
import { resolveRetryConfig, retryAsync } from "./retry-utils.js";

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
});

describe("retryAsync", () => {
  it("falls back to the default attempt count for malformed numeric counts", async () => {
    const run = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(retryAsync(run, Number.NaN, 0)).rejects.toThrow("boom");

    expect(run).toHaveBeenCalledTimes(3);
  });
});
