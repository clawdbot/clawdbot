// Openai tests cover openai chatgpt oauth flow plugin behavior.
import { Agent, createServer, get, type IncomingHttpHeaders, type Server } from "node:http";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
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
import { loginOpenAICodex } from "./openai-chatgpt-oauth-flow.runtime.js";
import {
  exchangeOpenAIAuthorizationCode,
  refreshOpenAIAccessToken,
} from "./openai-chatgpt-oauth-token.runtime.js";
import { loginOpenAICodexOAuth } from "./openai-chatgpt-oauth.runtime.js";

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

function requestCallback(
  url: string,
  agent: Agent,
): Promise<{ headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = get(url, { agent }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolve({ headers: response.headers, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    request.on("error", reject);
  });
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

  it("disconnects a keep-alive callback and cancels stale manual input", async () => {
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
    } finally {
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
      message: "OpenAI Codex token exchange timed out after 5ms",
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
      message: "Login cancelled",
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
      message: "OpenAI Codex token exchange response missing fields: expires_in",
    });
  });

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
      message: "OpenAI Codex token refresh timed out after 5ms",
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
      message: "OpenAI Codex token refresh response missing fields: expires_in",
    });
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
      expect((result as { type: "failed"; message: string }).message).toContain("too large");
      expect(release).toHaveBeenCalledOnce();
    } finally {
      await closeServer(server);
    }
  });
});
