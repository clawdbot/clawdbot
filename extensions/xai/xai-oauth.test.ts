// Xai tests cover xai oauth plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createRuntimeEnv,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { withProxyFixture } from "openclaw/plugin-sdk/test-env";
import { fetch as undiciFetch, MockAgent, type Dispatcher } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createXaiDeviceCodeAuthMethod, createXaiOAuthAuthMethod } from "./xai-oauth-entry.js";
import { refreshXaiOAuthCredential } from "./xai-oauth.js";

const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const XAI_OAUTH_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function requireStringBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") {
    throw new Error("expected request body to be a string");
  }
  return init.body;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function createXaiOAuthCredential(
  tokenEndpoint = "https://auth.x.ai/oauth2/token",
): OAuthCredential & { tokenEndpoint: string } {
  return {
    type: "oauth",
    provider: "xai",
    access: "access-1",
    refresh: "refresh-1",
    expires: 100,
    tokenEndpoint,
  };
}

describe("xAI OAuth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it.each([
    { proxy: "http_proxy", noProxy: "" },
    { proxy: "https_proxy", noProxy: "" },
    { proxy: "all_proxy", noProxy: "" },
    { proxy: "http_proxy", noProxy: "auth.x.ai" },
    { proxy: "https_proxy", noProxy: "auth.x.ai" },
    { proxy: "all_proxy", noProxy: "auth.x.ai" },
    { proxy: "all_proxy", noProxy: "", socks: true },
    { proxy: "all_proxy", noProxy: "auth.x.ai", socks: true },
  ])("preserves $proxy routing with no_proxy=$noProxy", async ({ proxy, noProxy, socks }) => {
    await withProxyFixture(async (fixture) => {
      const proxyUrl = socks ? fixture.socksProxy : fixture.httpProxy;
      for (const key of ["http_proxy", "https_proxy", "all_proxy"]) {
        vi.stubEnv(key, key === proxy ? proxyUrl : "");
      }
      vi.stubEnv("no_proxy", noProxy);
      const fetchImpl = vi.fn<typeof fetch>(
        async (input, init?: RequestInit & { dispatcher?: Dispatcher }) => {
          expect(requestUrl(input)).toBe("https://auth.x.ai/oauth2/token");
          expect(init?.method).toBe("POST");
          if (noProxy) {
            expect(init).not.toHaveProperty("dispatcher");
          } else {
            if (!init?.dispatcher) {
              throw new Error("expected proxy dispatcher");
            }
            // The loopback fixture records this exact destination and refuses it
            // before opening any upstream socket; no OAuth traffic leaves the host.
            await expect(
              undiciFetch(requestUrl(input), {
                method: init.method,
                body: requireStringBody(init),
                headers: Object.fromEntries(new Headers(init.headers)),
                redirect: init.redirect,
                signal: init.signal,
                dispatcher: init.dispatcher,
              }),
            ).rejects.toMatchObject({
              cause: { code: socks ? "UND_ERR_SOCKS5_REPLY_2" : "UND_ERR_PRX_CONN" },
            });
          }
          return jsonResponse({ error: "temporarily_unavailable" }, { status: 503 });
        },
      );
      await expect(
        refreshXaiOAuthCredential(createXaiOAuthCredential(), { fetchImpl }),
      ).rejects.toThrow("temporarily_unavailable");
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fixture.connections).toEqual(noProxy ? [] : [`${socks ? "socks" : "http"}:auth.x.ai`]);
      expect(fixture.originRoutes).toEqual([]);
      await fixture.waitForSocketsClosed();
    });
  });

  it("revalidates live authority before following an OAuth redirect", async () => {
    const transport = new MockAgent();
    transport.disableNetConnect();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const response = await undiciFetch(requestUrl(input), {
        method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers)),
        redirect: init?.redirect,
        signal: init?.signal,
        dispatcher: transport,
      });
      return new Response(await response.arrayBuffer(), {
        status: response.status,
        headers: Object.fromEntries(response.headers),
      });
    });
    vi.stubGlobal("fetch", fetchImpl);
    const held = createDeferred<void>();
    const release = createDeferred<void>();
    const controller = new AbortController();
    let current = true;
    const origin = transport.get("https://auth.x.ai");
    origin.intercept({ path: "/.well-known/openid-configuration" }).reply(async () => {
      held.resolve();
      await release.promise;
      return { statusCode: 302, responseOptions: { headers: { location: "/retired" } } };
    });
    const redirected = vi.fn(() => ({ statusCode: 403, data: "denied" }));
    origin.intercept({ path: "/retired" }).reply(redirected);
    const outcome = createXaiOAuthAuthMethod()
      .run({
        config: {},
        isRemote: true,
        openUrl: async () => {},
        prompter: createTestWizardPrompter(),
        runtime: createRuntimeEnv(),
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("owner retired");
          }
        },
        oauth: {
          createVpsAwareHandlers: () => {
            throw new Error("unexpected browser flow");
          },
        },
      })
      .catch((error: unknown) => error);
    try {
      await Promise.race([
        held.promise,
        outcome.then((error) => {
          throw new Error("login ended before the held redirect", { cause: error });
        }),
      ]);
      current = false;
      release.resolve();
      const error = await outcome;
      expect(redirected).not.toHaveBeenCalled();
      expect(transport.pendingInterceptors()).toEqual([
        expect.objectContaining({ path: "/retired" }),
      ]);
      expect(error).toMatchObject({ message: expect.stringContaining("owner retired") });
      expect(fetchImpl).toHaveBeenCalledWith(
        XAI_OAUTH_DISCOVERY_URL,
        expect.objectContaining({
          redirect: "manual",
          signal: expect.any(AbortSignal),
        }),
      );
      expect(controller.signal.aborted).toBe(false);
    } finally {
      controller.abort();
      release.resolve();
      await outcome;
      await transport.close();
    }
  });

  it.each([
    { boundary: "discovery response", requests: 1 },
    { boundary: "device prompt", requests: 2 },
    { boundary: "pending poll", requests: 3 },
  ])(
    "revalidates live authority after held $boundary before another request",
    async ({ boundary, requests }) => {
      if (boundary === "pending poll") {
        vi.useFakeTimers();
      }
      const held = createDeferred<void>();
      const release = createDeferred<void>();
      const controller = new AbortController();
      let current = true;
      let polls = 0;
      const hold = async () => {
        held.resolve();
        await release.promise;
      };
      const fetchImpl = vi.fn<typeof fetch>(async (input) => {
        const url = requestUrl(input);
        if (url === XAI_OAUTH_DISCOVERY_URL) {
          if (boundary === "discovery response") {
            await hold();
          }
          return jsonResponse({
            device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
            token_endpoint: "https://auth.x.ai/oauth2/token",
          });
        }
        if (url.endsWith("/device/code")) {
          return jsonResponse({
            device_code: "device",
            user_code: "CODE",
            verification_uri: "https://auth.x.ai/device",
            expires_in: 60,
            interval: 1,
          });
        }
        polls += 1;
        if (boundary === "pending poll" && polls === 1) {
          await hold();
          return jsonResponse({ error: "authorization_pending" }, { status: 400 });
        }
        return jsonResponse({ access_token: "access", refresh_token: "refresh", expires_in: 60 });
      });
      vi.stubGlobal("fetch", fetchImpl);
      const ctx: ProviderAuthContext = {
        config: {},
        isRemote: true,
        openUrl: async () => {},
        runtime: createRuntimeEnv(),
        signal: controller.signal,
        assertCurrent: () => {
          if (!current) {
            throw new Error("owner retired");
          }
        },
        prompter: createTestWizardPrompter({
          deviceCode: async () => {
            if (boundary === "device prompt") {
              await hold();
            }
          },
        }),
        oauth: {
          createVpsAwareHandlers: () => {
            throw new Error("unexpected browser flow");
          },
        },
      };
      const outcome = createXaiOAuthAuthMethod()
        .run(ctx)
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      try {
        await held.promise;
        current = false;
        release.resolve();
        if (boundary === "pending poll") {
          await vi.advanceTimersByTimeAsync(1_000);
        }
        const result = await outcome;
        expect(fetchImpl).toHaveBeenCalledTimes(requests);
        expect(result).toEqual({
          error: expect.objectContaining({ message: expect.stringContaining("owner retired") }),
        });
        expect(controller.signal.aborted).toBe(false);
      } finally {
        controller.abort();
        release.resolve();
        await outcome;
      }
    },
  );

  it("keeps the public auth method named OAuth while using device code", () => {
    const method = createXaiOAuthAuthMethod();

    expect(method.id).toBe("oauth");
    expect(method.kind).toBe("oauth");
    expect(method.wizard?.choiceId).toBe("xai-oauth");
    expect(method.wizard?.methodId).toBe("oauth");
  });

  it("preserves device-code as an explicit auth method alias", () => {
    const method = createXaiDeviceCodeAuthMethod();

    expect(method.id).toBe("device-code");
    expect(method.kind).toBe("device_code");
    expect(method.wizard?.choiceId).toBe("xai-device-code");
    expect(method.wizard?.methodId).toBe("device-code");
    expect(method.wizard?.assistantVisibility).toBe("manual-only");
  });

  it("rejects untrusted discovered endpoints through credential refresh", async () => {
    const poisonedFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
        token_endpoint: "https://evil.test/oauth2/token",
      }),
    );
    const credential = createXaiOAuthCredential("https://auth.x.ai/oauth/token");

    await expect(
      refreshXaiOAuthCredential(credential, { fetchImpl: poisonedFetch }),
    ).rejects.toThrow("untrusted token endpoint");
  });

  it("refreshes with the cached token endpoint and preserves refresh fallback", async () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      expect(init?.method).toBe("POST");
      expect(typeof init?.body).toBe("string");
      const body = requireStringBody(init);
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain(`client_id=${encodeURIComponent(XAI_OAUTH_CLIENT_ID)}`);
      expect(body).toContain("refresh_token=refresh-1");
      const headers = new Headers(init?.headers ?? {});
      expect(headers.get("user-agent")).toBe("openclaw/2026.3.22");
      return jsonResponse({
        access_token: "access-2",
        expires_in: 120,
      });
    });

    const credential = createXaiOAuthCredential();
    const refreshed = await refreshXaiOAuthCredential(credential, { fetchImpl, now: () => 1_000 });

    expect(fetchImpl).toHaveBeenCalledWith("https://auth.x.ai/oauth2/token", expect.any(Object));
    expect(refreshed.access).toBe("access-2");
    expect(refreshed.refresh).toBe("refresh-1");
    expect(refreshed.expires).toBe(121_000);
  });

  it("rediscovers the current token endpoint for stale xAI OAuth credentials", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (requestUrl(url) === XAI_OAUTH_DISCOVERY_URL) {
        expect(init?.method).toBeUndefined();
        return jsonResponse({
          authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
          token_endpoint: "https://auth.x.ai/oauth2/token",
        });
      }
      expect(requestUrl(url)).toBe("https://auth.x.ai/oauth2/token");
      expect(init?.method).toBe("POST");
      expect(requireStringBody(init)).toContain("refresh_token=refresh-1");
      return jsonResponse({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 120,
      });
    });
    const credential = createXaiOAuthCredential("https://auth.x.ai/oauth/token");

    const refreshed = await refreshXaiOAuthCredential(credential, { fetchImpl, now: () => 1_000 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => requestUrl(url))).toEqual([
      XAI_OAUTH_DISCOVERY_URL,
      "https://auth.x.ai/oauth2/token",
    ]);
    expect(refreshed).toMatchObject({
      access: "access-2",
      refresh: "refresh-2",
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    });
  });

  it("does not reuse the stale xAI OAuth token endpoint when discovery fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      expect(requestUrl(url)).toBe(XAI_OAUTH_DISCOVERY_URL);
      throw new Error("discovery unavailable");
    });
    const credential = createXaiOAuthCredential("https://auth.x.ai/oauth/token");

    await expect(refreshXaiOAuthCredential(credential, { fetchImpl })).rejects.toThrow(
      "discovery unavailable",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries transient HTML refresh failures before succeeding", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("<!DOCTYPE html><html><body>Attention Required! Cloudflare</body></html>", {
          status: 403,
          headers: {
            "Content-Type": "text/html",
            "cf-mitigated": "challenge",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response("<!DOCTYPE html><html><body>Just a moment...</body></html>", {
          status: 403,
          headers: {
            "Content-Type": "text/html",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "access-2",
          expires_in: 120,
        }),
      );
    const credential = createXaiOAuthCredential();

    const refresh = refreshXaiOAuthCredential(credential, { fetchImpl, now: () => 1_000 });
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(250);
    const refreshed = await refresh;

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(refreshed.access).toBe("access-2");
    expect(refreshed.refresh).toBe("refresh-1");
  });

  it("surfaces xAI Cloudflare refresh failures after retry exhaustion", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          "<!DOCTYPE html><html><head><title>Attention Required! | Cloudflare</title></head><body>You are unable to access x.ai</body></html>",
          {
            status: 403,
            headers: {
              "Content-Type": "text/html",
              "cf-mitigated": "challenge",
            },
          },
        ),
    );
    const credential = createXaiOAuthCredential();

    const refresh = refreshXaiOAuthCredential(credential, { fetchImpl, now: () => 1_000 });
    const expectation = expect(refresh).rejects.toThrow(
      "xAI returned an HTML/Cloudflare challenge",
    );
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(250);

    await expectation;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("does not retry terminal xAI OAuth refresh errors", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          error: "invalid_grant",
          error_description: "Invalid or unknown refresh token",
        },
        { status: 400 },
      ),
    );
    const credential = createXaiOAuthCredential();

    await expect(refreshXaiOAuthCredential(credential, { fetchImpl })).rejects.toThrow(
      "invalid_grant (Invalid or unknown refresh token)",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry refresh-token service failures", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(
        {
          error: "server_error",
          error_description: "try again later",
        },
        { status: 503 },
      ),
    );
    const credential = createXaiOAuthCredential();

    await expect(refreshXaiOAuthCredential(credential, { fetchImpl })).rejects.toThrow(
      "server_error (try again later)",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry refresh on transport errors so a rotated refresh token is never resent", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("socket hang up");
    });
    const credential = createXaiOAuthCredential();

    await expect(refreshXaiOAuthCredential(credential, { fetchImpl })).rejects.toThrow(
      "socket hang up",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not coerce partial xAI expires_in values", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        access_token: "access-2",
        expires_in: "120s",
      }),
    );
    const credential = createXaiOAuthCredential();

    const refreshed = await refreshXaiOAuthCredential(credential, { fetchImpl, now: () => 1_000 });

    expect(refreshed.expires).toBe(100);
  });

  it("preserves the cached xAI expiry when token lifetimes overflow safe milliseconds", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        access_token: createJwt({ exp: Number.MAX_SAFE_INTEGER }),
        expires_in: Number.MAX_SAFE_INTEGER,
      }),
    );
    const credential = createXaiOAuthCredential();

    const refreshed = await refreshXaiOAuthCredential(credential, { fetchImpl, now: () => 1_000 });

    expect(refreshed.expires).toBe(100);
  });

  it("ignores unsafe JWT expiry fallbacks from xAI access tokens", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        access_token: createJwt({ exp: Number.MAX_SAFE_INTEGER }),
      }),
    );
    const credential = createXaiOAuthCredential();

    const refreshed = await refreshXaiOAuthCredential(credential, { fetchImpl, now: () => 1_000 });

    expect(refreshed.expires).toBe(100);
  });

  it("logs in with xAI device code without a localhost callback", async () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const progress = {
      update: vi.fn(),
      stop: vi.fn(),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
          device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
          token_endpoint: "https://auth.x.ai/oauth2/token",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          device_code: "device-code-1",
          user_code: "ABCD-1234",
          verification_uri: "https://accounts.x.ai/oauth2/device",
          verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234",
          expires_in: 900,
          interval: 5,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: createJwt({ exp: 4, sub: "acct-1" }),
          refresh_token: "refresh-1",
          id_token: createJwt({
            sub: "acct-1",
            email: "dev@example.com",
            name: "Dev User",
          }),
          expires_in: 120,
        }),
      );
    vi.stubGlobal("fetch", fetchImpl);
    const deviceCode = vi.fn(async () => {});
    const openUrl = vi.fn(async () => {});
    const log = vi.fn();
    const runtime = { ...createRuntimeEnv(), log };
    const ctx: ProviderAuthContext = {
      config: {},
      isRemote: true,
      openUrl,
      prompter: createTestWizardPrompter({
        progress: vi.fn(() => progress),
        deviceCode,
      }),
      runtime,
      oauth: {
        createVpsAwareHandlers: () => {
          throw new Error("unexpected VPS OAuth handler request");
        },
      },
    };

    const result = await createXaiOAuthAuthMethod().run(ctx);

    expect(openUrl).toHaveBeenCalledWith("https://accounts.x.ai/oauth2/device?user_code=ABCD-1234");
    expect(deviceCode).toHaveBeenCalledWith({
      title: "xAI OAuth",
      code: "ABCD-1234",
      expiresInMinutes: 15,
      message: "Enter this one-time code on the xAI sign-in page.",
    });
    expect(openUrl.mock.invocationCallOrder[0]).toBeLessThan(
      deviceCode.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    const remoteLog = log.mock.calls[0]?.[0];
    expect(remoteLog).toContain("https://accounts.x.ai/oauth2/device");
    expect(remoteLog).not.toContain("ABCD-1234");
    const deviceRequest = fetchImpl.mock.calls[1]?.[1];
    expect(deviceRequest?.method).toBe("POST");
    const deviceBody = requireStringBody(deviceRequest);
    expect(deviceBody).toContain(`client_id=${encodeURIComponent(XAI_OAUTH_CLIENT_ID)}`);
    expect(deviceBody).toContain(`scope=${encodeURIComponent(XAI_OAUTH_SCOPE)}`);

    const tokenRequest = fetchImpl.mock.calls[2]?.[1];
    expect(tokenRequest?.method).toBe("POST");
    const tokenBody = requireStringBody(tokenRequest);
    expect(tokenBody).toContain(
      "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code",
    );
    expect(tokenBody).toContain("device_code=device-code-1");

    expect(result.profiles[0]?.credential).toMatchObject({
      type: "oauth",
      provider: "xai",
      refresh: "refresh-1",
      email: "dev@example.com",
      displayName: "Dev User",
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
      deviceAuthorizationEndpoint: "https://auth.x.ai/oauth2/device/code",
      issuer: "https://auth.x.ai",
      authFlow: "device-code",
      accountId: "acct-1",
      access: expect.any(String),
    });
    expect(result.defaultModel).toBe("xai/auto");
    expect(result.configPatch?.agents?.defaults?.model).toEqual({
      primary: "xai/auto",
    });
    expect(result.configPatch?.agents?.defaults?.models?.["xai/auto"]?.alias).toBe("Grok");
    expect(progress.update).toHaveBeenCalledWith("Waiting for xAI device authorization...");
    expect(progress.stop).toHaveBeenCalledWith("xAI OAuth complete");
  });

  it("falls back for unsafe xAI device-code lifetime fields", async () => {
    const progress = {
      update: vi.fn(),
      stop: vi.fn(),
    };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
          device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
          token_endpoint: "https://auth.x.ai/oauth2/token",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          device_code: "device-code-1",
          user_code: "ABCD-1234",
          verification_uri: "https://accounts.x.ai/oauth2/device",
          expires_in: Number.MAX_SAFE_INTEGER,
          interval: Number.MAX_SAFE_INTEGER,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "access-token",
          refresh_token: "refresh-1",
          expires_in: 120,
        }),
      );
    vi.stubGlobal("fetch", fetchImpl);
    const note = vi.fn<(message: string, title?: string) => Promise<void>>(async () => {});
    const ctx: ProviderAuthContext = {
      config: {},
      isRemote: true,
      openUrl: vi.fn(async () => {}),
      prompter: createTestWizardPrompter({
        progress: vi.fn(() => progress),
        note,
      }),
      runtime: createRuntimeEnv(),
      oauth: {
        createVpsAwareHandlers: () => {
          throw new Error("unexpected VPS OAuth handler request");
        },
      },
    };

    await createXaiOAuthAuthMethod().run(ctx);

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Code expires in 5 minutes."),
      "xAI OAuth",
    );
    expect(progress.stop).toHaveBeenCalledWith("xAI OAuth complete");
  });
});
