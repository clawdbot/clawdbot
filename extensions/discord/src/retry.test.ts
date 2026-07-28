// Discord tests cover retry plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { RateLimitError } from "./internal/discord.js";
import { createDiscordRetryRunner } from "./retry.js";

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

describe("createDiscordRetryRunner error classification", () => {
  it.each([
    ["rate limit", createRateLimitError()],
    ["408 status", Object.assign(new Error("request timeout"), { status: 408 })],
    ["502 status", Object.assign(new Error("bad gateway"), { status: 502 })],
    ["503 statusCode", Object.assign(new Error("service unavailable"), { statusCode: 503 })],
    [
      "signed string statusCode",
      Object.assign(new Error("service unavailable"), { statusCode: "+503" }),
    ],
    ["fetch failed", new TypeError("fetch failed")],
    ["ECONNRESET", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
    ["ETIMEDOUT cause", new Error("request failed", { cause: { code: "ETIMEDOUT" } })],
    ["abort", Object.assign(new Error("aborted"), { name: "AbortError" })],
  ])("retries %s", async (_name, err) => {
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");
    const runner = createDiscordRetryRunner({ retry: ZERO_DELAY_RETRY });
    await expect(runner(fn, "request")).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["400 status", Object.assign(new Error("bad request"), { status: 400 })],
    ["fractional status", Object.assign(new Error("upstream rejected request"), { status: 500.5 })],
    ["403 status", Object.assign(new Error("missing permissions"), { statusCode: 403 })],
    ["unknown channel", new Error("Unknown Channel")],
    ["plain string", "fetch failed"],
  ])("does not retry %s", async (_name, err) => {
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");
    const runner = createDiscordRetryRunner({ retry: ZERO_DELAY_RETRY });
    await expect(runner(fn, "request")).rejects.toThrow(err instanceof Error ? err.message : err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["rate limit", createRateLimitError()],
    ["429 status", Object.assign(new Error("rate limited"), { status: 429 })],
    ["ECONNREFUSED", Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" })],
  ])("retries pre-connect %s for nonce-protected creates", async (_name, err) => {
    const fn = vi.fn().mockRejectedValueOnce(err).mockResolvedValue("ok");
    const runner = createDiscordRetryRunner({ retry: ZERO_DELAY_RETRY });
    await expect(runner(fn, "create", { safety: "nonce-protected-create" })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 502 for non-idempotent creates", async () => {
    const error = Object.assign(new Error("bad gateway"), { status: 502 });
    const fn = vi.fn().mockRejectedValueOnce(error).mockResolvedValue("ok");
    const runner = createDiscordRetryRunner({ retry: ZERO_DELAY_RETRY });
    await expect(runner(fn, "create", { safety: "non-idempotent-create" })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("createDiscordRetryRunner create safety", () => {
  it("retries post-connect-ambiguous errors for nonce-protected creates", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
      .mockResolvedValue("ok");
    const runner = createDiscordRetryRunner({ retry: ZERO_DELAY_RETRY });

    await expect(runner(fn, "text", { safety: "nonce-protected-create" })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries pre-connect errors for nonce-protected creates", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }))
      .mockResolvedValue("ok");
    const runner = createDiscordRetryRunner({ retry: ZERO_DELAY_RETRY });

    await expect(runner(fn, "text", { safety: "nonce-protected-create" })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries a 502 for nonce-protected creates", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
      .mockResolvedValue("ok");
    const runner = createDiscordRetryRunner({ retry: ZERO_DELAY_RETRY });

    await expect(runner(fn, "text", { safety: "nonce-protected-create" })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a 502 when the endpoint lacks nonce enforcement", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("bad gateway"), { status: 502 }))
      .mockResolvedValue("ok");
    const runner = createDiscordRetryRunner({ retry: ZERO_DELAY_RETRY });

    await expect(runner(fn, "forum-thread", { safety: "non-idempotent-create" })).rejects.toThrow(
      "bad gateway",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("keeps retrying the broad transient set for default idempotent calls", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
      .mockResolvedValue("ok");
    const runner = createDiscordRetryRunner({ retry: ZERO_DELAY_RETRY });

    await expect(runner(fn, "react")).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
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

  it("adds request retries after observing a gateway disconnect", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue("ok");
    const runner = createDiscordRetryRunner({
      retry: ZERO_DELAY_RETRY,
      isGatewayDisconnected: () => true,
    });

    await expect(runner(fn, "send")).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("remembers a disconnect when the gateway recovers before the baseline attempts end", async () => {
    const isGatewayDisconnected = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValue("ok");
    const runner = createDiscordRetryRunner({
      retry: ZERO_DELAY_RETRY,
      isGatewayDisconnected,
    });

    await expect(runner(fn, "send")).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does not extend retries for unrelated application errors", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("invalid delivery payload"));
    const runner = createDiscordRetryRunner({
      retry: ZERO_DELAY_RETRY,
      isGatewayDisconnected: () => true,
    });

    await expect(runner(fn, "send")).rejects.toThrow("invalid delivery payload");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does not extend HTTP retries beyond the configured attempt count", async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error("bad gateway"), { status: 502 }));
    const runner = createDiscordRetryRunner({
      retry: ZERO_DELAY_RETRY,
      isGatewayDisconnected: () => true,
    });

    await expect(runner(fn, "send")).rejects.toThrow("bad gateway");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("honors an explicit single-attempt policy during disconnects", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const runner = createDiscordRetryRunner({
      retry: { ...ZERO_DELAY_RETRY, attempts: 1 },
      isGatewayDisconnected: () => true,
    });

    await expect(runner(fn, "send")).rejects.toThrow("fetch failed");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
