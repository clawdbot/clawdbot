import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loginMiniMaxPortalOAuth, normalizeOAuthExpires } from "./oauth.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("normalizeOAuthExpires", () => {
  it("converts relative expiry seconds into an absolute millisecond timestamp", () => {
    expect(normalizeOAuthExpires(86_400, 1_700_000_000_000)).toBe(1_700_086_400_000);
  });

  it("converts Unix second timestamps into milliseconds", () => {
    expect(normalizeOAuthExpires(1_700_000_000)).toBe(1_700_000_000_000);
  });

  it("preserves absolute millisecond timestamps", () => {
    expect(normalizeOAuthExpires(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it("rejects unsafe and malformed expiry values", () => {
    expect(normalizeOAuthExpires(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeOAuthExpires(Number.MAX_SAFE_INTEGER + 1)).toBeUndefined();
    expect(normalizeOAuthExpires("3600s")).toBeUndefined();
  });
});

describe("loginMiniMaxPortalOAuth", () => {
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
