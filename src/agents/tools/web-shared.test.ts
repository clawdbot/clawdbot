// Shared web helper tests cover timeout normalization, process-local cache
// expiry guards, and bounded response body cleanup.
import {
  MAX_TIMER_TIMEOUT_MS,
  MAX_TIMER_TIMEOUT_SECONDS,
} from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readCache,
  readResponseText,
  resolvePositiveTimeoutSeconds,
  resolveTimeoutSeconds,
  withTimeout,
  writeCache,
  type CacheEntry,
} from "./web-shared.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function responseFromReader(params: {
  chunks: string[];
  cancel: () => Promise<void>;
  releaseLock: () => void;
  readError?: Error;
}): Response {
  const chunks: Array<ReadableStreamReadResult<Uint8Array>> = params.chunks.map((chunk) => ({
    done: false,
    value: new TextEncoder().encode(chunk),
  }));
  if (!params.readError) {
    chunks.push({ done: true, value: undefined });
  }
  const reader = {
    read: async () => {
      const next = chunks.shift();
      if (next) {
        return next;
      }
      if (params.readError) {
        throw params.readError;
      }
      return { done: true, value: undefined };
    },
    cancel: params.cancel,
    releaseLock: params.releaseLock,
  } as ReadableStreamDefaultReader<Uint8Array>;

  return {
    body: { getReader: () => reader },
    headers: new Headers({ "content-type": "text/plain; charset=utf-8" }),
  } as Response;
}

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

describe("readResponseText", () => {
  it("releases bounded response readers after complete reads", async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const response = responseFromReader({
      chunks: ["hello", " world"],
      cancel,
      releaseLock,
    });

    await expect(readResponseText(response, { maxBytes: 64 })).resolves.toEqual({
      text: "hello world",
      truncated: false,
      bytesRead: 11,
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("cancels and releases bounded response readers after truncation", async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const response = responseFromReader({
      chunks: ["hello world"],
      cancel,
      releaseLock,
    });

    await expect(readResponseText(response, { maxBytes: 5 })).resolves.toEqual({
      text: "hello",
      truncated: true,
      bytesRead: 5,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("marks bounded response readers truncated after stream errors", async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const response = responseFromReader({
      chunks: ["partial"],
      cancel,
      releaseLock,
      readError: new Error("stream reset"),
    });

    await expect(readResponseText(response, { maxBytes: 64 })).resolves.toEqual({
      text: "partial",
      truncated: true,
      bytesRead: 7,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("does not mark exact-limit streamed responses as truncated", async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const response = responseFromReader({
      chunks: ["hello"],
      cancel,
      releaseLock,
    });

    await expect(readResponseText(response, { maxBytes: 5 })).resolves.toEqual({
      text: "hello",
      truncated: false,
      bytesRead: 5,
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("does not mark multi-chunk exact-limit streamed responses as truncated", async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const response = responseFromReader({
      chunks: ["hel", "lo"],
      cancel,
      releaseLock,
    });

    await expect(readResponseText(response, { maxBytes: 5 })).resolves.toEqual({
      text: "hello",
      truncated: false,
      bytesRead: 5,
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("marks responses that exceed the limit as truncated after confirming overflow", async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const response = responseFromReader({
      chunks: ["hello", "!"],
      cancel,
      releaseLock,
    });

    await expect(readResponseText(response, { maxBytes: 5 })).resolves.toEqual({
      text: "hello",
      truncated: true,
      bytesRead: 5,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("does not mark exact-limit responses as truncated when followed by zero-byte chunks", async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const response = responseFromReader({
      chunks: ["hello", ""],
      cancel,
      releaseLock,
    });

    await expect(readResponseText(response, { maxBytes: 5 })).resolves.toEqual({
      text: "hello",
      truncated: false,
      bytesRead: 5,
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("keeps exact-limit responses truncated when the confirming read fails", async () => {
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    const response = responseFromReader({
      chunks: ["hello"],
      cancel,
      releaseLock,
      readError: new Error("stream failed before EOF"),
    });

    await expect(readResponseText(response, { maxBytes: 5 })).resolves.toEqual({
      text: "hello",
      truncated: true,
      bytesRead: 5,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it("does not invoke whole-body fallbacks when maxBytes is set", async () => {
    const arrayBuffer = vi.fn(async () => new TextEncoder().encode("hello").buffer);
    const text = vi.fn(async () => "hello");
    const response = {
      arrayBuffer,
      headers: new Headers(),
      text,
    } as unknown as Response;

    await expect(readResponseText(response, { maxBytes: 4 })).resolves.toEqual({
      text: "",
      truncated: true,
      bytesRead: 0,
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("treats a native bodyless response as empty when maxBytes is set", async () => {
    await expect(
      readResponseText(new Response(null, { status: 204 }), { maxBytes: 4 }),
    ).resolves.toEqual({
      text: "",
      truncated: false,
      bytesRead: 0,
    });
  });

  it("preserves uncapped text-only fallback byte accounting", async () => {
    const value = "中文🔥";
    const text = vi.fn(async () => value);
    const response = {
      headers: new Headers(),
      text,
    } as unknown as Response;

    await expect(readResponseText(response)).resolves.toEqual({
      text: value,
      truncated: false,
      bytesRead: new TextEncoder().encode(value).byteLength,
    });
    expect(text).toHaveBeenCalledTimes(1);
  });
});
