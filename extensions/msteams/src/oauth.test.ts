import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generatePkce,
  generateOAuthState,
  buildMSTeamsAuthUrl,
  parseCallbackInput,
} from "./oauth.flow.js";
import {
  MSTEAMS_DEFAULT_DELEGATED_SCOPES,
  MSTEAMS_OAUTH_REDIRECT_URI,
  buildMSTeamsAuthEndpoint,
  buildMSTeamsTokenEndpoint,
} from "./oauth.shared.js";
import { exchangeMSTeamsCodeForTokens, refreshMSTeamsDelegatedTokens } from "./oauth.token.js";

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("generatePkce", () => {
  it("produces a 64-char hex verifier and a base64url SHA-256 challenge", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[0-9a-f]{64}$/);
    const expected = createHash("sha256").update(verifier).digest("base64url");
    expect(challenge).toBe(expected);
  });
});

describe("generateOAuthState", () => {
  it("produces a 64-char hex string separate from the PKCE verifier", () => {
    const state = generateOAuthState();
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    const { verifier } = generatePkce();
    expect(state).not.toBe(verifier);
  });
});

describe("buildMSTeamsAuthUrl", () => {
  it("includes correct tenant, client_id, scopes, PKCE params, and redirect_uri", () => {
    const { challenge } = generatePkce();
    const state = generateOAuthState();
    const url = buildMSTeamsAuthUrl({
      tenantId: "my-tenant-id",
      clientId: "my-client-id",
      challenge,
      state,
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(buildMSTeamsAuthEndpoint("my-tenant-id"));
    expect(parsed.searchParams.get("client_id")).toBe("my-client-id");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("redirect_uri")).toBe(MSTEAMS_OAUTH_REDIRECT_URI);
    expect(parsed.searchParams.get("scope")).toBe(MSTEAMS_DEFAULT_DELEGATED_SCOPES.join(" "));
    expect(parsed.searchParams.get("code_challenge")).toBe(challenge);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("state")).toBe(state);
    expect(parsed.searchParams.get("prompt")).toBe("consent");
  });

  it("does not expose the PKCE verifier in the URL", () => {
    const { verifier, challenge } = generatePkce();
    const state = generateOAuthState();
    const url = buildMSTeamsAuthUrl({
      tenantId: "t",
      clientId: "c",
      challenge,
      state,
    });
    expect(url).not.toContain(verifier);
    expect(url).toContain(`state=${state}`);
  });

  it("uses custom scopes when provided", () => {
    const url = buildMSTeamsAuthUrl({
      tenantId: "t",
      clientId: "c",
      challenge: "ch",
      state: "s",
      scopes: ["User.Read", "offline_access"],
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get("scope")).toBe("User.Read offline_access");
  });
});

describe("parseCallbackInput", () => {
  const expectedState = "expected-state-value";

  it("extracts code and state from a valid callback URL", () => {
    const input = `${MSTEAMS_OAUTH_REDIRECT_URI}?code=abc123&state=${expectedState}`;
    const result = parseCallbackInput(input, expectedState);
    expect(result).toEqual({ code: "abc123", state: expectedState });
  });

  it("returns error when code is missing from URL", () => {
    const input = `${MSTEAMS_OAUTH_REDIRECT_URI}?state=${expectedState}`;
    const result = parseCallbackInput(input, expectedState);
    expect(result).toEqual({ error: "Missing 'code' parameter in URL" });
  });

  it("rejects bare authorization codes to prevent CSRF bypass", () => {
    const result = parseCallbackInput("bare-code-value", expectedState);
    expect(result).toEqual({
      error:
        "Paste the full redirect URL (including code and state parameters), not just the authorization code.",
    });
  });

  it("returns error on empty input", () => {
    const result = parseCallbackInput("", expectedState);
    expect(result).toEqual({ error: "No input provided" });
  });

  it("returns error when state is missing from a valid URL (CSRF protection)", () => {
    const input = `${MSTEAMS_OAUTH_REDIRECT_URI}?code=abc123`;
    const result = parseCallbackInput(input, expectedState);
    expect(result).toEqual({
      error: "Missing 'state' parameter in URL. Paste the full redirect URL.",
    });
  });

  it("rejects bare codes even when expectedState is empty", () => {
    const result = parseCallbackInput("bare-code", "");
    expect(result).toEqual({
      error:
        "Paste the full redirect URL (including code and state parameters), not just the authorization code.",
    });
  });
});

describe("exchangeMSTeamsCodeForTokens", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exchanges an authorization code for delegated tokens", async () => {
    const now = Date.now();
    fetchSpy.mockResolvedValueOnce(
      responseJson({
        access_token: "at-123",
        refresh_token: "rt-456",
        expires_in: 3600,
        scope: "ChatMessage.Send offline_access",
      }),
    );

    const tokens = await exchangeMSTeamsCodeForTokens({
      tenantId: "tenant-1",
      clientId: "client-1",
      clientSecret: "secret-1", // pragma: allowlist secret
      code: "auth-code",
      verifier: "pkce-verifier",
    });
    const afterExchange = Date.now();

    expect(tokens.accessToken).toBe("at-123");
    expect(tokens.refreshToken).toBe("rt-456");
    expect(tokens.scopes).toEqual(["ChatMessage.Send", "offline_access"]);
    // expiresAt should be roughly now + 3600s - 300s
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(now + 3300 * 1000 - 1000);
    expect(tokens.expiresAt).toBeLessThanOrEqual(afterExchange + 3300 * 1000 + 2000);

    // Verify the request was well-formed
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(buildMSTeamsTokenEndpoint("tenant-1"));
    const body = new URLSearchParams(init.body as string);
    expect(body.get("client_id")).toBe("client-1");
    expect(body.get("client_secret")).toBe("secret-1");
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("pkce-verifier");
    expect(body.get("redirect_uri")).toBe(MSTEAMS_OAUTH_REDIRECT_URI);
  });

  it("throws on a 400 error response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      exchangeMSTeamsCodeForTokens({
        tenantId: "t",
        clientId: "c",
        clientSecret: "s", // pragma: allowlist secret
        code: "bad-code",
        verifier: "v",
      }),
    ).rejects.toThrow(/MSTeams token exchange failed \(400\)/);
  });
});

