// Xai tests cover xai oauth plugin behavior.
import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createRuntimeEnv,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createXaiDeviceCodeAuthMethod,
  createXaiOAuthAuthMethod,
  refreshXaiOAuthCredential,
} from "./xai-oauth.js";

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

describe("xAI OAuth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

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
    const credential = {
      type: "oauth",
      provider: "xai",
      access: "access-1",
      refresh: "refresh-1",
      expires: 100,
      tokenEndpoint: "https://auth.x.ai/oauth/token",
    } satisfies OAuthCredential & { tokenEndpoint: string };

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

    const credential = {
      type: "oauth",
      provider: "xai",
      access: "access-1",
      refresh: "refresh-1",
      expires: 100,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    } satisfies OAuthCredential & { tokenEndpoint: string };
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
    const credential = {
      type: "oauth",
      provider: "xai",
      access: "access-1",
      refresh: "refresh-1",
      expires: 100,
      tokenEndpoint: "https://auth.x.ai/oauth/token",
    } satisfies OAuthCredential & { tokenEndpoint: string };

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
    const credential = {
      type: "oauth",
      provider: "xai",
      access: "access-1",
      refresh: "refresh-1",
      expires: 100,
      tokenEndpoint: "https://auth.x.ai/oauth/token",
    } satisfies OAuthCredential & { tokenEndpoint: string };

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
    const credential = {
      type: "oauth",
      provider: "xai",
      access: "access-1",
      refresh: "refresh-1",
      expires: 100,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    } satisfies OAuthCredential & { tokenEndpoint: string };

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
    const credential = {
      type: "oauth",
      provider: "xai",
      access: "access-1",
      refresh: "refresh-1",
      expires: 100,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    } satisfies OAuthCredential & { tokenEndpoint: string };

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
    const credential = {
      type: "oauth",
      provider: "xai",
      access: "access-1",
      refresh: "refresh-1",
      expires: 100,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    } satisfies OAuthCredential & { tokenEndpoint: string };

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
    const credential = {
      type: "oauth",
      provider: "xai",
      access: "access-1",
      refresh: "refresh-1",
      expires: 100,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    } satisfies OAuthCredential & { tokenEndpoint: string };

    await expect(refreshXaiOAuthCredential(credential, { fetchImpl })).rejects.toThrow(
      "server_error (try again later)",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry refresh on transport errors so a rotated refresh token is never resent", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("socket hang up");
    });
    const credential = {
      type: "oauth",
      provider: "xai",
      access: "access-1",
      refresh: "refresh-1",
      expires: 100,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    } satisfies OAuthCredential & { tokenEndpoint: string };

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
    const credential = {
      type: "oauth",
      provider: "xai",
      access: "access-1",
      refresh: "refresh-1",
      expires: 100,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    } satisfies OAuthCredential & { tokenEndpoint: string };

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
    const credential = {
      type: "oauth",
      provider: "xai",
      access: "access-1",
      refresh: "refresh-1",
      expires: 100,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    } satisfies OAuthCredential & { tokenEndpoint: string };

    const refreshed = await refreshXaiOAuthCredential(credential, { fetchImpl, now: () => 1_000 });

    expect(refreshed.expires).toBe(100);
  });

  it("ignores unsafe JWT expiry fallbacks from xAI access tokens", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        access_token: createJwt({ exp: Number.MAX_SAFE_INTEGER }),
      }),
    );
    const credential = {
      type: "oauth",
      provider: "xai",
      access: "access-1",
      refresh: "refresh-1",
      expires: 100,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    } satisfies OAuthCredential & { tokenEndpoint: string };

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
