import { describe, expect, it, vi } from "vitest";
import type { TransientProviderRetryParams } from "../provider-runtime/operation-retry.js";
import { executeWithApiKeyRotation } from "./api-key-rotation.js";

function abortError(message: string): Error {
  return Object.assign(new Error(message), { name: "AbortError" });
}

function timeoutError(message: string): Error {
  return Object.assign(new Error(message), { name: "TimeoutError" });
}

describe("executeWithApiKeyRotation", () => {
  it("keeps transient retry disabled by default for single-key 500", async () => {
    const execute = vi.fn(async () => {
      throw new Error("Audio transcription failed (HTTP 500)");
    });

    await expect(
      executeWithApiKeyRotation({
        provider: "openai",
        apiKeys: ["key-1"],
        execute,
      }),
    ).rejects.toThrow("Audio transcription failed (HTTP 500)");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith("key-1");
  });

  it("retries the same key once for transient 500 when attempts is 2", async () => {
    const sleep = vi.fn(async () => undefined);
    const execute = vi
      .fn<(apiKey: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("Audio transcription failed (HTTP 500)"))
      .mockResolvedValueOnce("ok");

    await expect(
      executeWithApiKeyRotation({
        provider: "openai",
        apiKeys: ["key-1"],
        transientRetry: { attempts: 2, baseDelayMs: 25, maxDelayMs: 25, sleep },
        execute,
      }),
    ).resolves.toBe("ok");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, "key-1");
    expect(execute).toHaveBeenNthCalledWith(2, "key-1");
    expect(sleep).toHaveBeenCalledWith(25, undefined);
  });

  it("uses the shared default transient retry policy when enabled with true", async () => {
    vi.useFakeTimers();
    const execute = vi
      .fn<(apiKey: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("Audio transcription failed (HTTP 500)"))
      .mockResolvedValueOnce("ok");

    try {
      const result = executeWithApiKeyRotation({
        provider: "openai",
        apiKeys: ["key-1"],
        transientRetry: true,
        execute,
      });
      await vi.advanceTimersByTimeAsync(250);
      await expect(result).resolves.toBe("ok");
    } finally {
      vi.useRealTimers();
    }

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it.each([502, 503, 504])("retries the same key for transient HTTP %i", async (status) => {
    const sleep = vi.fn(async () => undefined);
    const execute = vi
      .fn<(apiKey: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error(`gemini embeddings failed (${status})`))
      .mockResolvedValueOnce("ok");

    await expect(
      executeWithApiKeyRotation({
        provider: "google",
        apiKeys: ["key-1"],
        transientRetry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
        execute,
      }),
    ).resolves.toBe("ok");

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("retries selected transient network errors", async () => {
    const sleep = vi.fn(async () => undefined);
    const cause = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    const execute = vi
      .fn<(apiKey: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("fetch failed", { cause }))
      .mockResolvedValueOnce("ok");

    await expect(
      executeWithApiKeyRotation({
        provider: "deepgram",
        apiKeys: ["key-1"],
        transientRetry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
        execute,
      }),
    ).resolves.toBe("ok");

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("retries selected transient network errors with top-level codes", async () => {
    const sleep = vi.fn(async () => undefined);
    const execute = vi
      .fn<(apiKey: string) => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce("ok");

    await expect(
      executeWithApiKeyRotation({
        provider: "deepgram",
        apiKeys: ["key-1"],
        transientRetry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
        execute,
      }),
    ).resolves.toBe("ok");

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not retry caller-aborted AbortError", async () => {
    const controller = new AbortController();
    controller.abort(new Error("user cancelled"));
    const sleep = vi.fn(async () => undefined);
    const execute = vi.fn(async () => {
      throw abortError("user cancelled");
    });

    await expect(
      executeWithApiKeyRotation({
        provider: "openai",
        apiKeys: ["key-1"],
        transientRetry: {
          attempts: 2,
          baseDelayMs: 0,
          maxDelayMs: 0,
          signal: controller.signal,
          sleep,
        },
        execute,
      }),
    ).rejects.toThrow("user cancelled");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries timeout-like AbortError when the caller signal is not aborted", async () => {
    const sleep = vi.fn(async () => undefined);
    const execute = vi
      .fn<(apiKey: string) => Promise<string>>()
      .mockRejectedValueOnce(abortError("request timeout"))
      .mockResolvedValueOnce("ok");

    await expect(
      executeWithApiKeyRotation({
        provider: "openai",
        apiKeys: ["key-1"],
        transientRetry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
        execute,
      }),
    ).resolves.toBe("ok");

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("retries timeout-named provider errors", async () => {
    const sleep = vi.fn(async () => undefined);
    const execute = vi
      .fn<(apiKey: string) => Promise<string>>()
      .mockRejectedValueOnce(timeoutError("The operation was aborted due to timeout"))
      .mockResolvedValueOnce("ok");

    await expect(
      executeWithApiKeyRotation({
        provider: "openai",
        apiKeys: ["key-1"],
        transientRetry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
        execute,
      }),
    ).resolves.toBe("ok");

    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not retry generic AbortError without timeout evidence", async () => {
    const sleep = vi.fn(async () => undefined);
    const execute = vi
      .fn<(apiKey: string) => Promise<string>>()
      .mockRejectedValueOnce(abortError("This operation was aborted"))
      .mockResolvedValueOnce("ok");

    await expect(
      executeWithApiKeyRotation({
        provider: "openai",
        apiKeys: ["key-1"],
        transientRetry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
        execute,
      }),
    ).rejects.toThrow("This operation was aborted");

    expect(execute).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 404])("does not retry HTTP %i", async (status) => {
    const sleep = vi.fn(async () => undefined);
    const execute = vi.fn(async () => {
      throw new Error(`provider request failed (HTTP ${status})`);
    });

    await expect(
      executeWithApiKeyRotation({
        provider: "openai",
        apiKeys: ["key-1"],
        transientRetry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
        execute,
      }),
    ).rejects.toThrow(`provider request failed (HTTP ${status})`);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rotates keys for 429 without same-key transient retry", async () => {
    const sleep = vi.fn(async () => undefined);
    const execute = vi.fn(async (apiKey: string) => {
      if (apiKey === "key-1") {
        throw new Error("HTTP 429 too many requests");
      }
      return "ok";
    });

    await expect(
      executeWithApiKeyRotation({
        provider: "openai",
        apiKeys: ["key-1", "key-2"],
        transientRetry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
        execute,
      }),
    ).resolves.toBe("ok");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, "key-1");
    expect(execute).toHaveBeenNthCalledWith(2, "key-2");
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not rotate keys for transient 500 after same-key retry exhaustion", async () => {
    const sleep = vi.fn(async () => undefined);
    const execute = vi.fn(async () => {
      throw new Error("Audio transcription failed (HTTP 500)");
    });

    await expect(
      executeWithApiKeyRotation({
        provider: "openai",
        apiKeys: ["key-1", "key-2"],
        transientRetry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, sleep },
        execute,
      }),
    ).rejects.toThrow("Audio transcription failed (HTTP 500)");

    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenNthCalledWith(1, "key-1");
    expect(execute).toHaveBeenNthCalledWith(2, "key-1");
  });

  it("does not expose apiKey to the transient retry classifier", async () => {
    const sleep = vi.fn(async () => undefined);
    const shouldRetry = vi.fn((_params: TransientProviderRetryParams) => true);
    const execute = vi
      .fn<(apiKey: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error("Audio transcription failed (HTTP 500)"))
      .mockResolvedValueOnce("ok");

    await expect(
      executeWithApiKeyRotation({
        provider: "openai",
        apiKeys: ["secret-key-1"],
        transientRetry: { attempts: 2, baseDelayMs: 0, maxDelayMs: 0, shouldRetry, sleep },
        execute,
      }),
    ).resolves.toBe("ok");

    expect(shouldRetry).toHaveBeenCalledWith(
      expect.not.objectContaining({ apiKey: expect.anything() }),
    );
    expect(shouldRetry.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        provider: "openai",
        apiKeyIndex: 0,
        attemptNumber: 1,
      }),
    );
  });
});
