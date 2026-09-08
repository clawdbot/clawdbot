import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestFeishuApi } from "./comment-shared.js";

function axiosError(code?: number, status = 400) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { code, msg: "feishu error" } },
  });
}

const rateLimits = [
  {
    name: "per-chat rejection",
    fail: () => Promise.reject(axiosError(230020)),
    diagnostic: '"feishu_code":230020',
  },
  {
    name: "tenant rejection",
    fail: () => Promise.reject(axiosError(11232)),
    diagnostic: '"feishu_code":11232',
  },
  {
    name: "gateway rejection",
    fail: () => Promise.reject(axiosError(undefined, 429)),
    diagnostic: '"http_status":429',
  },
  {
    name: "gateway rejection with a non-retryable body",
    fail: () => Promise.reject(axiosError(230001, 429)),
    diagnostic: '"http_status":429',
  },
  {
    name: "fulfilled per-chat rate limit",
    fail: () => Promise.resolve({ code: 230020, msg: "rate limit" }),
    diagnostic: '"feishu_code":230020',
  },
  {
    name: "fulfilled tenant rate limit",
    fail: () => Promise.resolve({ code: 11232, msg: "rate limit" }),
    diagnostic: '"feishu_code":11232',
  },
];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("requestFeishuApi", () => {
  it.each([
    "ok",
    null,
    undefined,
    { code: 0, data: { message_id: "om_first" } },
    { code: 230001, msg: "permission error" },
  ])("returns a non-rate-limited response unchanged: %j", async (response) => {
    const request = vi.fn().mockResolvedValue(response);
    await expect(requestFeishuApi(request, "Feishu send failed")).resolves.toBe(response);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { error: axiosError(230006), diagnostic: "230006" },
    { error: axiosError(230001), diagnostic: "230001" },
    { error: new Error("network failure"), diagnostic: "network failure" },
    { error: null, diagnostic: "Retry failed" },
  ])("does not retry a non-rate-limit rejection: $diagnostic", async ({ error, diagnostic }) => {
    const request = vi.fn().mockRejectedValue(error);
    const result = requestFeishuApi(request, "Feishu send failed");
    await expect(result).rejects.toThrow("Feishu send failed");
    await expect(result).rejects.toThrow(diagnostic);
    expect(request).toHaveBeenCalledTimes(1);
  });

  describe.each(rateLimits)("$name", ({ fail, diagnostic }) => {
    it("retries after the default backoff and returns the successful response", async () => {
      const response = { code: 0, data: { message_id: "om_retry" } };
      const request = vi
        .fn<() => Promise<unknown>>()
        .mockResolvedValue(response)
        .mockImplementationOnce(fail);
      const result = requestFeishuApi(request, "Feishu send failed");

      await vi.advanceTimersByTimeAsync(499);
      expect(request).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe(response);
      expect(request).toHaveBeenCalledTimes(2);
    });

    it("exhausts the retry budget and wraps the terminal error", async () => {
      const request = vi.fn(fail);
      // Fulfilled rate-limit bodies must also reject on exhaustion, never escape as success.
      const result = requestFeishuApi(request, "Feishu send failed").catch(
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(1499);
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      const error = await result;
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty("message", expect.stringContaining("Feishu send failed"));
      expect(error).toHaveProperty("message", expect.stringContaining(diagnostic));
      expect(request).toHaveBeenCalledTimes(3);
    });
  });

  it.each([
    { name: "repeated per-chat failures", second: () => Promise.reject(axiosError(230020)) },
    { name: "different rejected rate limits", second: () => Promise.reject(axiosError(11232)) },
    {
      name: "rejected then fulfilled rate limits",
      second: () => Promise.resolve({ code: 11232, msg: "rate limit" }),
    },
  ])("recovers on the third attempt after $name", async ({ second }) => {
    const response = { code: 0, data: { message_id: "om_recovered" } };
    const request = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(axiosError(230020))
      .mockImplementationOnce(second)
      .mockResolvedValueOnce(response);
    const result = requestFeishuApi(request, "Feishu send failed");

    await vi.runAllTimersAsync();
    await expect(result).resolves.toBe(response);
    expect(request).toHaveBeenCalledTimes(3);
  });
});
