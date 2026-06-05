// Provider operation retry tests cover retry timing and abort behavior.
import { describe, expect, it, vi } from "vitest";
import {
  executeProviderOperationWithRetry,
  resolveTransientProviderAttempts,
} from "./operation-retry.js";

describe("resolveTransientProviderAttempts", () => {
  it("does not round malformed attempt counts", () => {
    expect(resolveTransientProviderAttempts({ attempts: 1.5 })).toBe(1);
    expect(resolveTransientProviderAttempts({ attempts: Number.NaN })).toBe(1);
    expect(resolveTransientProviderAttempts({ attempts: Number.POSITIVE_INFINITY })).toBe(1);
    expect(resolveTransientProviderAttempts({ attempts: Number.MAX_SAFE_INTEGER + 1 })).toBe(1);
  });

  it("keeps valid attempt counts as integers", () => {
    expect(resolveTransientProviderAttempts({ attempts: 0 })).toBe(1);
    expect(resolveTransientProviderAttempts({ attempts: 3 })).toBe(3);
  });
});

describe("executeProviderOperationWithRetry", () => {
  it("does not turn fractional attempts into an extra execution", async () => {
    const operation = vi.fn(async () => {
      const error = new Error("HTTP 503");
      Object.assign(error, { status: 503 });
      throw error;
    });

    await expect(
      executeProviderOperationWithRetry({
        provider: "test",
        stage: "read",
        operation,
        retry: {
          attempts: 1.5,
          baseDelayMs: 0,
          maxDelayMs: 0,
        },
      }),
    ).rejects.toThrow("HTTP 503");

    expect(operation).toHaveBeenCalledTimes(1);
  });
});
