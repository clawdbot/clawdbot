// Minimax tests cover oauth plugin behavior.
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
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
    // Body readers share this duration and need a refreshable timer handle.
    const timer = originalSetTimeout(() => callback(...args), timeout);
    if (timeout === MINIMAX_OAUTH_FETCH_TIMEOUT_MS) {
      fireTimeout = () => {
        clearTimeout(timer);
        callback(...args);
      };
    }
    return timer;
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

async function loginOutcomeWithin(promise: Promise<unknown>, timeoutMs: number) {
  return await withTimeout(
    promise.then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    ),
    timeoutMs,
    { message: "MiniMax OAuth did not settle within the test deadline" },
  );
}

function expectAbortOrTimeoutError(error: unknown) {
  expect(error).toHaveProperty("name", expect.stringMatching(/^(AbortError|TimeoutError)$/));
}

type FetchResponder =
  | Response
  | ((input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function formBody(init?: RequestInit): URLSearchParams {
  return init?.body instanceof URLSearchParams
    ? init.body
    : new URLSearchParams(typeof init?.body === "string" ? init.body : "");
}

function authorizationResponse(
  init?: RequestInit,
  overrides: Record<string, unknown> = {},
): Response {
  return jsonResponse({
    user_code: "CODE",
    verification_uri: "https://example.com/device",
    expired_in: Date.now() + 10_000,
    state: formBody(init).get("state"),
    ...overrides,
  });
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    status: "success",
    access_token: "access",
    refresh_token: "refresh",
    expired_in: 3600,
    ...overrides,
  });
}

