// Minimax tests cover oauth plugin behavior.
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginMiniMaxPortalOAuth } from "./oauth.js";

const MINIMAX_OAUTH_FETCH_TIMEOUT_MS = 30_000;

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

function timeoutResult<T>(value: T, timeoutMs: number): Promise<T> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(value), timeoutMs);
  });
}

function captureMiniMaxOAuthFetchTimeout() {
  const originalSetTimeout = globalThis.setTimeout;
  let fireTimeout: (() => void) | undefined;
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    timeout?: number,
    ...args: unknown[]
  ) => {
    if (timeout === MINIMAX_OAUTH_FETCH_TIMEOUT_MS) {
      fireTimeout = () => callback(...args);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }
    return originalSetTimeout(() => callback(...args), timeout);
  }) as typeof setTimeout);
  return {
    setTimeoutSpy,
    fire() {
      if (!fireTimeout) {
        throw new Error("expected MiniMax OAuth fetch timeout to be scheduled");
      }
      const callback = fireTimeout;
      fireTimeout = undefined;
      callback();
    },
  };
}

async function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<number> {
  return await new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function startHangingLoopbackServer(): Promise<{
  origin: string;
  requests: string[];
  waitForRequestCount: (count: number) => Promise<void>;
  close: () => Promise<void>;
}> {
  type RequestWaiter = {
    count: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  };

  const sockets = new Set<Socket>();
  const requests: string[] = [];
  const waiters: RequestWaiter[] = [];

  const resolveWaiters = () => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter || requests.length < waiter.count) {
        continue;
      }
      waiters.splice(index, 1);
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve();
    }
  };

  const server = createServer((req, _res) => {
    requests.push(req.url ?? "");
    req.resume();
    resolveWaiters();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const port = await listenOnLoopback(server);
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    waitForRequestCount: async (count: number) => {
      if (requests.length >= count) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const waiter: RequestWaiter = {
          count,
          resolve,
          reject,
        };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) {
            waiters.splice(index, 1);
          }
          reject(new Error(`server received ${requests.length} request(s), expected ${count}`));
        }, 2_000);
        waiters.push(waiter);
      });
    },
    close: async () => {
      for (const waiter of waiters.splice(0)) {
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        waiter.reject(new Error("server closed"));
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function expectFetchWithoutDeadlineToStayPending(params: {
  url: string;
  init?: RequestInit;
  waitForRequest: () => Promise<void>;
}) {
  const controller = new AbortController();
  const request = fetch(params.url, { ...params.init, signal: controller.signal });
  request.catch(() => undefined);
  await params.waitForRequest();

  const result = await Promise.race([
    request.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    timeoutResult("pending" as const, 30),
  ]);

  controller.abort();
  await request.catch(() => undefined);
  expect(result).toBe("pending");
}

async function loginOutcomeWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<
  | { status: "pending" }
  | { status: "resolved" }
  | {
      status: "rejected";
      error: unknown;
    }
> {
  return await Promise.race([
    promise.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    timeoutResult({ status: "pending" as const }, timeoutMs),
  ]);
}

function expectAbortOrTimeoutError(error: unknown) {
  expect(error).toHaveProperty("name", expect.stringMatching(/^(AbortError|TimeoutError)$/));
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("loginMiniMaxPortalOAuth", () => {
  it.each([
    [3600, 1_700_003_600_000],
    [1_700_000_000, 1_700_000_000_000],
    [1_700_000_000_000, 1_700_000_000_000],
  ])("normalizes token expiry %s through the OAuth flow", async (expiredIn, expectedExpires) => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        callCount += 1;
        const body =
          init?.body instanceof URLSearchParams
            ? init.body
            : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        return new Response(
          JSON.stringify(
            callCount === 1
              ? {
                  user_code: "CODE",
                  verification_uri: "https://example.com/device",
                  expired_in: Date.now() + 10_000,
                  state: body.get("state"),
                }
              : {
                  status: "success",
                  access_token: "access",
                  refresh_token: "refresh",
                  expired_in: expiredIn,
                },
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await expect(
      loginMiniMaxPortalOAuth({
        openUrl: vi.fn(async () => undefined),
        note: vi.fn(async () => undefined),
        progress: { update: vi.fn(), stop: vi.fn() },
      }),
    ).resolves.toMatchObject({ expires: expectedExpires });
  });

  it("rejects malformed token expiry through the OAuth flow", async () => {
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        callCount += 1;
        const body =
          init?.body instanceof URLSearchParams
            ? init.body
            : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        return new Response(
          JSON.stringify(
            callCount === 1
              ? {
                  user_code: "CODE",
                  verification_uri: "https://example.com/device",
                  expired_in: Date.now() + 10_000,
                  state: body.get("state"),
                }
              : {
                  status: "success",
                  access_token: "access",
                  refresh_token: "refresh",
                  expired_in: "3600s",
                },
          ),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    await expect(
      loginMiniMaxPortalOAuth({
        openUrl: vi.fn(async () => undefined),
        note: vi.fn(async () => undefined),
        progress: { update: vi.fn(), stop: vi.fn() },
      }),
    ).rejects.toThrow("invalid token expiry");
  });

  it("times out authorization code HTTP requests against a hanging loopback server", async () => {
    const realFetch = fetch;
    const server = await startHangingLoopbackServer();
    const oauthTimeout = captureMiniMaxOAuthFetchTimeout();
    let loginPromise: Promise<unknown> | undefined;

    try {
      await expectFetchWithoutDeadlineToStayPending({
        url: `${server.origin}/control`,
        init: { method: "POST", body: "response_type=code" },
        waitForRequest: () => server.waitForRequestCount(1),
      });

      const fetchMock = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) =>
          await realFetch(`${server.origin}/device-code`, init),
      );
      vi.stubGlobal("fetch", fetchMock);

      loginPromise = loginMiniMaxPortalOAuth({
        openUrl: vi.fn(async () => undefined),
        note: vi.fn(async () => undefined),
        progress: { update: vi.fn(), stop: vi.fn() },
      });
      loginPromise.catch(() => undefined);

      await server.waitForRequestCount(2);
      oauthTimeout.fire();
      const result = await loginOutcomeWithin(loginPromise, 2_000);
      if (result.status !== "rejected") {
        throw new Error(`expected authorization code request to reject, got ${result.status}`);
      }
      expectAbortOrTimeoutError(result.error);
      expect(server.requests).toContain("/device-code");
      expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(
        oauthTimeout.setTimeoutSpy.mock.calls.some(
          ([, timeout]) => timeout === MINIMAX_OAUTH_FETCH_TIMEOUT_MS,
        ),
      ).toBe(true);
    } finally {
      await server.close();
      await loginPromise?.catch(() => undefined);
    }
  });

  it("times out token polling HTTP requests against a hanging loopback server", async () => {
    const realFetch = fetch;
    const server = await startHangingLoopbackServer();
    const oauthTimeout = captureMiniMaxOAuthFetchTimeout();
    let loginPromise: Promise<unknown> | undefined;

    try {
      await expectFetchWithoutDeadlineToStayPending({
        url: `${server.origin}/control`,
        init: { method: "POST", body: "grant_type=user_code" },
        waitForRequest: () => server.waitForRequestCount(1),
      });

      let callCount = 0;
      const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        callCount += 1;
        const body =
          init?.body instanceof URLSearchParams
            ? init.body
            : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        if (callCount === 1) {
          return new Response(
            JSON.stringify({
              user_code: "CODE",
              verification_uri: "https://example.com/device",
              expired_in: Date.now() + 10_000,
              state: body.get("state"),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return await realFetch(`${server.origin}/token`, init);
      });
      vi.stubGlobal("fetch", fetchMock);

      loginPromise = loginMiniMaxPortalOAuth({
        openUrl: vi.fn(async () => undefined),
        note: vi.fn(async () => undefined),
        progress: { update: vi.fn(), stop: vi.fn() },
      });
      loginPromise.catch(() => undefined);

      await server.waitForRequestCount(2);
      oauthTimeout.fire();
      const result = await loginOutcomeWithin(loginPromise, 2_000);
      if (result.status !== "rejected") {
        throw new Error(`expected token polling request to reject, got ${result.status}`);
      }
      expectAbortOrTimeoutError(result.error);
      expect(server.requests).toContain("/token");
      expect(fetchMock.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
      expect(
        oauthTimeout.setTimeoutSpy.mock.calls.some(
          ([, timeout]) => timeout === MINIMAX_OAUTH_FETCH_TIMEOUT_MS,
        ),
      ).toBe(true);
    } finally {
      await server.close();
      await loginPromise?.catch(() => undefined);
    }
  });

  it("bounds authorization error bodies without using response.text()", async () => {
    const tracked = cancelTrackedResponse(
      `${"minimax authorization unavailable ".repeat(1024)}tail`,
      {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      },
    );
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => tracked.response),
    );

    const error = await loginMiniMaxPortalOAuth({
      openUrl: vi.fn(async () => undefined),
      note: vi.fn(async () => undefined),
      progress: { update: vi.fn(), stop: vi.fn() },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(
      /MiniMax OAuth authorization failed: minimax authorization unavailable/,
    );
    expect((error as Error).message).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("bounds token error bodies without using response.text()", async () => {
    const tracked = cancelTrackedResponse(`${"minimax token unavailable ".repeat(1024)}tail`, {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      const body =
        init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            user_code: "CODE",
            verification_uri: "https://example.com/device",
            expired_in: Date.now() + 10_000,
            state: body.get("state"),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return tracked.response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await loginMiniMaxPortalOAuth({
      openUrl: vi.fn(async () => undefined),
      note: vi.fn(async () => undefined),
      progress: { update: vi.fn(), stop: vi.fn() },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("minimax token unavailable");
    expect((error as Error).message).not.toContain("tail");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("bounds HTTP 200 token bodies before app-level parsing", async () => {
    const tracked = cancelTrackedResponse(`${'{"status":"error","detail":"'.repeat(512)}tail`, {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      const body =
        init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            user_code: "CODE",
            verification_uri: "https://example.com/device",
            expired_in: Date.now() + 10_000,
            state: body.get("state"),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return tracked.response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const error = await loginMiniMaxPortalOAuth({
      openUrl: vi.fn(async () => undefined),
      note: vi.fn(async () => undefined),
      progress: { update: vi.fn(), stop: vi.fn() },
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("MiniMax OAuth failed to parse response.");
    expect(tracked.wasCanceled()).toBe(true);
    expect(textSpy).not.toHaveBeenCalled();
  });

  it("uses MiniMax account OAuth endpoints directly for global and CN login", async () => {
    for (const [region, expectedHosts] of [
      [
        "global",
        [
          "https://account.minimax.io/oauth2/device/code",
          "https://account.minimax.io/oauth2/token",
        ],
      ],
      [
        "cn",
        [
          "https://account.minimaxi.com/oauth2/device/code",
          "https://account.minimaxi.com/oauth2/token",
        ],
      ],
    ] as const) {
      const requestedUrls: string[] = [];
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requestedUrls.push(input instanceof Request ? input.url : String(input));
        const body =
          init?.body instanceof URLSearchParams
            ? init.body
            : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
        if (requestedUrls.length === 1) {
          return new Response(
            JSON.stringify({
              user_code: "CODE",
              verification_uri: "https://example.com/device",
              expired_in: Date.now() + 10_000,
              state: body.get("state"),
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            status: "success",
            access_token: "access",
            refresh_token: "refresh",
            expired_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        loginMiniMaxPortalOAuth({
          region,
          openUrl: vi.fn(async () => undefined),
          note: vi.fn(async () => undefined),
          progress: { update: vi.fn(), stop: vi.fn() },
        }),
      ).resolves.toMatchObject({ access: "access", refresh: "refresh" });
      expect(requestedUrls).toEqual(expectedHosts);

      vi.unstubAllGlobals();
    }
  });

  it("rejects Date-invalid authorization expiries before formatting instructions", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body =
        init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      return new Response(
        JSON.stringify({
          user_code: "CODE",
          verification_uri: "https://example.com/device",
          expired_in: 8_700_000_000_000_000,
          state: body.get("state"),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const note = vi.fn(async () => undefined);

    await expect(
      loginMiniMaxPortalOAuth({
        openUrl: vi.fn(async () => undefined),
        note,
        progress: { update: vi.fn(), stop: vi.fn() },
      }),
    ).rejects.toThrow("invalid expired_in");
    expect(note).not.toHaveBeenCalled();
  });

  it("caps oversized authorization poll intervals before scheduling", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      const body =
        init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            user_code: "CODE",
            verification_uri: "https://example.com/device",
            expired_in: Date.now() + MAX_TIMER_TIMEOUT_MS + 10_000,
            interval: Number.MAX_SAFE_INTEGER,
            state: body.get("state"),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify(
          callCount === 2
            ? { status: "pending" }
            : {
                status: "success",
                access_token: "access",
                refresh_token: "refresh",
                expired_in: 3600,
              },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = loginMiniMaxPortalOAuth({
      openUrl: vi.fn(async () => undefined),
      note: vi.fn(async () => undefined),
      progress: { update: vi.fn(), stop: vi.fn() },
    });

    await vi.waitFor(() => {
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    });

    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
    await expect(result).resolves.toMatchObject({ access: "access", refresh: "refresh" });
  });

  it("does not sleep past the authorization expiry deadline", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      const body =
        init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            user_code: "CODE",
            verification_uri: "https://example.com/device",
            expired_in: Date.now() + 10_000,
            interval: Number.MAX_SAFE_INTEGER,
            state: body.get("state"),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ status: "pending" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = loginMiniMaxPortalOAuth({
      openUrl: vi.fn(async () => undefined),
      note: vi.fn(async () => undefined),
      progress: { update: vi.fn(), stop: vi.fn() },
    });

    await vi.waitFor(() => {
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10_000);
    });

    const rejection = expect(result).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
  });

  it("keeps the default poll delay for zero authorization intervals", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    let callCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      callCount += 1;
      const body =
        init?.body instanceof URLSearchParams
          ? init.body
          : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            user_code: "CODE",
            verification_uri: "https://example.com/device",
            expired_in: Date.now() + 10_000,
            interval: 0,
            state: body.get("state"),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify(
          callCount === 2
            ? { status: "pending" }
            : {
                status: "success",
                access_token: "access",
                refresh_token: "refresh",
                expired_in: 3600,
              },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = loginMiniMaxPortalOAuth({
      openUrl: vi.fn(async () => undefined),
      note: vi.fn(async () => undefined),
      progress: { update: vi.fn(), stop: vi.fn() },
    });

    await vi.waitFor(() => {
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2_000);
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toMatchObject({ access: "access", refresh: "refresh" });
  });
});
