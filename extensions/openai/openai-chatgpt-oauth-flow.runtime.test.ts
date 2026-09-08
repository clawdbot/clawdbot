import { lookup } from "node:dns/promises";
// Openai tests cover openai chatgpt oauth flow plugin behavior.
import { EventEmitter, once } from "node:events";
import { Agent, createServer, get, type IncomingHttpHeaders, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";

const ssrfMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  );
  return {
    ...actual,
    fetchWithSsrFGuard: ssrfMocks.fetchWithSsrFGuard,
  };
});

import {
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  createOpenAIAuthorizationFlow,
  resolveOpenAICallbackHost,
  resolveOpenAIRedirectUri,
} from "./openai-chatgpt-oauth-authorization.runtime.js";
import { loginOpenAICodex, refreshOpenAICodexToken } from "./openai-chatgpt-oauth-flow.runtime.js";
import {
  exchangeOpenAIAuthorizationCode,
  refreshOpenAIAccessToken,
} from "./openai-chatgpt-oauth-token.runtime.js";
import { loginOpenAICodexOAuth } from "./openai-chatgpt-oauth.runtime.js";
import { buildOpenAIProvider } from "./openai-provider.js";

function timeoutError(): Error {
  return new DOMException("timed out", "TimeoutError");
}

function fakeJwt(payload: unknown): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "test-signature",
  ].join(".");
}

