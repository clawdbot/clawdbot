import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pollGitHubOAuthDeviceToken,
  refreshGitHubOAuthToken,
  requestGitHubOAuthDeviceCode,
} from "./github-oauth-client.js";

const GITHUB_OAUTH_CLIENT_ID = "Ov23liUjOXHi28w2fDlH";
const GITHUB_OAUTH_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_OAUTH_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

const DEVICE_CODE = "a".repeat(40);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tokenPair(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    access_token: "access-token",
    token_type: "bearer",
    scope: "workflow,repo,read:org,gist repo",
    expires_in: 28_800,
    refresh_token: "refresh-token-next",
    refresh_token_expires_in: 15_897_600,
    ...overrides,
  };
}

function expectOAuthFormCall(expectedUrl: string, expectedForm: Record<string, string>): void {
  const fetchMock = vi.mocked(fetch);
  expect(fetchMock).toHaveBeenCalledOnce();
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  expect(url).toBe(expectedUrl);
  expect(init).toMatchObject({
    method: "POST",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });
  expect(init?.signal).toBeInstanceOf(AbortSignal);
  const body = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
  expect(Object.fromEntries(body)).toEqual(expectedForm);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GitHub OAuth client", () => {
  it("requests the fixed GitHub device flow and repository workflow scopes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        device_code: DEVICE_CODE,
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    );

    await expect(requestGitHubOAuthDeviceCode()).resolves.toEqual({
      deviceCode: DEVICE_CODE,
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      expiresInSeconds: 900,
      intervalSeconds: 5,
    });
    expectOAuthFormCall(GITHUB_OAUTH_DEVICE_CODE_URL, {
      client_id: GITHUB_OAUTH_CLIENT_ID,
      scope: "repo workflow read:org gist offline_access",
    });
  });

  it.each([
    ["device code", { device_code: "short" }],
    ["user code", { user_code: "invalid" }],
    ["verification URI", { verification_uri: "https://example.com/login/device" }],
    ["expiration", { expires_in: "900" }],
    ["poll interval", { interval: 0 }],
  ])("rejects an invalid device authorization %s", async (_name, overrides) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        device_code: DEVICE_CODE,
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
        ...overrides,
      }),
    );

    await expect(requestGitHubOAuthDeviceCode()).rejects.toThrow(
      "GitHub OAuth device authorization response was invalid",
    );
  });

  it("returns a rotated token pair with deterministic scopes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(tokenPair()));

    await expect(pollGitHubOAuthDeviceToken({ deviceCode: DEVICE_CODE })).resolves.toEqual({
      status: "authorized",
      tokens: {
        accessToken: "access-token",
        tokenType: "bearer",
        scopes: ["gist", "read:org", "repo", "workflow"],
        expiresInSeconds: 28_800,
        refreshToken: "refresh-token-next",
        refreshTokenExpiresInSeconds: 15_897_600,
      },
    });
    expectOAuthFormCall(GITHUB_OAUTH_ACCESS_TOKEN_URL, {
      client_id: GITHUB_OAUTH_CLIENT_ID,
      device_code: DEVICE_CODE,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
  });

  it.each([
    {
      body: { error: "authorization_pending" },
      expected: { status: "authorization_pending" },
    },
    {
      body: {
        error: "slow_down",
        interval: 12,
        error_description: "Continue at the returned interval",
        error_uri: "https://docs.github.com/apps/oauth-apps",
      },
      expected: {
        status: "slow_down",
        intervalSeconds: 12,
        errorDescription: "Continue at the returned interval",
        errorUri: "https://docs.github.com/apps/oauth-apps",
      },
    },
    { body: { error: "expired_token" }, expected: { status: "expired_token" } },
    { body: { error: "access_denied" }, expected: { status: "access_denied" } },
    {
      body: { error: "device_flow_disabled" },
      expected: { status: "error", code: "device_flow_disabled" },
    },
  ])("returns the typed polling state for $body.error", async ({ body, expected }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body));

    await expect(pollGitHubOAuthDeviceToken({ deviceCode: DEVICE_CODE })).resolves.toEqual(
      expected,
    );
  });

  it("refreshes by rotating the pair without sending a client secret", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(tokenPair({ scope: "repo workflow read:org gist" })),
    );

    await expect(
      refreshGitHubOAuthToken({ refreshToken: "refresh-token-current" }),
    ).resolves.toEqual({
      status: "refreshed",
      tokens: {
        accessToken: "access-token",
        tokenType: "bearer",
        scopes: ["gist", "read:org", "repo", "workflow"],
        expiresInSeconds: 28_800,
        refreshToken: "refresh-token-next",
        refreshTokenExpiresInSeconds: 15_897_600,
      },
    });
    expectOAuthFormCall(GITHUB_OAUTH_ACCESS_TOKEN_URL, {
      client_id: GITHUB_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: "refresh-token-current",
    });
  });

  it("returns refresh rejection as a typed outcome", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: "bad_refresh_token" }, 400),
    );

    await expect(
      refreshGitHubOAuthToken({ refreshToken: "refresh-token-current" }),
    ).resolves.toEqual({
      status: "error",
      code: "bad_refresh_token",
    });
  });

  it.each([
    ["wrong token type", tokenPair({ token_type: "mac" })],
    ["non-numeric expiration", tokenPair({ expires_in: "28800" })],
    ["missing refresh rotation", tokenPair({ refresh_token: undefined })],
    ["missing publication scopes", tokenPair({ scope: "repo" })],
    ["unknown error", { error: "surprise_error" }],
    ["invalid slow-down interval", { error: "slow_down", interval: "12" }],
    ["mixed success and error", { ...tokenPair(), error: "authorization_pending" }],
  ])("rejects a strictly invalid %s response", async (_name, body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(body));

    await expect(pollGitHubOAuthDeviceToken({ deviceCode: DEVICE_CODE })).rejects.toThrow(
      "GitHub OAuth device token response was invalid",
    );
  });

  it("rejects oversized response bodies without reflecting their contents", async () => {
    const secretLikeBody = JSON.stringify({ access_token: "s".repeat(20_000) });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(secretLikeBody, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(pollGitHubOAuthDeviceToken({ deviceCode: DEVICE_CODE })).rejects.toThrow(
      "GitHub OAuth device token response was invalid",
    );
  });

  it("combines caller cancellation with a bounded request timeout", async () => {
    const caller = new AbortController();
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      expect(init?.signal?.aborted).toBe(false);
      caller.abort(new Error("cancelled"));
      expect(init?.signal?.aborted).toBe(true);
      throw init?.signal?.reason;
    });

    await expect(
      requestGitHubOAuthDeviceCode({ signal: caller.signal, timeoutMs: 1234 }),
    ).rejects.toThrow("cancelled");
    expect(timeoutSpy).toHaveBeenCalledWith(1234);
  });
});
