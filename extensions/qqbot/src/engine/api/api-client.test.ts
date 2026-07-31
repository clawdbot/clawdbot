import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
// Qqbot tests cover api-client plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStreamingResponse } from "../../../../test-support/streaming-error-response.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());
const ssrfRuntimeActual = vi.hoisted(() => ({
  fetchWithSsrFGuard: undefined as
    | typeof import("openclaw/plugin-sdk/ssrf-runtime").fetchWithSsrFGuard
    | undefined,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  ssrfRuntimeActual.fetchWithSsrFGuard = actual.fetchWithSsrFGuard;
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

import { ApiError } from "../types.js";
import { ApiClient } from "./api-client.js";

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  response: Response;
  wasCanceled: () => boolean;
} {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    response: new Response(stream, init),
    wasCanceled: () => canceled,
  };
}

describe("ApiClient", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fetchWithSsrFGuardMock.mockReset();
  });

  it("bounds error bodies on a UTF-16 boundary without using response.text()", async () => {
    const release = vi.fn(async () => {});
    const safePrefix = "x".repeat(199);
    const tracked = cancelTrackedResponse(`${safePrefix}🎉${"tail".repeat(4096)}`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: tracked.response,
      release,
    });

    const client = new ApiClient({ baseUrl: "https://qqbot.test" });

    let error: unknown;
    try {
      await client.request("token-1", "GET", "/v2/users/@me");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect((error as Error).message).toBe(`API Error [/v2/users/@me] HTTP 503: ${safePrefix}`);
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://qqbot.test/v2/users/@me",
      init: {
        method: "GET",
        headers: {
          Authorization: "QQBot token-1",
          "Content-Type": "application/json",
          "User-Agent": "QQBotPlugin/unknown",
        },
      },
      auditContext: "qqbot-api",
      policy: {
        hostnameAllowlist: ["qqbot.test"],
        allowRfc2544BenchmarkRange: true,
      },
      timeoutMs: 30_000,
    });
  });

  it("bounds successful response bodies without using response.text()", async () => {
    const release = vi.fn(async () => {});
    const streamed = createStreamingResponse({
      chunkCount: 32,
      chunkSize: 1024 * 1024,
      text: "x",
      headers: { "content-type": "application/json" },
    });
    const textSpy = vi.spyOn(streamed.response, "text").mockRejectedValue(new Error("unbounded"));
    fetchWithSsrFGuardMock.mockResolvedValueOnce({
      response: streamed.response,
      release,
    });

    const client = new ApiClient({ baseUrl: "https://qqbot.test" });

    let error: unknown;
    try {
      await client.request("token-1", "GET", "/v2/users/@me");
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ApiError);
    expect(String(error)).toContain("QQBot API response: text response exceeds 16777216 bytes");
    expect(streamed.getReadCount()).toBeLessThan(32);
    expect(streamed.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([0, 25])(
    "keeps the %dms request deadline active while reading a hanging response body",
    async (timeoutMs) => {
      vi.useFakeTimers();
      const actualGuard = ssrfRuntimeActual.fetchWithSsrFGuard;
      if (!actualGuard) {
        throw new Error("expected the real SSRF guard implementation");
      }
      let requestSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const signal = init?.signal;
        if (!(signal instanceof AbortSignal)) {
          throw new Error("expected the guarded fetch to pass its deadline signal");
        }
        requestSignal = signal;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener("abort", () => controller.error(signal.reason), {
                once: true,
              });
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
      const lookupFn = vi.fn(async () => [
        { address: "93.184.216.34", family: 4 },
      ]) as unknown as LookupFn;
      fetchWithSsrFGuardMock.mockImplementationOnce(
        async (request: Parameters<typeof actualGuard>[0]) =>
          await actualGuard({ ...request, fetchImpl, lookupFn }),
      );

      const client = new ApiClient({
        baseUrl: "https://qqbot.test",
        defaultTimeoutMs: timeoutMs,
      });

      const rejection = expect(client.request("token-1", "GET", "/v2/users/@me")).rejects.toThrow(
        `Request timeout [/v2/users/@me]: exceeded ${timeoutMs}ms`,
      );
      const guardedTimeoutMs = Math.max(1, timeoutMs);
      await vi.advanceTimersByTimeAsync(guardedTimeoutMs);

      await rejection;
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({ timeoutMs: guardedTimeoutMs }),
      );
      expect(requestSignal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
