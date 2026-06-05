// Shared web helper tests cover timeout normalization and process-local cache
// expiry guards.
import {
  MAX_TIMER_TIMEOUT_MS,
  MAX_TIMER_TIMEOUT_SECONDS,
} from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readCache,
  resolvePositiveTimeoutSeconds,
  resolveTimeoutSeconds,
  withTimeout,
  writeCache,
  type CacheEntry,
} from "./web-shared.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("web shared timeout seconds", () => {
  it("caps timeoutSeconds at the shared timer-safe ceiling", () => {
    expect(resolveTimeoutSeconds(Number.MAX_SAFE_INTEGER, 30)).toBe(MAX_TIMER_TIMEOUT_SECONDS);
    expect(resolvePositiveTimeoutSeconds(Number.MAX_SAFE_INTEGER, 30)).toBe(
      MAX_TIMER_TIMEOUT_SECONDS,
    );
  });

  it("preserves fallback and minimum behavior", () => {
    expect(resolveTimeoutSeconds(Number.NaN, 30)).toBe(30);
    expect(resolveTimeoutSeconds(0, 30)).toBe(1);
    expect(resolvePositiveTimeoutSeconds(0, 30)).toBe(30);
    expect(resolvePositiveTimeoutSeconds(1.9, 30)).toBe(1);
  });

  it("drops cached values while the process clock is invalid", () => {
    // Bad system clocks can make cache expiry nonsensical; fail closed instead
    // of serving stale web data indefinitely.
    const cache = new Map<string, CacheEntry<string>>();
    writeCache(cache, "key", "old", 60_000);
    expect(readCache(cache, "key")?.value).toBe("old");

    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    expect(readCache(cache, "key")).toBeNull();

    vi.mocked(Date.now).mockReturnValue(1_000);
    expect(readCache(cache, "key")).toBeNull();
  });

  it("does not write cache values when expiry would exceed the Date range", () => {
    const cache = new Map<string, CacheEntry<string>>();
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);

    writeCache(cache, "key", "value", 60_000);

    expect(cache.size).toBe(0);
    expect(readCache(cache, "key")).toBeNull();
  });

  it("does not evict valid entries when an invalid expiry cannot be cached", () => {
    const cache = new Map<string, CacheEntry<string>>();
    for (let index = 0; index < 100; index += 1) {
      writeCache(cache, `key-${index}`, `value-${index}`, 60_000);
    }
    expect(cache.get("key-0")?.value).toBe("value-0");

    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    writeCache(cache, "invalid", "value", 60_000);

    expect(cache.size).toBe(100);
    expect(cache.get("key-0")?.value).toBe("value-0");
    expect(cache.has("invalid")).toBe(false);
  });
});

describe("web shared withTimeout", () => {
  it("clamps oversized timeoutMs before scheduling", () => {
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockReturnValue(1 as unknown as ReturnType<typeof setTimeout>);
    vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);

    const signal = withTimeout(undefined, Number.MAX_SAFE_INTEGER);
    signal.dispatchEvent(new Event("abort"));

    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
  });
});
