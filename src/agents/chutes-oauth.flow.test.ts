/** Tests the retained core Chutes OAuth token exchange compatibility flow. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { exchangeChutesCodeForTokens } from "./chutes-oauth.js";

const CHUTES_TOKEN_ENDPOINT = "https://api.chutes.ai/idp/token";
const CHUTES_USERINFO_ENDPOINT = "https://api.chutes.ai/idp/userinfo";

const urlToString = (url: Request | URL | string): string => {
  if (typeof url === "string") {
    return url;
  }
  return "url" in url ? url.url : String(url);
};

function rejectWhenAborted(init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  if (!signal) {
    return Promise.reject(new Error("missing OAuth request signal"));
  }
  return new Promise((_, reject) => {
    const rejectWithReason = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error("OAuth request aborted"));
    if (signal.aborted) {
      rejectWithReason();
      return;
    }
    signal.addEventListener("abort", rejectWithReason, { once: true });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("chutes-oauth", () => {
  it("exchanges code for tokens and stores username as email", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchFn = withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlToString(input);
      if (url === CHUTES_TOKEN_ENDPOINT) {
        expect(init?.method).toBe("POST");
        expect(
          String(init?.headers && (init.headers as Record<string, string>)["Content-Type"]),
        ).toContain("application/x-www-form-urlencoded");
        return new Response(
          JSON.stringify({
            access_token: "at_123",
            refresh_token: "rt_123",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === CHUTES_USERINFO_ENDPOINT) {
        expect(
          String(init?.headers && (init.headers as Record<string, string>).Authorization),
        ).toBe("Bearer at_123");
        return new Response(JSON.stringify({ username: "fred", sub: "sub_1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const now = 1_000_000;
    const creds = await exchangeChutesCodeForTokens({
      app: {
        clientId: "cid_test",
        redirectUri: "http://127.0.0.1:1456/oauth-callback",
        scopes: ["openid"],
      },
      code: "code_123",
      codeVerifier: "verifier_123",
      fetchFn,
      now,
    });

    expect(creds.access).toBe("at_123");
    expect(creds.refresh).toBe("rt_123");
    expect(creds.email).toBe("fred");
    expect((creds as unknown as { accountId?: string }).accountId).toBe("sub_1");
    expect((creds as unknown as { clientId?: string }).clientId).toBe("cid_test");
    expect(creds.expires).toBe(now + 3600 * 1000 - 5 * 60 * 1000);
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 30_000);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 30_000);
  });

  it("rejects unsafe exchange token lifetimes", async () => {
    const fetchFn = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url !== CHUTES_TOKEN_ENDPOINT) {
        return new Response("not found", { status: 404 });
      }
      return new Response(
        '{"access_token":"at_unsafe","refresh_token":"rt_unsafe","expires_in":1e309}',
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await expect(
      exchangeChutesCodeForTokens({
        app: {
          clientId: "cid_test",
          redirectUri: "http://127.0.0.1:1456/oauth-callback",
          scopes: ["openid"],
        },
        code: "code_unsafe",
        codeVerifier: "verifier_unsafe",
        fetchFn,
        now: 1_000_000,
      }),
    ).rejects.toThrow("Chutes token exchange returned invalid expires_in");
  });

  it("cancels failed userinfo response bodies during token exchange", async () => {
    const userInfoResponse = new Response("temporarily unavailable", { status: 503 });
    const cancel = vi.spyOn(userInfoResponse.body!, "cancel").mockResolvedValue(undefined);
    const fetchFn = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url === CHUTES_TOKEN_ENDPOINT) {
        return new Response(
          JSON.stringify({
            access_token: "at_123",
            refresh_token: "rt_123",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === CHUTES_USERINFO_ENDPOINT) {
        return userInfoResponse;
      }
      return new Response("not found", { status: 404 });
    });

    const creds = await exchangeChutesCodeForTokens({
      app: {
        clientId: "cid_test",
        redirectUri: "http://127.0.0.1:1456/oauth-callback",
        scopes: ["openid"],
      },
      code: "code_123",
      codeVerifier: "verifier_123",
      fetchFn,
      now: 1_000_000,
    });

    expect(cancel).toHaveBeenCalledOnce();
    expect(creds.access).toBe("at_123");
    expect(creds.email).toBeUndefined();
    expect((creds as unknown as { accountId?: string }).accountId).toBeUndefined();
  });

  it("keeps issued tokens when userinfo exceeds the fixed deadline", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
      expect(delay).toBe(30_000);
      return AbortSignal.abort(new DOMException("OAuth request timed out", "TimeoutError"));
    });
    const fetchFn = withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlToString(input);
      if (url === CHUTES_TOKEN_ENDPOINT) {
        return new Response(
          '{"access_token":"at_timeout","refresh_token":"rt_timeout","expires_in":3600}',
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === CHUTES_USERINFO_ENDPOINT) {
        return await rejectWhenAborted(init);
      }
      return new Response("not found", { status: 404 });
    });

    const credentials = await exchangeChutesCodeForTokens({
      app: {
        clientId: "cid_test",
        redirectUri: "http://127.0.0.1:1456/oauth-callback",
        scopes: ["openid"],
      },
      code: "code_test",
      codeVerifier: "verifier_test",
      fetchFn,
      now: 1_000_000,
    });

    expect(credentials).toMatchObject({ access: "at_timeout", refresh: "rt_timeout" });
    expect(credentials.email).toBeUndefined();
    expect(timeoutSpy).toHaveBeenCalledTimes(2);
  });

  it("normalizes and redacts structured token exchange errors", async () => {
    const leakedClientSecret = "oauth-client-secret-1234567890";
    const response = new Response(
      JSON.stringify({
        error: "invalid_grant",
        error_description: `Authorization failed for client_secret=${leakedClientSecret}`,
      }),
      {
        status: 400,
        headers: {
          "content-type": "application/json",
          "x-request-id": "chutes_req_123",
        },
      },
    );
    const textSpy = vi.spyOn(response, "text").mockRejectedValue(new Error("unbounded"));
    const fetchFn = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url === CHUTES_TOKEN_ENDPOINT) {
        return response;
      }
      return new Response("not found", { status: 404 });
    });

    let error: unknown;
    try {
      await exchangeChutesCodeForTokens({
        app: {
          clientId: "cid_test",
          redirectUri: "http://127.0.0.1:1456/oauth-callback",
          scopes: ["openid"],
        },
        code: "code_401",
        codeVerifier: "verifier_401",
        fetchFn,
        now: 1_000_000,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toMatchObject({
      name: "ProviderHttpError",
      status: 400,
      errorCode: "invalid_grant",
      requestId: "chutes_req_123",
    });
    const message = (error as Error).message;
    expect(message).toContain("Chutes token exchange failed (400): Authorization failed");
    expect(message).toContain("[code=invalid_grant]");
    expect(message).not.toContain(leakedClientSecret);
    expect(message).not.toContain("error_description");
    expect((error as { errorBody?: string }).errorBody).not.toContain(leakedClientSecret);
    expect(textSpy).not.toHaveBeenCalled();
  });
});
