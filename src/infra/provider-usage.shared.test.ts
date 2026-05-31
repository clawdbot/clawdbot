import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_TIMEOUT_MS } from "../shared/number-coercion.js";
import { clampPercent, resolveUsageProviderId, withTimeout } from "./provider-usage.shared.js";

describe("provider-usage.shared", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { value: "zai", expected: "zai" },
    { value: "z-ai", expected: undefined },
    { value: " GOOGLE-GEMINI-CLI ", expected: "google-gemini-cli" },
    { value: "minimax-portal", expected: "minimax" },
    { value: "minimax-cn", expected: "minimax" },
    { value: "minimax-portal-cn", expected: "minimax" },
    { value: " XIAOMI-TOKEN-PLAN ", expected: "xiaomi-token-plan" },
    { value: "unknown-provider", expected: undefined },
    { value: undefined, expected: undefined },
    { value: null, expected: undefined },
  ])("normalizes provider ids for %j", ({ value, expected }) => {
    expect(resolveUsageProviderId(value)).toBe(expected);
  });

  it("maps canonical OpenAI subscription profiles to Codex usage windows", () => {
    expect(resolveUsageProviderId("openai", { credentialType: "oauth" })).toBe("openai");
    expect(resolveUsageProviderId("openai", { credentialType: "token" })).toBe("openai");
    expect(resolveUsageProviderId("openai", { credentialType: "api_key" })).toBeUndefined();
  });

  it.each([
    { value: -5, expected: 0 },
    { value: 42, expected: 42 },
    { value: 120, expected: 100 },
    { value: Number.NaN, expected: 0 },
    { value: Number.POSITIVE_INFINITY, expected: 0 },
  ])("clamps usage percents for %j", ({ value, expected }) => {
    expect(clampPercent(value)).toBe(expected);
  });

  it.each([
    {
      name: "returns work result when it resolves before timeout",
      promise: () => Promise.resolve("ok"),
      expected: "ok",
    },
    {
      name: "propagates work errors before timeout",
      promise: () => Promise.reject(new Error("boom")),
      error: "boom",
    },
  ])("$name", async ({ promise, expected, error }) => {
    if (error) {
      await expect(withTimeout(promise(), 100, "fallback")).rejects.toThrow(error);
      return;
    }
    await expect(withTimeout(promise(), 100, "fallback")).resolves.toBe(expected);
  });

  it("returns fallback when timeout wins", async () => {
    vi.useFakeTimers();
    const late = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 50));
    const result = withTimeout(late, 1, "fallback");
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("fallback");
  });

  it("clamps oversized timeout delays before scheduling", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const result = withTimeout(new Promise<string>(() => {}), Number.MAX_SAFE_INTEGER, "fallback");

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);

    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
    await expect(result).resolves.toBe("fallback");
  });

  it("clears the timeout after successful work", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    await expect(withTimeout(Promise.resolve("ok"), 100, "fallback")).resolves.toBe("ok");

    expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
  });
});
