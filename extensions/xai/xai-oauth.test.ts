import type { ProviderAuthContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createRuntimeEnv,
  createTestWizardPrompter,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { OAuthCredential } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const waitForLocalOAuthCallbackMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  waitForLocalOAuthCallback: waitForLocalOAuthCallbackMock,
}));

import {
  buildXaiOAuthAuthorizationCodeTokenBody,
  buildXaiOAuthAuthorizeUrl,
  fetchXaiOAuthDiscovery,
  isTrustedXaiOAuthEndpoint,
  loginXaiDeviceCode,
  loginXaiOAuth,
  refreshXaiOAuthCredential,
  XAI_OAUTH_CALLBACK_CORS_ORIGIN_ALLOWLIST,
  XAI_OAUTH_CALLBACK_HOST,
  XAI_OAUTH_CALLBACK_PORT,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_DISCOVERY_URL,
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

function stubSuccessfulXaiOAuthNetwork(): void {
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    if (requestUrl(url) === XAI_OAUTH_DISCOVERY_URL) {
      return jsonResponse({
        authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
        token_endpoint: "https://auth.x.ai/oauth2/token",
      });
    }

    expect(requestUrl(url)).toBe("https://auth.x.ai/oauth2/token");
    expect(init?.method).toBe("POST");
    expect(requireStringBody(init)).toContain("code=AUTHCODE");
    return jsonResponse({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
    });
  });
  vi.stubGlobal("fetch", fetchImpl);
}