function stubOAuthFetch(...responders: FetchResponder[]) {
  let responseIndex = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const responder = responders[responseIndex++];
    if (!responder) {
      throw new Error(`unexpected MiniMax OAuth fetch #${responseIndex}`);
    }
    return typeof responder === "function" ? await responder(input, init) : responder;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function loginMiniMax(overrides: Partial<Parameters<typeof loginMiniMaxPortalOAuth>[0]> = {}) {
  return loginMiniMaxPortalOAuth({
    openUrl: vi.fn(async () => undefined),
    note: vi.fn(async () => undefined),
    progress: { update: vi.fn(), stop: vi.fn() },
    ...overrides,
  });
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
    stubOAuthFetch(
      (_input, init) => authorizationResponse(init),
      tokenResponse({ expired_in: expiredIn }),
    );

    await expect(loginMiniMax()).resolves.toMatchObject({ expires: expectedExpires });
  });

  it("rejects malformed token expiry through the OAuth flow", async () => {
    stubOAuthFetch(
      (_input, init) => authorizationResponse(init),
      tokenResponse({ expired_in: "3600s" }),
    );

    await expect(loginMiniMax()).rejects.toThrow("invalid token expiry");
  });

  it.each([
    {
      phase: "authorization code",
      path: "/device-code",
      controlBody: "response_type=code",
      fetchIndex: 0,
    },
    {
      phase: "token polling",
      path: "/token",
      controlBody: "grant_type=user_code",
      fetchIndex: 1,
    },
  ])(
    "times out $phase HTTP requests against a hanging loopback server",
    async ({ phase, path, controlBody, fetchIndex }) => {
      const realFetch = fetch;
      const server = await startHangingLoopbackServer();
      const oauthTimeout = captureMiniMaxOAuthFetchTimeout();
      let loginPromise: Promise<unknown> | undefined;

      try {
        await expectFetchWithoutDeadlineToStayPending({
          url: `${server.origin}/control`,
          init: { method: "POST", body: controlBody },
          waitForRequest: () => server.waitForRequestCount(1),
        });

        const hangingResponse: FetchResponder = async (_input, init) =>
          await realFetch(`${server.origin}${path}`, init);
        const fetchMock =
          fetchIndex === 0
            ? stubOAuthFetch(hangingResponse)
            : stubOAuthFetch((_input, init) => authorizationResponse(init), hangingResponse);

        loginPromise = loginMiniMax();
        loginPromise.catch(() => undefined);

        await server.waitForRequestCount(2);
        oauthTimeout.fire();
        const result = await loginOutcomeWithin(loginPromise, 2_000);
        if (result.status !== "rejected") {
          throw new Error(`expected ${phase} request to reject, got ${result.status}`);
        }
        expectAbortOrTimeoutError(result.error);
        expect(server.requests).toContain(path);
        expect(fetchMock.mock.calls[fetchIndex]?.[1]?.signal).toBeInstanceOf(AbortSignal);
        expect(
          oauthTimeout.setTimeoutSpy.mock.calls.some(
            ([, timeout]) => timeout === MINIMAX_OAUTH_FETCH_TIMEOUT_MS,
          ),
        ).toBe(true);
      } finally {
        await server.close();
        await loginPromise?.catch(() => undefined);
      }
    },
  );

  it("bounds authorization error bodies without using response.text()", async () => {
    const tracked = cancelTrackedResponse(
      `${"minimax authorization unavailable ".repeat(1024)}tail`,
      {
        status: 503,
        headers: { "Content-Type": "text/plain" },
      },
    );
    const textSpy = vi.spyOn(tracked.response, "text").mockRejectedValue(new Error("unbounded"));
    stubOAuthFetch(tracked.response);

    const error = await loginMiniMax().catch((cause: unknown) => cause);

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
    stubOAuthFetch((_input, init) => authorizationResponse(init), tracked.response);

    const error = await loginMiniMax().catch((cause: unknown) => cause);

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
    stubOAuthFetch((_input, init) => authorizationResponse(init), tracked.response);

    const error = await loginMiniMax().catch((cause: unknown) => cause);

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
      const fetchMock = stubOAuthFetch(
        (_input, init) => authorizationResponse(init),
        tokenResponse(),
      );

      await expect(loginMiniMax({ region })).resolves.toMatchObject({
        access: "access",
        refresh: "refresh",
      });
      expect(
        fetchMock.mock.calls.map(([input]) =>
          input instanceof Request ? input.url : String(input),
        ),
      ).toEqual(expectedHosts);

      vi.unstubAllGlobals();
    }
  });

  it("rejects Date-invalid authorization expiries before formatting instructions", async () => {
    stubOAuthFetch((_input, init) =>
      authorizationResponse(init, { expired_in: 8_700_000_000_000_000 }),
    );
    const note = vi.fn(async () => undefined);

    await expect(loginMiniMax({ note })).rejects.toThrow("invalid expired_in");
    expect(note).not.toHaveBeenCalled();
  });

  it("caps oversized authorization poll intervals before scheduling", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    stubOAuthFetch(
      (_input, init) =>
        authorizationResponse(init, {
          expired_in: Date.now() + MAX_TIMER_TIMEOUT_MS + 10_000,
          interval: Number.MAX_SAFE_INTEGER,
        }),
      jsonResponse({ status: "pending" }),
      tokenResponse(),
    );

    const result = loginMiniMax();

    await vi.waitFor(() => {
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    });

    await vi.advanceTimersByTimeAsync(MAX_TIMER_TIMEOUT_MS);
    await expect(result).resolves.toMatchObject({ access: "access", refresh: "refresh" });
  });

  it("does not sleep past the authorization expiry deadline", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    stubOAuthFetch(
      (_input, init) => authorizationResponse(init, { interval: Number.MAX_SAFE_INTEGER }),
      jsonResponse({ status: "pending" }),
    );

    const result = loginMiniMax();

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
    stubOAuthFetch(
      (_input, init) => authorizationResponse(init, { interval: 0 }),
      jsonResponse({ status: "pending" }),
      tokenResponse(),
    );

    const result = loginMiniMax();

    await vi.waitFor(() => {
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2_000);
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(result).resolves.toMatchObject({ access: "access", refresh: "refresh" });
  });
});
