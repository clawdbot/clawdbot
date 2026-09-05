import { afterEach, describe, expect, it, vi } from "vitest";
import { redactRegisteredSecretValues } from "../logging/secret-redaction-registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  clearGitHubCredentialVerificationCache,
  pollGitHubOAuthDeviceToken,
  refreshGitHubOAuthToken,
  requestGitHubOAuthDeviceCode,
  verifyGitHubCredential,
} from "./github-oauth-client.js";

const GITHUB_OAUTH_CLIENT_ID = "Ov23liUjOXHi28w2fDlH";
const GITHUB_OAUTH_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_OAUTH_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_CREDENTIAL_VERIFICATION_TTL_MS = 60_000;

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
  it.each(["managed-user", "managed-user_org"])(
    "verifies the supplied %s credential at a fixed origin and registers redaction",
    async (login) => {
      const token = `synthetic-bound-credential-${login}`;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            id: 202,
            login,
            avatar_url: null,
          }),
          { headers: { "x-oauth-scopes": "read:org, repo, repo" } },
        ),
      );
      expect(await verifyGitHubCredential(token)).toEqual({
        status: "available",
        account: { accountId: 202, login, avatarUrl: null },
        scopes: ["read:org", "repo"],
      });
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        "https://api.github.com/user",
        expect.objectContaining({
          method: "GET",
          redirect: "error",
          signal: expect.any(AbortSignal),
          headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}` },
        }),
      );
      expect(redactRegisteredSecretValues(`failed with ${token}`, () => "[REDACTED]")).toBe(
        "failed with [REDACTED]",
      );
    },
  );

  it("reuses a verified account within the TTL and re-probes after it", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const probe = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ id: 202, login: "ttl-user" }));
    const first = await verifyGitHubCredential("synthetic-ttl-token");
    expect(first.status).toBe("available");
    const second = await verifyGitHubCredential("synthetic-ttl-token");
    expect(probe).toHaveBeenCalledOnce();
    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    if (first.status === "available") {
      expect(Object.isFrozen(first.account)).toBe(true);
      expect(Object.isFrozen(first.scopes)).toBe(true);
    }

    now.mockReturnValue(1_000 + GITHUB_CREDENTIAL_VERIFICATION_TTL_MS + 1);
    expect(await verifyGitHubCredential("synthetic-ttl-token")).toEqual(first);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("re-probes a remotely revoked token after expiry without caching its rejection", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(2_000);
    const probe = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ id: 202, login: "revoked-user" }))
      .mockImplementation(async () => jsonResponse({}, 401));
    expect((await verifyGitHubCredential("synthetic-revoked-token")).status).toBe("available");
    now.mockReturnValue(2_000 + GITHUB_CREDENTIAL_VERIFICATION_TTL_MS + 1);
    expect(await verifyGitHubCredential("synthetic-revoked-token")).toEqual({
      status: "unavailable",
    });
    expect(await verifyGitHubCredential("synthetic-revoked-token")).toEqual({
      status: "unavailable",
    });
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("re-probes an unavailable credential immediately so reconnects recover", async () => {
    const probe = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ id: 202, login: "recovered-user" }));
    expect(await verifyGitHubCredential("synthetic-recovered-token")).toEqual({
      status: "unavailable",
    });
    expect(await verifyGitHubCredential("synthetic-recovered-token")).toMatchObject({
      status: "available",
      account: { login: "recovered-user" },
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("keeps different tokens separate while sharing concurrent probes for one token", async () => {
    const probe = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) =>
        jsonResponse({ id: 202, login: new Headers(init?.headers).get("Authorization") }),
      );
    const [first, concurrent, other] = await Promise.all([
      verifyGitHubCredential("synthetic-concurrent-a"),
      verifyGitHubCredential("synthetic-concurrent-a"),
      verifyGitHubCredential("synthetic-concurrent-b"),
    ]);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(concurrent).toBe(first);
    expect(other).not.toEqual(first);
    expect(await verifyGitHubCredential("synthetic-concurrent-b")).toBe(other);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("clearing verified credentials forces a re-probe", async () => {
    const probe = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ id: 202, login: "cleared-user" }));
    await verifyGitHubCredential("synthetic-cleared-token");
    clearGitHubCredentialVerificationCache();
    await verifyGitHubCredential("synthetic-cleared-token");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it.each(["signal", "timeout"] as const)(
    "keeps caller-specific %s probes independent but cacheable",
    async (kind) => {
      const token = `synthetic-independent-${kind}`;
      const options =
        kind === "signal" ? { signal: new AbortController().signal } : { timeoutMs: 1_000 };
      const probe = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async () => jsonResponse({ id: 202, login: "independent-user" }));
      await Promise.all([verifyGitHubCredential(token, options), verifyGitHubCredential(token)]);
      expect(probe).toHaveBeenCalledTimes(2);
      expect((await verifyGitHubCredential(token, options)).status).toBe("available");
      expect(probe).toHaveBeenCalledTimes(2);
    },
  );

  it("bounds verified entries and re-probes an evicted credential", async () => {
    const probe = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => jsonResponse({ id: 202, login: "bounded-user" }));
    for (let index = 0; index < 33; index++) {
      await verifyGitHubCredential(`synthetic-bounded-${index}`);
    }
    await verifyGitHubCredential("synthetic-bounded-32");
    expect(probe).toHaveBeenCalledTimes(33);
    await verifyGitHubCredential("synthetic-bounded-0");
    expect(probe).toHaveBeenCalledTimes(34);
  });

  it("does not let an in-flight probe repopulate cleared verification state", async () => {
    const upstream = createDeferredCore<Response>();
    const probe = vi
      .spyOn(globalThis, "fetch")
      .mockReturnValueOnce(upstream.promise)
      .mockImplementation(async () => jsonResponse({ id: 202, login: "after-clear" }));
    const first = verifyGitHubCredential("synthetic-inflight-clear");
    clearGitHubCredentialVerificationCache();
    const second = await verifyGitHubCredential("synthetic-inflight-clear");
    upstream.resolve(jsonResponse({ id: 202, login: "before-clear" }));
    await first;
    expect(await verifyGitHubCredential("synthetic-inflight-clear")).toBe(second);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it.each([
    { code: 401, headers: new Headers(), status: "unavailable" },
    { code: 403, headers: new Headers({ "x-ratelimit-remaining": "0" }), status: "rate_limited" },
    { code: 403, headers: new Headers({ "retry-after": "60" }), status: "rate_limited" },
    { code: 429, headers: new Headers(), status: "rate_limited" },
    { code: 403, headers: new Headers(), status: "unverified" },
    { code: 500, headers: new Headers(), status: "unverified" },
  ])(
    "classifies account HTTP $code as $status without reflecting diagnostics",
    async ({ code, headers, status }) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("synthetic-secret-diagnostics", { status: code, headers }),
      );
      const token = `synthetic-http-${code}-${status}-${headers.get("retry-after") ?? headers.get("x-ratelimit-remaining") ?? "none"}`;
      expect(await verifyGitHubCredential(token)).toEqual({ status });
    },
  );

  it.each([
    ["invalid-json", "not-json synthetic-token"],
    ["long-login", JSON.stringify({ id: 202, login: "x".repeat(101) })],
    ["invalid-id", JSON.stringify({ id: "202", login: "managed-user" })],
    [
      "oversized-body",
      JSON.stringify({ id: 202, login: "managed-user", padding: "x".repeat(17000) }),
    ],
  ])(
    "rejects malformed or unbounded %s account responses without diagnostics",
    async (name, body) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
      expect(await verifyGitHubCredential(`synthetic-${name}`)).toEqual({ status: "unverified" });
    },
  );

  it("bounds the account body read and sanitizes network and cancellation errors", async () => {
    const cancel = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({ cancel })));
    expect(await verifyGitHubCredential("synthetic-body-timeout", { timeoutMs: 10 })).toEqual({
      status: "unverified",
    });
    expect(cancel).toHaveBeenCalled();
    const caller = new AbortController();
    vi.mocked(fetch).mockImplementation(async (_url, init) => {
      caller.abort(new Error("synthetic-token must stay private"));
      expect(init?.signal?.aborted).toBe(true);
      throw init?.signal?.reason;
    });
    expect(
      await verifyGitHubCredential("synthetic-cancellation", { signal: caller.signal }),
    ).toEqual({
      status: "unverified",
    });
  });

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
