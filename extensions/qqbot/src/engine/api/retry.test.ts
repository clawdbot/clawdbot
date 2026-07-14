import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineLogger } from "../types.js";
import { withRetry } from "./retry.js";

const mocks = vi.hoisted(() => ({
  sleep: vi.fn(async () => {}),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({ sleep: mocks.sleep }));

function createLogger(): EngineLogger {
  return {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

beforeEach(() => {
  mocks.sleep.mockClear();
});

describe("withRetry", () => {
  it("uses the shared runner without changing exponential schedules", async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("first"))
      .mockRejectedValueOnce(new Error("second"))
      .mockResolvedValueOnce("ok");

    await expect(
      withRetry(
        operation,
        { maxRetries: 2, baseDelayMs: 100, backoff: "exponential" },
        undefined,
        createLogger(),
      ),
    ).resolves.toBe("ok");
    expect(mocks.sleep).toHaveBeenNthCalledWith(1, 100);
    expect(mocks.sleep).toHaveBeenNthCalledWith(2, 200);
  });

  it("preserves the policy's zero-based attempt index", async () => {
    const shouldRetry = vi.fn(() => false);
    await expect(
      withRetry(
        async () => {
          throw new Error("stop");
        },
        {
          maxRetries: 2,
          baseDelayMs: 100,
          backoff: "fixed",
          shouldRetry,
        },
      ),
    ).rejects.toThrow("stop");
    expect(shouldRetry).toHaveBeenCalledWith(expect.any(Error), 0);
    expect(mocks.sleep).not.toHaveBeenCalled();
  });

  it("does not restart a persistent loop after its terminal failure", async () => {
    const persistentTrigger = Object.assign(new Error("processing"), { bizCode: 42 });
    const terminal = new Error("permission denied");
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(persistentTrigger)
      .mockRejectedValueOnce(terminal);

    await expect(
      withRetry(
        operation,
        { maxRetries: 2, baseDelayMs: 100, backoff: "fixed" },
        {
          timeoutMs: 1_000,
          intervalMs: 10,
          shouldPersistRetry: (error) =>
            "bizCode" in error && (error as { bizCode?: number }).bizCode === 42,
        },
      ),
    ).rejects.toBe(terminal);
    expect(operation).toHaveBeenCalledTimes(2);
    expect(mocks.sleep).not.toHaveBeenCalled();
  });
});