describe("refreshMSTeamsDelegatedTokens", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refreshes tokens using refresh_token grant and keeps old refresh token when Azure omits it", async () => {
    const now = Date.now();
    fetchSpy.mockResolvedValueOnce(
      responseJson({
        access_token: "new-at",
        // Azure sometimes does not return a new refresh_token
        expires_in: 3600,
        scope: "ChatMessage.Send offline_access",
      }),
    );

    const tokens = await refreshMSTeamsDelegatedTokens({
      tenantId: "tenant-1",
      clientId: "client-1",
      clientSecret: "secret-1", // pragma: allowlist secret
      refreshToken: "original-rt",
    });

    expect(tokens.accessToken).toBe("new-at");
    // Old refresh token should be preserved
    expect(tokens.refreshToken).toBe("original-rt");
    expect(tokens.scopes).toEqual(["ChatMessage.Send", "offline_access"]);
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(now + 3300 * 1000 - 1000);

    // Verify the request body includes refresh_token grant type
    const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("original-rt");
    expect(body.get("client_secret")).toBe("secret-1");
  });

  it("uses new refresh token when Azure returns one", async () => {
    fetchSpy.mockResolvedValueOnce(
      responseJson({
        access_token: "new-at",
        refresh_token: "new-rt",
        expires_in: 3600,
      }),
    );

    const tokens = await refreshMSTeamsDelegatedTokens({
      tenantId: "t",
      clientId: "c",
      clientSecret: "s", // pragma: allowlist secret
      refreshToken: "old-rt",
    });

    expect(tokens.refreshToken).toBe("new-rt");
  });

  it("throws on a 401 error response", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(
      refreshMSTeamsDelegatedTokens({
        tenantId: "t",
        clientId: "c",
        clientSecret: "s", // pragma: allowlist secret
        refreshToken: "expired-rt",
      }),
    ).rejects.toThrow(/MSTeams token refresh failed \(401\)/);
  });
});
