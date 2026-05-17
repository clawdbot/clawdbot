import { describe, expect, it, vi } from "vitest";
import {
  buildXaiOAuthAuthorizeUrl,
  fetchXaiOAuthDiscovery,
  isTrustedXaiOAuthEndpoint,
  refreshXaiOAuthCredential,
  XAI_OAUTH_CALLBACK_PORT,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_REDIRECT_URI,
  XAI_OAUTH_SCOPE,
} from "./xai-oauth.js";

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("xAI OAuth", () => {
  it("accepts only trusted xAI OAuth endpoints", () => {
    expect(isTrustedXaiOAuthEndpoint("https://auth.x.ai/oauth2/token")).toBe(true);
    expect(isTrustedXaiOAuthEndpoint("https://accounts.x.ai/oauth2/token")).toBe(true);
    expect(isTrustedXaiOAuthEndpoint("http://auth.x.ai/oauth2/token")).toBe(false);
    expect(isTrustedXaiOAuthEndpoint("https://x.ai.evil.test/oauth2/token")).toBe(false);
    expect(isTrustedXaiOAuthEndpoint("not a url")).toBe(false);
  });

  it("builds the xAI authorize URL for OpenClaw", () => {
    const url = new URL(
      buildXaiOAuthAuthorizeUrl({
        authorizationEndpoint: "https://auth.x.ai/oauth2/authorize",
        state: "state-1",
        nonce: "nonce-1",
        challenge: "challenge-1",
      }),
    );

    expect(url.origin + url.pathname).toBe("https://auth.x.ai/oauth2/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(XAI_OAUTH_CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(XAI_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe(XAI_OAUTH_SCOPE);
    expect(url.searchParams.get("code_challenge")).toBe("challenge-1");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("nonce")).toBe("nonce-1");
    expect(url.searchParams.get("plan")).toBe("generic");
    expect(url.searchParams.get("referrer")).toBe("openclaw");
    expect(XAI_OAUTH_REDIRECT_URI).toContain(`:${XAI_OAUTH_CALLBACK_PORT}/`);
  });

  it("validates discovered endpoints before using them", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
        token_endpoint: "https://auth.x.ai/oauth2/token",
      }),
    ) as unknown as typeof fetch;

    await expect(fetchXaiOAuthDiscovery({ fetchImpl })).resolves.toEqual({
      authorizationEndpoint: "https://auth.x.ai/oauth2/authorize",
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    });

    const poisonedFetch = vi.fn(async () =>
      jsonResponse({
        authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
        token_endpoint: "https://evil.test/oauth2/token",
      }),
    ) as unknown as typeof fetch;

    await expect(fetchXaiOAuthDiscovery({ fetchImpl: poisonedFetch })).rejects.toThrow(
      "untrusted token endpoint",
    );
  });

  it("refreshes with the cached token endpoint and preserves refresh fallback", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(typeof init?.body).toBe("string");
      const body = init?.body as string;
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain(`client_id=${encodeURIComponent(XAI_OAUTH_CLIENT_ID)}`);
      expect(body).toContain("refresh_token=refresh-1");
      return jsonResponse({
        access_token: "access-2",
        expires_in: 120,
      });
    }) as unknown as typeof fetch;

    const refreshed = await refreshXaiOAuthCredential(
      {
        type: "oauth",
        provider: "xai",
        access: "access-1",
        refresh: "refresh-1",
        expires: 100,
        tokenEndpoint: "https://auth.x.ai/oauth2/token",
      } as unknown as Parameters<typeof refreshXaiOAuthCredential>[0],
      { fetchImpl, now: () => 1_000 },
    );

    expect(fetchImpl).toHaveBeenCalledWith("https://auth.x.ai/oauth2/token", expect.any(Object));
    expect(refreshed.access).toBe("access-2");
    expect(refreshed.refresh).toBe("refresh-1");
    expect(refreshed.expires).toBe(121_000);
  });
});