async function requestCallback(
  url: string,
  agent: Agent,
): Promise<{ headers: IncomingHttpHeaders; body: string }> {
  // A container's client DNS hints can omit IPv6 even when listen("localhost")
  // selects ::1. Keep the fixture client on the listener's resolved family.
  const { family } = await lookup(resolveOpenAICallbackHost());
  return new Promise((resolve, reject) => {
    const request = get(url, { agent, family }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ headers: response.headers, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    request.on("error", reject);
  });
}

async function connectIdleSocket(url: string): Promise<Socket> {
  const callbackUrl = new URL(url);
  const { family } = await lookup(resolveOpenAICallbackHost());
  const socket = connect({
    host: resolveOpenAICallbackHost(),
    port: Number(callbackUrl.port),
    family,
  });
  return once(socket, "connect").then(() => socket);
}

function mockTokenResponse(body: unknown, status = 200): void {
  mockTokenResponseText(JSON.stringify(body), status);
}

function mockTokenResponseText(body: string, status = 200): void {
  ssrfMocks.fetchWithSsrFGuard.mockResolvedValueOnce({
    response: new Response(body, {
      status,
      headers: { "Content-Type": "application/json" },
    }),
    release: vi.fn(async () => undefined),
  });
}

function mockFakeIpTokenResponse(params: { address: string; family: 4 | 6 }): void {
  ssrfMocks.fetchWithSsrFGuard.mockImplementationOnce(
    async ({ policy }: { policy?: SsrFPolicy }) => {
      const lookupFn = vi.fn(async () => [params]) as unknown as LookupFn;
      const pinned = await resolvePinnedHostnameWithPolicy("auth.openai.com", {
        lookupFn,
        policy,
      });

      expect(pinned.addresses).toEqual([params.address]);
      await expect(
        resolvePinnedHostnameWithPolicy("redirect.example.com", { lookupFn, policy }),
      ).rejects.toThrow("Blocked hostname (not in allowlist)");
      expect(lookupFn).toHaveBeenCalledOnce();

      return {
        response: new Response(
          JSON.stringify({
            access_token: "test-access-token",
            refresh_token: "test-refresh-token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
        release: vi.fn(async () => undefined),
      };
    },
  );
}

afterEach(() => {
  ssrfMocks.fetchWithSsrFGuard.mockReset();
  vi.unstubAllGlobals();
});

describe("OpenAI Codex OAuth flow", () => {
  it("uses the provider message for failed token refreshes without exposing the response body", async () => {
    const providerMessage =
      "Your refresh token has already been used to generate a new access token. Please try signing in again.";
    const responseBody = {
      error: {
        message: providerMessage,
        type: "invalid_request_error",
        code: "refresh_token_reused",
        refresh_token: "must-not-leak",
      },
    };
    mockTokenResponse(responseBody, 401);

    await expect(refreshOpenAIAccessToken("old-refresh-token")).resolves.toEqual({
      type: "failed",
      operation: "refresh",
      status: 401,
      reason: "refresh_token_reused",
      summary: providerMessage,
      code: "refresh_token_reused",
      errorType: "invalid_request_error",
    });

    mockTokenResponse(responseBody, 401);
    const error = await refreshOpenAICodexToken("old-refresh-token").catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      message: `${providerMessage}\n\nOpenAI Codex token refresh failed (HTTP 401; code=refresh_token_reused; type=invalid_request_error).`,
      oauthRefreshFailure: {
        errorType: "invalid_request_error",
        reason: "refresh_token_reused",
        status: 401,
        summary: providerMessage,
      },
    });
    expect(JSON.stringify(error)).not.toContain("must-not-leak");

    mockTokenResponseText("refresh_token=must-not-leak", 401);
    await expect(refreshOpenAIAccessToken("old-refresh-token")).resolves.toEqual({
      type: "failed",
      operation: "refresh",
      status: 401,
      summary: "OpenAI Codex token refresh failed (HTTP 401).",
    });
    mockTokenResponseText("refresh_token=must-not-leak", 401);
    await expect(refreshOpenAICodexToken("old-refresh-token")).rejects.toMatchObject({
      oauthRefreshFailure: {
        status: 401,
        summary: "OpenAI Codex token refresh failed (HTTP 401).",
      },
    });

    mockTokenResponse({ error: { code: "refresh_token_reused" } }, 401);
    await expect(refreshOpenAIAccessToken("old-refresh-token")).resolves.toEqual({
      type: "failed",
      operation: "refresh",
      status: 401,
      reason: "refresh_token_reused",
      summary: "OpenAI Codex token refresh failed (HTTP 401).",
      code: "refresh_token_reused",
    });
    mockTokenResponse({ error: { code: "refresh_token_reused" } }, 401);
    await expect(refreshOpenAICodexToken("old-refresh-token")).rejects.toMatchObject({
      oauthRefreshFailure: {
        reason: "refresh_token_reused",
        status: 401,
        summary: "OpenAI Codex token refresh failed (HTTP 401).",
      },
    });

    mockTokenResponse(
      {
        error: {
          message: "Your refresh token is expired.",
          type: "invalid_request_error",
          code: "refresh_token_expired",
        },
      },
      401,
    );
    await expect(refreshOpenAICodexToken("old-refresh-token")).rejects.toMatchObject({
      oauthRefreshFailure: {
        errorType: "invalid_request_error",
        reason: "expired",
        status: 401,
        summary: "Your refresh token is expired.",
      },
    });
  });

  it("cancels provider login before opening the OAuth flow", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      loginOpenAICodex({
        onAuth: vi.fn(),
        onPrompt: vi.fn(async () => "unused-code"),
        signal: controller.signal,
      }),
    ).rejects.toThrow("Login cancelled");
  });

  it("does not open the OAuth flow after cancellation during setup", async () => {
    const controller = new AbortController();
    const onAuth = vi.fn();
    const loginPromise = loginOpenAICodex({
      onAuth,
      onPrompt: vi.fn(async () => "unused-code"),
      signal: controller.signal,
    });

    controller.abort();

    await expect(loginPromise).rejects.toThrow("Login cancelled");
    expect(onAuth).not.toHaveBeenCalled();
  });

  it.each(["callback", "manual input", "transport preparation"] as const)(
    "revalidates live authority after held %s before exchanging the code",
    async (boundary) => {
      const held = createDeferred<void>();
      const release = createDeferred<void>();
      const controller = new AbortController();
      const agent = new Agent();
      let current = true;
      const sendToken = vi.fn(async () => ({
        response: new Response(
          JSON.stringify({
            access_token: fakeJwt({
              "https://api.openai.com/auth": { chatgpt_account_id: "account" },
            }),
            refresh_token: "refresh",
            expires_in: 60,
          }),
        ),
        release: vi.fn(async () => undefined),
      }));
      ssrfMocks.fetchWithSsrFGuard.mockImplementation(
        async ({ beforeRequest }: { beforeRequest?: () => void }) => {
          if (boundary === "transport preparation") {
            held.resolve();
            await release.promise;
          }
          beforeRequest?.();
          return await sendToken();
        },
      );
      const outcome = loginOpenAICodex({
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("owner retired");
          }
        },
        onAuth: async ({ url }) => {
          if (boundary === "callback") {
            const authUrl = new URL(url);
            const callback = new URL(authUrl.searchParams.get("redirect_uri") ?? "");
            callback.searchParams.set("state", authUrl.searchParams.get("state") ?? "");
            callback.searchParams.set("code", "synthetic-code");
            await requestCallback(callback.toString(), agent);
            held.resolve();
            await release.promise;
          }
        },
        onPrompt: async () => "synthetic-code",
        onManualCodeInput: async () => {
          if (boundary === "manual input") {
            held.resolve();
            await release.promise;
          }
          return "synthetic-code";
        },
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        await held.promise;
        current = false;
        release.resolve();
        const result = await outcome;
        expect(sendToken).not.toHaveBeenCalled();
        expect(result).toEqual({
          error: expect.objectContaining({ message: expect.stringContaining("owner retired") }),
        });
        expect(controller.signal.aborted).toBe(false);
      } finally {
        controller.abort();
        release.resolve();
        await outcome;
        agent.destroy();
      }
    },
  );

  it("closes the callback listener when cancellation outlives a pending browser presentation", async () => {
    const events = new EventEmitter();
    const ready = once(events, "ready");
    const release = once(events, "release");
    const controller = new AbortController();
    const rejected = vi.fn();
    const login = loginOpenAICodex({
      onAuth: async ({ url }) => {
        events.emit("ready", url);
        await release;
      },
      onPrompt: vi.fn(async () => "unused-code"),
      signal: controller.signal,
    }).catch(rejected);
    let socket: Socket | undefined;
    try {
      const [url] = await ready;
      const redirectUri = new URL(url).searchParams.get("redirect_uri");
      if (!redirectUri) {
        throw new Error("expected the callback redirect URI");
      }
      const callbackSocket = await connectIdleSocket(redirectUri);
      socket = callbackSocket;
      const socketErrors: Error[] = [];
      callbackSocket.on("error", (error) => socketErrors.push(error));
      const closed = new Promise<void>((resolve) => {
        callbackSocket.once("close", () => resolve());
      });
      controller.abort();
      await vi.waitFor(() =>
        expect(rejected).toHaveBeenCalledWith(
          expect.objectContaining({ message: "Login cancelled" }),
        ),
      );
      await closed;
      expect(socket.destroyed).toBe(true);
      // Forced callback shutdown may reset a preconnected socket instead of sending FIN.
      for (const error of socketErrors) {
        expect(error).toMatchObject({ code: "ECONNRESET" });
      }
      expect(ssrfMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      events.emit("release");
      await login;
      socket?.destroy();
    }
  });

  it("waits for Node OAuth runtime before creating an authorization flow", async () => {
    const callbackHost = resolveOpenAICallbackHost();
    const flow = await createOpenAIAuthorizationFlow(
      "openclaw-test",
      resolveOpenAIRedirectUri(callbackHost),
    );
    const url = new URL(flow.url);

    expect(flow.state).toMatch(/^[a-f0-9]{32}$/u);
    expect(url.searchParams.get("state")).toBe(flow.state);
    expect(url.searchParams.get("originator")).toBe("openclaw-test");
    const redirectUri = url.searchParams.get("redirect_uri");
    expect(redirectUri).toBeTruthy();
    expect(flow.redirectUri).toBe(redirectUri);
    expect(callbackHost).toBe(new URL(redirectUri ?? "").hostname);
  });

  it("builds callback redirect URIs from the configured loopback host", () => {
    expect(resolveOpenAIRedirectUri("127.0.0.1")).toBe("http://127.0.0.1:1455/auth/callback");
  });

  it("rejects non-loopback callback bind hosts", () => {
    expect(() => resolveOpenAICallbackHost({ OPENCLAW_OAUTH_CALLBACK_HOST: "0.0.0.0" })).toThrow(
      "callback host must be localhost, 127.0.0.1, or ::1",
    );
  });

  it("disconnects callback sockets and cancels stale manual input", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 302 })),
    );
    const testJwt = fakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" },
    });
    mockTokenResponse({
      access_token: testJwt,
      refresh_token: "test-refresh-token",
      expires_in: 3600,
    });
    const agent = new Agent({ keepAlive: true });
    let callbackResponse: Promise<{ headers: IncomingHttpHeaders; body: string }> | undefined;
    let idleSocket: Socket | undefined;
    let manualPromptAborted = false;
    let manualPrompt: Promise<string> | undefined;
    const prompter = {
      note: vi.fn(async () => undefined),
      progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
      text: vi.fn(
        (params: { signal?: AbortSignal }) =>
          new Promise<string>((_resolve, reject) => {
            params.signal?.addEventListener(
              "abort",
              () => {
                manualPromptAborted = true;
                reject(new Error("manual prompt aborted"));
              },
              { once: true },
            );
          }),
      ),
    } as unknown as ProviderAuthContext["prompter"];
    const oauth = {
      createVpsAwareHandlers: vi.fn(
        (params: Parameters<ProviderAuthContext["oauth"]["createVpsAwareHandlers"]>[0]) => ({
          onAuth: async ({ url }: { url: string }) => {
            const authUrl = new URL(url);
            const redirectUri = authUrl.searchParams.get("redirect_uri");
            const state = authUrl.searchParams.get("state");
            if (!redirectUri || !state) {
              throw new Error("OAuth URL missing callback parameters");
            }
            idleSocket = await connectIdleSocket(redirectUri);
            manualPrompt = params.prompter.text({
              message: "Paste callback",
              signal: params.manualPromptSignal,
            });
            callbackResponse = requestCallback(
              `${redirectUri}?state=${state}&code=callback-code`,
              agent,
            );
            await callbackResponse;
          },
          onPrompt: async () => await (manualPrompt ?? Promise.reject(new Error("no prompt"))),
        }),
      ),
    } satisfies ProviderAuthContext["oauth"];

    try {
      await expect(
        loginOpenAICodexOAuth({
          prompter,
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          oauth,
          isRemote: true,
          openUrl: vi.fn(async () => undefined),
        }),
      ).resolves.toMatchObject({ access: testJwt, accountId: "acct-test" });
      if (!callbackResponse) {
        throw new Error("OAuth callback request was not started");
      }
      const response = await callbackResponse;
      expect(response.headers.connection).toBe("close");
      expect(response.body).toContain("OpenAI authentication completed");
      await vi.waitFor(() => expect(manualPromptAborted).toBe(true));
      expect(Object.keys(agent.freeSockets)).toHaveLength(0);
      await vi.waitFor(() => expect(idleSocket?.destroyed).toBe(true));
    } finally {
      idleSocket?.destroy();
      agent.destroy();
    }
  });

  it("times out token exchange requests", async () => {
    ssrfMocks.fetchWithSsrFGuard.mockRejectedValueOnce(timeoutError());

    const result = await exchangeOpenAIAuthorizationCode(
      "code",
      "verifier",
      resolveOpenAIRedirectUri("localhost"),
      { timeoutMs: 5 },
    );

    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        auditContext: "openai-chatgpt-oauth-token",
        timeoutMs: 5,
      }),
    );
    expect(result).toMatchObject({
      type: "failed",
      operation: "exchange",
      summary: "OpenAI Codex token exchange timed out after 5ms",
    });
  });

  it.each([
    { operation: "authorization-code exchange", address: "198.18.0.42", family: 4 as const },
    { operation: "refresh-token exchange", address: "fc00::42", family: 6 as const },
  ])(
    "allows fake-IP DNS for the OpenAI OAuth $operation",
    async ({ operation, address, family }) => {
      mockFakeIpTokenResponse({ address, family });

      const result =
        operation === "authorization-code exchange"
          ? await exchangeOpenAIAuthorizationCode(
              "code",
              "verifier",
              resolveOpenAIRedirectUri("localhost"),
            )
          : await refreshOpenAIAccessToken("old-refresh-token");

      expect(result).toMatchObject({
        type: "success",
        access: "test-access-token",
        refresh: "test-refresh-token",
      });
      expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
        expect.objectContaining({
          policy: {
            allowRfc2544BenchmarkRange: true,
            allowIpv6UniqueLocalRange: true,
            hostnameAllowlist: ["auth.openai.com"],
          },
        }),
      );
    },
  );

  it("cancels token exchange requests with the caller signal", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await exchangeOpenAIAuthorizationCode(
      "code",
      "verifier",
      resolveOpenAIRedirectUri("localhost"),
      { signal: controller.signal, timeoutMs: 5 },
    );

    expect(ssrfMocks.fetchWithSsrFGuard).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      type: "failed",
      cancelled: true,
      operation: "exchange",
      summary: "Login cancelled",
    });
  });

  it("rejects unsafe token exchange lifetimes", async () => {
    mockTokenResponseText(
      '{"access_token":"access-token","refresh_token":"refresh-token","expires_in":1e309}',
    );

    const result = await exchangeOpenAIAuthorizationCode(
      "code",
      "verifier",
      resolveOpenAIRedirectUri("localhost"),
      { timeoutMs: 5 },
    );

    expect(result).toEqual({
      type: "failed",
      operation: "exchange",
      summary: "OpenAI Codex token exchange response missing fields: expires_in",
    });
  });

  it.each([
    {
      operation: "exchange" as const,
      run: () =>
        exchangeOpenAIAuthorizationCode("code", "verifier", resolveOpenAIRedirectUri("localhost")),
    },
    {
      operation: "refresh" as const,
      run: () => refreshOpenAIAccessToken("old-refresh-token"),
    },
  ])(
    "returns a failed result when the token $operation response is malformed JSON",
    async ({ operation, run }) => {
      mockTokenResponseText('{"access_token":"access-token","refresh_to');

      const result = await run();

      expect(result).toEqual({
        type: "failed",
        operation,
        summary: `OpenAI Codex token ${operation} failed: response is not valid JSON`,
      });
    },
  );

  it("times out token refresh requests", async () => {
    ssrfMocks.fetchWithSsrFGuard.mockRejectedValueOnce(timeoutError());

    const result = await refreshOpenAIAccessToken("old-refresh-token", { timeoutMs: 5 });

    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        auditContext: "openai-chatgpt-oauth-token",
        timeoutMs: 5,
      }),
    );
    expect(result).toMatchObject({
      type: "failed",
      operation: "refresh",
      summary: "OpenAI Codex token refresh timed out after 5ms",
    });
  });

  it("rejects non-positive token refresh lifetimes", async () => {
    mockTokenResponse({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 0,
    });

    const result = await refreshOpenAIAccessToken("old-refresh-token", { timeoutMs: 5 });

    expect(result).toEqual({
      type: "failed",
      operation: "refresh",
      summary: "OpenAI Codex token refresh response missing fields: expires_in",
    });
  });

  it("retains the existing refresh token when OpenAI does not rotate it", async () => {
    mockTokenResponse({ access_token: "renewed-access-token", expires_in: 3600 });

    await expect(refreshOpenAIAccessToken("existing-refresh-token")).resolves.toMatchObject({
      type: "success",
      access: "renewed-access-token",
      refresh: "existing-refresh-token",
    });
  });

  it("preserves the shared 30-second token-refresh deadline", async () => {
    mockTokenResponse({
      access_token: "renewed-access-token",
      refresh_token: "rotated-refresh-token",
      expires_in: 3600,
    });

    await refreshOpenAIAccessToken("existing-refresh-token");

    expect(ssrfMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000 }),
    );
  });
});