describe("xAI OAuth", () => {
  beforeEach(() => {
    waitForLocalOAuthCallbackMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("accepts only trusted xAI OAuth endpoints", () => {
    expect(isTrustedXaiOAuthEndpoint("https://auth.x.ai/oauth2/token")).toBe(true);
    expect(isTrustedXaiOAuthEndpoint("https://accounts.x.ai/oauth2/token")).toBe(true);
    expect(isTrustedXaiOAuthEndpoint("http://auth.x.ai/oauth2/token")).toBe(false);
    expect(isTrustedXaiOAuthEndpoint("https://x.ai.evil.test/oauth2/token")).toBe(false);
    expect(isTrustedXaiOAuthEndpoint("not a url")).toBe(false);
  });

  it("exposes the loopback CORS origin allowlist that loginXaiOAuth threads to the SDK helper", () => {
    expect([...XAI_OAUTH_CALLBACK_CORS_ORIGIN_ALLOWLIST]).toEqual(["auth.x.ai", "accounts.x.ai"]);
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

  it("echoes PKCE challenge fields when exchanging authorization codes with xAI", () => {
    expect(
      buildXaiOAuthAuthorizationCodeTokenBody({
        code: "AUTHCODE",
        codeVerifier: "verifier-1",
        codeChallenge: "challenge-1",
      }),
    ).toEqual({
      grant_type: "authorization_code",
      code: "AUTHCODE",
      redirect_uri: XAI_OAUTH_REDIRECT_URI,
      client_id: XAI_OAUTH_CLIENT_ID,
      code_verifier: "verifier-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
    });
  });

  it("validates discovered endpoints before using them", async () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
        token_endpoint: "https://auth.x.ai/oauth2/token",
      }),
    );

    await expect(fetchXaiOAuthDiscovery({ fetchImpl })).resolves.toEqual({
      authorizationEndpoint: "https://auth.x.ai/oauth2/authorize",
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    });

    const discoveryInit = fetchImpl.mock.calls.at(0)?.[1];
    const discoveryHeaders = new Headers(discoveryInit?.headers ?? {});
    expect(discoveryHeaders.get("user-agent")).toBe("openclaw/2026.3.22");
    vi.unstubAllEnvs();

    const poisonedFetch = vi.fn<typeof fetch>(async () =>
      jsonResponse({
        authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
        token_endpoint: "https://evil.test/oauth2/token",
      }),
    );

    await expect(fetchXaiOAuthDiscovery({ fetchImpl: poisonedFetch })).rejects.toThrow(
      "untrusted token endpoint",
    );
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

  it("prints the authorize URL through plain prompter output so terminal link detection keeps it whole", async () => {
    waitForLocalOAuthCallbackMock.mockResolvedValue({ code: "AUTHCODE", state: "state-1" });
    stubSuccessfulXaiOAuthNetwork();

    const progress = { update: vi.fn(), stop: vi.fn() };
    const note = vi.fn<(message: string, title?: string) => Promise<void>>(async () => undefined);
    const plain = vi.fn<(message: string) => Promise<void>>(async () => undefined);
    const openUrl = vi.fn<(url: string) => Promise<void>>(async () => undefined);
    const runtimeLog = vi.fn<(message: string) => void>();
    const ctx = {
      config: {},
      isRemote: true,
      openUrl,
      prompter: {
        note,
        plain,
        progress: vi.fn(() => progress),
      },
      runtime: {
        log: runtimeLog,
        error: vi.fn(),
        exit: vi.fn(),
      },
      oauth: { createVpsAwareHandlers: vi.fn() },
    } as unknown as ProviderAuthContext;

    await loginXaiOAuth(ctx);

    expect(openUrl).not.toHaveBeenCalled();
    const noteMessage = note.mock.calls[0]?.[0] ?? "";
    expect(noteMessage).toContain("Open this xAI OAuth URL in your browser:");
    expect(noteMessage).toContain(
      `ssh -N -L ${XAI_OAUTH_CALLBACK_PORT}:${XAI_OAUTH_CALLBACK_HOST}:${XAI_OAUTH_CALLBACK_PORT} <host>`,
    );
    expect(noteMessage).not.toContain("https://auth.x.ai/oauth2/authorize");

    const plainOutput = plain.mock.calls[0]?.[0] ?? "";
    expect(plainOutput.trim()).toMatch(/^https:\/\/auth\.x\.ai\/oauth2\/authorize\?/);
    expect(plainOutput).toContain(`client_id=${encodeURIComponent(XAI_OAUTH_CLIENT_ID)}`);
    expect(plainOutput).toContain("code_challenge=");
    expect(runtimeLog).not.toHaveBeenCalled();
    expect(progress.stop).toHaveBeenCalledWith("xAI OAuth complete");
  });

  it("keeps the authorize URL visible for prompters without plain output", async () => {
    waitForLocalOAuthCallbackMock.mockResolvedValue({ code: "AUTHCODE", state: "state-1" });
    stubSuccessfulXaiOAuthNetwork();

    const progress = { update: vi.fn(), stop: vi.fn() };
    const note = vi.fn<(message: string, title?: string) => Promise<void>>(async () => undefined);
    const openUrl = vi.fn<(url: string) => Promise<void>>(async () => undefined);
    const runtimeLog = vi.fn<(message: string) => void>();
    const ctx = {
      config: {},
      isRemote: false,
      openUrl,
      prompter: {
        note,
        progress: vi.fn(() => progress),
      },
      runtime: {
        log: runtimeLog,
        error: vi.fn(),
        exit: vi.fn(),
      },
      oauth: { createVpsAwareHandlers: vi.fn() },
    } as unknown as ProviderAuthContext;

    await loginXaiOAuth(ctx);

    const authorizeUrl = openUrl.mock.calls[0]?.[0] ?? "";
    const noteMessage = note.mock.calls[0]?.[0] ?? "";
    expect(authorizeUrl).toContain("https://auth.x.ai/oauth2/authorize?");
    expect(noteMessage).toContain("Open this xAI OAuth URL in your browser:");
    expect(noteMessage).not.toContain(authorizeUrl);
    expect(runtimeLog.mock.calls[0]?.[0] ?? "").toContain(authorizeUrl);
    expect(progress.stop).toHaveBeenCalledWith("xAI OAuth complete");
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
    const note = vi.fn(async () => {});
    const openUrl = vi.fn(async () => {});
    const log = vi.fn();
    const runtime = { ...createRuntimeEnv(), log };
    const ctx: ProviderAuthContext = {
      config: {},
      isRemote: true,
      openUrl,
      prompter: createTestWizardPrompter({
        progress: vi.fn(() => progress),
        note,
      }),
      runtime,
      oauth: {
        createVpsAwareHandlers: () => {
          throw new Error("unexpected VPS OAuth handler request");
        },
      },
    };

    const result = await loginXaiDeviceCode(ctx);

    expect(openUrl).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(expect.stringContaining("ABCD-1234"), "xAI device code");
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
    expect(progress.stop).toHaveBeenCalledWith("xAI device code complete");
  });
});
