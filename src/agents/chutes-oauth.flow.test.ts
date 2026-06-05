/** Tests Chutes OAuth token exchange and refresh HTTP flows. */
import { describe, expect, it } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import {
  CHUTES_TOKEN_ENDPOINT,
  CHUTES_USERINFO_ENDPOINT,
  exchangeChutesCodeForTokens,
  refreshChutesTokens,
} from "./chutes-oauth.js";

const urlToString = (url: Request | URL | string): string => {
  if (typeof url === "string") {
    return url;
  }
  return "url" in url ? url.url : String(url);
};

function createStoredCredential(
  now: number,
): Parameters<typeof refreshChutesTokens>[0]["credential"] {
  return {
    access: "at_old",
    refresh: "rt_old",
    expires: now - 10_000,
    email: "fred",
    clientId: "cid_test",
  } as unknown as Parameters<typeof refreshChutesTokens>[0]["credential"];
}

function expectRefreshedCredential(
  refreshed: Awaited<ReturnType<typeof refreshChutesTokens>>,
  now: number,
) {
  // Refresh responses may omit refresh_token; the stored token remains valid and
  // expiry keeps the safety skew applied.
  expect(refreshed.access).toBe("at_new");
  expect(refreshed.refresh).toBe("rt_old");
  expect(refreshed.expires).toBe(now + 1800 * 1000 - 5 * 60 * 1000);
}

describe("chutes-oauth", () => {
  it("exchanges code for tokens and stores username as email", async () => {
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

  it("refreshes tokens using stored client id and falls back to old refresh token", async () => {
    const fetchFn = withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlToString(input);
      if (url !== CHUTES_TOKEN_ENDPOINT) {
        return new Response("not found", { status: 404 });
      }
      expect(init?.method).toBe("POST");
      const body = init?.body as URLSearchParams;
      expect(String(body.get("grant_type"))).toBe("refresh_token");
      expect(String(body.get("client_id"))).toBe("cid_test");
      expect(String(body.get("refresh_token"))).toBe("rt_old");
      return new Response(
        JSON.stringify({
          access_token: "at_new",
          expires_in: 1800,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const now = 2_000_000;
    const refreshed = await refreshChutesTokens({
      credential: createStoredCredential(now),
      fetchFn,
      now,
    });

    expectRefreshedCredential(refreshed, now);
  });

  it("refreshes tokens and ignores empty refresh_token values", async () => {
    const fetchFn = withFetchPreconnect(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlToString(input);
      if (url !== CHUTES_TOKEN_ENDPOINT) {
        return new Response("not found", { status: 404 });
      }
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({
          access_token: "at_new",
          refresh_token: "",
          expires_in: 1800,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const now = 3_000_000;
    const refreshed = await refreshChutesTokens({
      credential: createStoredCredential(now),
      fetchFn,
      now,
    });

    expectRefreshedCredential(refreshed, now);
  });

  it("rejects unsafe refresh token lifetimes", async () => {
    const fetchFn = withFetchPreconnect(async (input: RequestInfo | URL) => {
      const url = urlToString(input);
      if (url !== CHUTES_TOKEN_ENDPOINT) {
        return new Response("not found", { status: 404 });
      }
      return new Response('{"access_token":"at_new","expires_in":1e309}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    await expect(
      refreshChutesTokens({
        credential: createStoredCredential(4_000_000),
        fetchFn,
        now: 4_000_000,
      }),
    ).rejects.toThrow("Chutes token refresh returned invalid expires_in");
  });
});