describe("OpenAI model-account credential ownership", () => {
  it.each([
    { name: "same user and workspace", accountId: "workspace-1", userId: "user-1", matches: true },
    {
      name: "another workspace member",
      accountId: "workspace-1",
      userId: "user-2",
      matches: false,
    },
    {
      name: "the same user in another workspace",
      accountId: "workspace-2",
      userId: "user-1",
      matches: false,
    },
    { name: "missing user claims", accountId: "workspace-1", userId: undefined, matches: false },
  ])(
    "matches $name from token claims, never email or stored workspace metadata",
    ({ accountId, userId, matches }) => {
      const access = fakeJwt({
        "https://api.openai.com/auth": {
          chatgpt_account_id: "workspace-1",
          chatgpt_user_id: "user-1",
        },
        "https://api.openai.com/profile": { email: "same@example.test" },
      });
      const credential: OAuthCredential = {
        type: "oauth",
        provider: "openai",
        access,
        refresh: "synthetic-refresh",
        expires: 1,
      };
      for (const methodId of ["oauth", "device-code"]) {
        const method = buildOpenAIProvider().auth.find((entry) => entry.id === methodId);
        expect(method?.matchesPersonalAccount).toBeTypeOf("function");
        expect(
          method?.matchesPersonalAccount?.(credential, {
            ...credential,
            // Identical stored metadata must not substitute for the actual token identity.
            accountId: "workspace-1",
            access: fakeJwt({
              "https://api.openai.com/auth": {
                chatgpt_account_id: accountId,
                chatgpt_user_id: userId,
              },
              "https://api.openai.com/profile": { email: "same@example.test" },
            }),
          }),
        ).toBe(matches);
      }
    },
  );

  it("refuses to replace any prior credential without an incoming user claim", () => {
    const credential: OAuthCredential = {
      type: "oauth",
      provider: "openai",
      access: fakeJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "workspace-1" },
      }),
      refresh: "synthetic-refresh",
      expires: 1,
    };
    for (const methodId of ["oauth", "device-code"]) {
      const method = buildOpenAIProvider().auth.find((entry) => entry.id === methodId);
      expect(method?.matchesPersonalAccount).toBeTypeOf("function");
      expect(method?.matchesPersonalAccount?.(credential, credential)).toBe(false);
    }
  });
});

