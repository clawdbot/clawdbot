// Qqbot tests cover token plugin behavior.
import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TokenManager } from "./token.js";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

function mockGuardedTokenResponse(body: BodyInit, init?: ResponseInit): ReturnType<typeof vi.fn> {
  const release = vi.fn(async () => {});
  fetchWithSsrFGuardMock.mockResolvedValueOnce({
    response: new Response(body, init),
    release,
  });
  return release;
}

function cancelTrackedResponse(
  text: string,
  init: ResponseInit,
): {
  release: ReturnType<typeof vi.fn>;
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
  const release = vi.fn(async () => {});
  const response = new Response(stream, init);
  fetchWithSsrFGuardMock.mockResolvedValueOnce({ response, release });
  return {
    release,
    response,
    wasCanceled: () => canceled,
  };
}

describe("QQBot token manager", () => {
  beforeEach(() => {
    fetchWithSsrFGuardMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("wraps malformed access token JSON", async () => {
    const release = mockGuardedTokenResponse("{not json", {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(new TokenManager().getAccessToken("app-id", "secret")).rejects.toThrow(
      "QQBot access_token response was malformed JSON",
    );
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
      url: "https://bots.qq.com/app/getAppAccessToken",
      auditContext: "qqbot-token",
      capture: false,
      policy: {
        hostnameAllowlist: ["bots.qq.com"],
        allowRfc2544BenchmarkRange: true,
      },
      timeoutMs: 30_000,
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "QQBotPlugin/unknown",
        },
        body: JSON.stringify({ appId: "app-id", clientSecret: "secret" }),
      },
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("bounds access token responses without using response.text()", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const tracked = cancelTrackedResponse(`${"qqbot token unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));

    await expect(new TokenManager({ logger }).getAccessToken("app-id", "secret")).rejects.toThrow(
      "QQBot access_token response was malformed JSON",
    );

    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
    expect(tracked.release).toHaveBeenCalledTimes(1);
    expect(logger.debug.mock.calls.join("\n")).toContain("qqbot token unavailable");
    expect(logger.debug.mock.calls.join("\n")).not.toContain("tail");
  });

  it("passes the RFC2544 SSRF allowance to the token fetch (regression for #88984)", async () => {
    mockGuardedTokenResponse('{"access_token":"token-1","expires_in":7200}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(new TokenManager().getAccessToken("app-id", "secret")).resolves.toBe("token-1");
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://bots.qq.com/app/getAppAccessToken",
        auditContext: "qqbot-token",
        policy: {
          hostnameAllowlist: ["bots.qq.com"],
          allowRfc2544BenchmarkRange: true,
        },
      }),
    );
  });

  it("does not cache access tokens forever when expires_in is unsafe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));
    mockGuardedTokenResponse('{"access_token":"token-1","expires_in":1e309}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const manager = new TokenManager();
    await expect(manager.getAccessToken("app-id", "secret")).resolves.toBe("token-1");

    const status = manager.getStatus("app-id");
    expect(status.status).toBe("valid");
    expect(status.expiresAt).toBe(Date.now() + 7200 * 1000);
  });

  it("does not extend explicit non-positive token lifetimes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));
    mockGuardedTokenResponse('{"access_token":"token-1","expires_in":0}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const manager = new TokenManager();
    await expect(manager.getAccessToken("app-id", "secret")).resolves.toBe("token-1");

    expect(manager.getStatus("app-id")).toEqual({
      status: "expired",
      expiresAt: Date.now(),
    });
  });

  it("does not cache fetched tokens when the process clock is outside the Date range", async () => {
    const logger = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    const dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_001);
    mockGuardedTokenResponse('{"access_token":"token-1","expires_in":7200}', {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    const manager = new TokenManager({ logger });
    try {
      await expect(manager.getAccessToken("app-id", "secret")).resolves.toBe("token-1");
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(manager.getStatus("app-id")).toEqual({ status: "none", expiresAt: null });
    expect(logger.debug).toHaveBeenCalledWith(
      "[qqbot:token:app-id] Not cached: invalid process clock",
    );
  });

  it("times out one stalled token fetch for every singleflight waiter and allows retry", async () => {
    vi.useFakeTimers();
    const { fetchWithSsrFGuard } = await vi.importActual<
      typeof import("openclaw/plugin-sdk/ssrf-runtime")
    >("openclaw/plugin-sdk/ssrf-runtime");
    fetchWithSsrFGuardMock.mockImplementation(fetchWithSsrFGuard);

    let fetchSignal: AbortSignal | undefined;
    const stalledFetch = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          fetchSignal = init?.signal ?? undefined;
          if (!fetchSignal) {
            reject(new Error("missing guarded fetch signal"));
            return;
          }
          fetchSignal.addEventListener(
            "abort",
            () => {
              const reason = fetchSignal?.reason;
              const error =
                reason instanceof Error ? reason : new Error("request aborted", { cause: reason });
              reject(error);
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", stalledFetch);

    const manager = new TokenManager();
    const first = manager.getAccessToken("app-id", "secret");
    const second = manager.getAccessToken(" app-id ", "secret");
    const outcomes = Promise.allSettled([first, second]);

    await vi.advanceTimersByTimeAsync(0);
    expect(stalledFetch).toHaveBeenCalledTimes(1);
    expect(manager.getStatus("app-id").status).toBe("refreshing");

    await vi.advanceTimersByTimeAsync(30_000);
    const [firstOutcome, secondOutcome] = await outcomes;
    expect(fetchSignal?.aborted).toBe(true);
    expect(firstOutcome.status).toBe("rejected");
    expect(secondOutcome.status).toBe("rejected");
    if (firstOutcome.status !== "rejected" || secondOutcome.status !== "rejected") {
      throw new Error("expected every singleflight waiter to reject");
    }
    const timeoutError = firstOutcome.reason as Error;
    expect(timeoutError).toBe(secondOutcome.reason);
    expect(timeoutError.message).toBe("Network error getting access_token: request timed out");
    expect(timeoutError.cause).toMatchObject({
      name: "TimeoutError",
      message: "request timed out",
    });
    expect(manager.getStatus("app-id")).toEqual({ status: "none", expiresAt: null });

    stalledFetch.mockResolvedValueOnce(
      new Response('{"access_token":"token-2","expires_in":7200}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(manager.getAccessToken("app-id", "secret")).resolves.toBe("token-2");
    expect(stalledFetch).toHaveBeenCalledTimes(2);
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);
  });

  it("yields and does not grow abort listeners across zero-delay refresh sleeps", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-29T12:00:00.000Z"));

    const accessTokenField = ["access", "token"].join("_");
    for (let i = 1; i <= 4; i += 1) {
      const body = JSON.stringify({ [accessTokenField]: `token-${i}`, expires_in: 0 });
      mockGuardedTokenResponse(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const addListenerSpy = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const activeAbortListenerCount = () =>
      [...new Set(addListenerSpy.mock.instances)]
        .filter((signal): signal is AbortSignal => signal instanceof AbortSignal)
        .reduce((count, signal) => count + getEventListeners(signal, "abort").length, 0);

    const manager = new TokenManager();
    try {
      manager.startBackgroundRefresh("app-id", "secret", {
        refreshAheadMs: 0,
        randomOffsetMs: 0,
        minRefreshIntervalMs: 0,
        retryDelayMs: 0,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
      expect(activeAbortListenerCount()).toBe(1);

      for (let cycle = 2; cycle <= 4; cycle += 1) {
        await vi.advanceTimersByTimeAsync(1);
        expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(cycle);
        expect(activeAbortListenerCount()).toBe(1);
      }
    } finally {
      manager.stopBackgroundRefresh("app-id");
      await vi.advanceTimersByTimeAsync(0);
      try {
        expect(activeAbortListenerCount()).toBe(0);
      } finally {
        addListenerSpy.mockRestore();
      }
    }
  });
});
