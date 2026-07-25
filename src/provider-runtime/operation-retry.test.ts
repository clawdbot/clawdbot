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

  it.each([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EPIPE",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EAI_AGAIN",
    "ENOTFOUND",
  ])("retries %s network failures from structured errors", async (code) => {
    const cause = Object.assign(new Error("connect failed"), { code });
    const error =
      code === "EPIPE"
        ? Object.assign(new Error("socket closed"), { code })
        : new Error("fetch failed", { cause });
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("ok");

    await expect(
      executeProviderOperationWithRetry({
        provider: "test",
        stage: "read",
        operation,
        retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      }),
    ).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it.each([
    [429, Object.assign(new Error("Too Many Requests"), { status: 429 })],
    ["HTTP 429", new Error("HTTP 429 Too Many Requests")],
  ])("retries %s rate limit errors", async (_label, error) => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(error)
      .mockResolvedValue("ok");

    await expect(
      executeProviderOperationWithRetry({
        provider: "test",
        stage: "read",
        operation,
        retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      }),
    ).resolves.toBe("ok");
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["HTTP 400", Object.assign(new Error("Bad Request"), { status: 400 })],
    ["ENOENT", new Error("ENOENT: no such file or directory")],
  ])("does not retry %s failures", async (_label, error) => {
    const operation = vi.fn(async () => {
      throw error;
    });

    await expect(
      executeProviderOperationWithRetry({
        provider: "test",
        stage: "read",
        operation,
        retry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0 },
      }),
    ).rejects.toThrow();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("does not retry create operations by default", async () => {
    const operation = vi.fn(async () => {
      throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    });

    await expect(
      executeProviderOperationWithRetry({ provider: "test", stage: "create", operation }),
    ).rejects.toThrow("EPIPE");
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