async function listenLoopbackServer(server: Server): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

describe("OpenAI Codex OAuth bounded token response reads", () => {
  it("retains an unrotated refresh token from a real loopback HTTP response", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "loopback-renewed-access", expires_in: 3600 }));
    });
    const port = await listenLoopbackServer(server);
    const release = vi.fn(async () => undefined);

    try {
      ssrfMocks.fetchWithSsrFGuard.mockImplementationOnce(async ({ init, signal }) => ({
        response: await globalThis.fetch(`http://127.0.0.1:${port}`, { ...init, signal }),
        release,
      }));

      await expect(refreshOpenAIAccessToken("loopback-existing-refresh")).resolves.toMatchObject({
        type: "success",
        access: "loopback-renewed-access",
        refresh: "loopback-existing-refresh",
      });
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await closeServer(server);
    }
  });

  it.each([
    { operation: "exchange", envelope: "null", value: null },
    { operation: "exchange", envelope: "array", value: [] },
    { operation: "refresh", envelope: "null", value: null },
    { operation: "refresh", envelope: "array", value: [] },
  ] as const)(
    "rejects $envelope $operation token responses from a real loopback HTTP server",
    async ({ operation, value }) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      });
      const port = await listenLoopbackServer(server);
      const release = vi.fn(async () => undefined);

      try {
        ssrfMocks.fetchWithSsrFGuard.mockImplementation(async ({ init, signal }) => {
          const response = await globalThis.fetch(`http://127.0.0.1:${port}`, {
            ...init,
            signal,
          });
          return { response, release };
        });

        const result =
          operation === "exchange"
            ? await exchangeOpenAIAuthorizationCode(
                "code-loopback",
                "verifier-loopback",
                "http://localhost:1455/auth/callback",
              )
            : await refreshOpenAIAccessToken("refresh-token-loopback");

        expect(result).toEqual({
          type: "failed",
          operation,
          summary: `OpenAI Codex token ${operation} failed: expected JSON object response`,
        });
        expect(release).toHaveBeenCalledOnce();
      } finally {
        await closeServer(server);
      }
    },
  );

  it("reads under-cap token exchange responses from a real loopback HTTP server", async () => {
    const validPayload = {
      access_token: "access-token-loopback",
      refresh_token: "refresh-token-loopback",
      expires_in: 3600,
    };
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(validPayload));
    });
    const port = await listenLoopbackServer(server);
    const release = vi.fn(async () => undefined);

    try {
      ssrfMocks.fetchWithSsrFGuard.mockImplementation(async ({ init, signal }) => {
        const response = await globalThis.fetch(`http://127.0.0.1:${port}`, {
          ...init,
          signal,
        });
        return { response, release };
      });

      const result = await exchangeOpenAIAuthorizationCode(
        "code-loopback",
        "verifier-loopback",
        "http://localhost:1455/auth/callback",
        { timeoutMs: 5000 },
      );

      expect(result).toMatchObject({
        type: "success",
        access: "access-token-loopback",
        refresh: "refresh-token-loopback",
      });
      expect(
        (result as { type: "success"; access: string; refresh: string; expires: number }).expires,
      ).toBeGreaterThan(0);
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await closeServer(server);
    }
  });

  it("rejects oversized token exchange responses from a real loopback HTTP server", async () => {
    const oversizedPayload = "o".repeat(2 * 1024 * 1024); // 2 MiB > 1 MiB cap
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(oversizedPayload);
    });
    const port = await listenLoopbackServer(server);
    const release = vi.fn(async () => undefined);

    try {
      ssrfMocks.fetchWithSsrFGuard.mockImplementation(async ({ init, signal }) => {
        const response = await globalThis.fetch(`http://127.0.0.1:${port}`, {
          ...init,
          signal,
        });
        return { response, release };
      });

      const result = await exchangeOpenAIAuthorizationCode(
        "code-loopback",
        "verifier-loopback",
        "http://localhost:1455/auth/callback",
        { timeoutMs: 5000 },
      );

      expect(result).toMatchObject({ type: "failed" });
      expect((result as { type: "failed"; summary: string }).summary).toContain("too large");
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await closeServer(server);
    }
  });
});
