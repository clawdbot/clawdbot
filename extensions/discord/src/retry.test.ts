import { describe, expect, it, vi } from "vitest";
import { isRetryableDiscordDeliveryError } from "./delivery-retry.js";
import { DiscordError, RateLimitError } from "./internal/discord.js";
import { createDiscordRetryRunner, isRetryableDiscordTransientError } from "./retry.js";

const ZERO_DELAY_RETRY = { attempts: 2, minDelayMs: 0, maxDelayMs: 0, jitter: 0 };

function createRateLimitError(retryAfter = 0): RateLimitError {
  const response = new Response(null, {
    status: 429,
    headers: {
      "X-RateLimit-Scope": "user",
      "X-RateLimit-Bucket": "bucket-1",
    },
  });
  const RateLimitErrorCtor = RateLimitError as unknown as new (
    response: Response,
    body: { message: string; retry_after: number; global: boolean },
  ) => RateLimitError;
  return new RateLimitErrorCtor(response, {
    message: "rate limited",
    retry_after: retryAfter,
    global: false,
  });
}

describe("isRetryableDiscordTransientError", () => {
  it.each([
    ["rate limit", createRateLimitError()],
    ["408 status", Object.assign(new Error("request timeout"), { status: 408 })],
    ["502 status", Object.assign(new Error("bad gateway"), { status: 502 })],
    ["503 statusCode", Object.assign(new Error("service unavailable"), { statusCode: 503 })],
    ["fetch failed", new TypeError("fetch failed")],
    ["ECONNRESET", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
    ["ETIMEDOUT cause", new Error("request failed", { cause: { code: "ETIMEDOUT" } })],
    ["abort", Object.assign(new Error("aborted"), { name: "AbortError" })],
  ])("retries %s", (_name, err) => {
    expect(isRetryableDiscordTransientError(err)).toBe(true);
  });

  it.each([
    ["400 status", Object.assign(new Error("bad request"), { status: 400 })],
    ["403 status", Object.assign(new Error("missing permissions"), { statusCode: 403 })],
    ["unknown channel", new Error("Unknown Channel")],
    ["plain string", "fetch failed"],
  ])("does not retry %s", (_name, err) => {
    expect(isRetryableDiscordTransientError(err)).toBe(false);
  });
});

describe("createDiscordRetryRunner", () => {
  it("retries transient transport errors", async () => {
    const fn = vi.fn().mockRejectedValueOnce(new TypeError("fetch failed")).mockResolvedValue("ok");
    const runner = createDiscordRetryRunner({ retry: ZERO_DELAY_RETRY });

    await expect(runner(fn, "send")).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("stops after configured transient retry attempts", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const runner = createDiscordRetryRunner({ retry: ZERO_DELAY_RETRY });

    await expect(runner(fn, "send")).rejects.toThrow("fetch failed");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("isRetryableDiscordDeliveryError", () => {
  it("retries status-coded errors from injected delivery dependencies", () => {
    expect(
      isRetryableDiscordDeliveryError(Object.assign(new Error("bad gateway"), { status: 502 })),
    ).toBe(true);
  });

  it("does not retry Discord client errors after the request runner handled them", () => {
    const err = new DiscordError(new Response("upstream", { status: 502 }), {
      message: "Bad Gateway",
    });

    expect(isRetryableDiscordDeliveryError(err)).toBe(false);
  });
});
