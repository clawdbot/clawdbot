import type { IncomingMessage } from "node:http";
// Gateway auth tests cover shared-secret, Tailscale, loopback, forwarded-header,
// control-UI, and HTTP/WebSocket authorization decisions.
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeNetworkInterfacesSnapshot } from "../test-helpers/network-interfaces.js";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import {
  assertGatewayAuthConfigured,
  authorizeHttpGatewayConnect,
  authorizeUserProfileAvatarHttpGatewayConnect,
  resolveEffectiveSharedGatewayAuth,
  authorizeWsControlUiGatewayConnect,
  resolveGatewayAuth,
} from "./auth.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { hasForwardedRequestHeaders, isLocalDirectRequest } from "./net.js";

function createLimiterSpy(): AuthRateLimiter & {
  check: ReturnType<typeof vi.fn>;
  recordFailure: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
} {
  const check = vi.fn<AuthRateLimiter["check"]>(
    (_ip, _scope) => ({ allowed: true, remaining: 10, retryAfterMs: 0 }) as const,
  );
  const recordFailure = vi.fn<AuthRateLimiter["recordFailure"]>((_ip, _scope) => {});
  const recordFailureAndDelay = vi.fn<AuthRateLimiter["recordFailureAndDelay"]>(
    async (ip, scope) => {
      recordFailure(ip, scope);
    },
  );
  const reset = vi.fn<AuthRateLimiter["reset"]>((_ip, _scope) => {});
  return {
    check,
    recordFailure,
    recordFailureAndDelay,
    reset,
    size: () => 0,
    prune: () => {},
    dispose: () => {},
  };
}

type TailscaleForwardedRequest = IncomingMessage & {
  socket: IncomingMessage["socket"] & { remoteAddress?: string };
  headers: IncomingMessage["headers"] & Record<string, string | undefined>;
};

function createTailscaleForwardedReq(managed = true): TailscaleForwardedRequest {
  const req = {
    socket: { remoteAddress: "127.0.0.1", localPort: 18_789 },
    headers: {
      host: "gateway.local",
      "x-forwarded-for": "100.64.0.1",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "ai-hub.bone-egret.ts.net",
      "tailscale-user-login": "peter@github",
      "tailscale-user-name": "Peter",
      "tailscale-user-profile-pic": "https://avatars.example.test/peter.png",
      "sec-fetch-site": "same-origin",
    },
  } as unknown as TailscaleForwardedRequest;
  if (managed) {
    markGatewayIngressTransport(req, { kind: "managed-tailscale", mode: "serve" });
  }
  return req;
}

function createTailscaleWhois() {
  return async () => ({ login: "peter@github", name: "Peter" });
}

function createAvatarBrowserOriginPolicy(
  req: TailscaleForwardedRequest,
  allowedOrigins: string[] = [],
) {
  return {
    requestHost: req.headers.host,
    origin: req.headers.origin,
    fetchSite: req.headers["sec-fetch-site"],
    allowedOrigins,
  };
}

describe("gateway auth", () => {
  async function expectTokenMismatchWithLimiter(params: {
    reqHeaders: Record<string, string>;
    allowRealIpFallback?: boolean;
  }) {
    const limiter = createLimiterSpy();
    const res = await authorizeWsControlUiGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: params.reqHeaders,
      } as never,
      trustedProxies: ["127.0.0.1"],
      ...(params.allowRealIpFallback ? { allowRealIpFallback: true } : {}),
      rateLimiter: limiter,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_mismatch");
    return limiter;
  }

  async function expectTailscaleHeaderAuthResult(params: {
    authorize:
      | typeof authorizeHttpGatewayConnect
      | typeof authorizeUserProfileAvatarHttpGatewayConnect
      | typeof authorizeWsControlUiGatewayConnect;
    expected: { ok: false; reason: string } | { ok: true; method: string; user: string };
  }) {
    const req = createTailscaleForwardedReq();
    const res = await params.authorize({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: createTailscaleWhois(),
      req,
      browserOriginPolicy: createAvatarBrowserOriginPolicy(req),
    });
    expect(res.ok).toBe(params.expected.ok);
    if (!params.expected.ok) {
      expect(res.reason).toBe(params.expected.reason);
      return;
    }
    expect(res.method).toBe(params.expected.method);
    expect(res.user).toBe(params.expected.user);
  }

  it("resolves token/password from OPENCLAW gateway env vars", () => {
    const auth = resolveGatewayAuth({
      authConfig: {},
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password",
      } as NodeJS.ProcessEnv,
    });

    expect(auth.mode).toBe("password");
    expect(auth.modeSource).toBe("password");
    expect(auth.token).toBe("env-token");
    expect(auth.password).toBe("env-password");
  });

  it("resolves the active shared token auth only", () => {
    expect(
      resolveEffectiveSharedGatewayAuth({
        authConfig: {
          mode: "token",
          token: "config-token",
          password: "config-password",
        },
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toEqual({
      mode: "token",
      secret: "config-token",
    });
  });

  it("resolves the active shared password auth only", () => {
    expect(
      resolveEffectiveSharedGatewayAuth({
        authConfig: {
          mode: "password",
          token: "config-token",
          password: "config-password",
        },
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toEqual({
      mode: "password",
      secret: "config-password",
    });
  });

  it.each([
    { name: "Forwarded", headers: { forwarded: "for=203.0.113.10;proto=https" } },
    { name: "X-Forwarded-For", headers: { "x-forwarded-for": "203.0.113.10" } },
    { name: "X-Forwarded-Proto", headers: { "x-forwarded-proto": "https" } },
    { name: "X-Forwarded-Host", headers: { "x-forwarded-host": "gateway.example" } },
    { name: "X-Forwarded-User", headers: { "x-forwarded-user": "nick@example.com" } },
    { name: "X-Real-IP", headers: { "x-real-ip": "203.0.113.10" } },
    { name: "empty Forwarded", headers: { forwarded: "" } },
    { name: "empty X-Real-IP", headers: { "x-real-ip": "" } },
  ])("treats $name as forwarded request evidence", ({ headers }) => {
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      headers,
    } as never;

    expect(hasForwardedRequestHeaders(req)).toBe(true);
    expect(isLocalDirectRequest(req)).toBe(false);
  });

  it("keeps clean loopback requests eligible for direct-local handling", () => {
    const req = {
      socket: { remoteAddress: "127.0.0.1" },
      headers: { host: "127.0.0.1:18789" },
    } as never;

    expect(hasForwardedRequestHeaders(req)).toBe(false);
    expect(isLocalDirectRequest(req)).toBe(true);
  });

  it("returns null for non-shared gateway auth modes", () => {
    expect(
      resolveEffectiveSharedGatewayAuth({
        authConfig: { mode: "none" },
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toBeNull();
    expect(
      resolveEffectiveSharedGatewayAuth({
        authConfig: {
          mode: "trusted-proxy",
          trustedProxy: { userHeader: "x-user" },
        },
        env: {} as NodeJS.ProcessEnv,
      }),
    ).toBeNull();
  });

  it("keeps gateway auth config values ahead of env overrides", () => {
    const auth = resolveGatewayAuth({
      authConfig: {
        token: "config-token",
        password: "config-password", // pragma: allowlist secret
      },
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password",
      } as NodeJS.ProcessEnv,
    });

    expect(auth.token).toBe("config-token");
    expect(auth.password).toBe("config-password"); // pragma: allowlist secret
  });

  it("treats env-template auth secrets as SecretRefs instead of plaintext", () => {
    const auth = resolveGatewayAuth({
      authConfig: {
        token: "${OPENCLAW_GATEWAY_TOKEN}",
        password: "${OPENCLAW_GATEWAY_PASSWORD}",
      },
      env: {
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_GATEWAY_PASSWORD: "env-password",
      } as NodeJS.ProcessEnv,
    });

    expect(auth.token).toBe("env-token");
    expect(auth.password).toBe("env-password");
    expect(auth.mode).toBe("password");
  });

  it("resolves explicit auth mode none from config", () => {
    const auth = resolveGatewayAuth({
      authConfig: { mode: "none" },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(auth.mode).toBe("none");
    expect(auth.modeSource).toBe("config");
    expect(auth.token).toBeUndefined();
    expect(auth.password).toBeUndefined();
  });

  it("marks mode source as override when runtime mode override is provided", () => {
    const auth = resolveGatewayAuth({
      authConfig: { mode: "password", password: "config-password" }, // pragma: allowlist secret
      authOverride: { mode: "token" },
      env: {} as NodeJS.ProcessEnv,
    });

    expect(auth.mode).toBe("token");
    expect(auth.modeSource).toBe("override");
    expect(auth.token).toBeUndefined();
    expect(auth.password).toBe("config-password"); // pragma: allowlist secret
  });

  it("authorizes matching token auth when req is missing socket", async () => {
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "secret" },
      // Regression: avoid crashing on req.socket.remoteAddress when callers pass a non-IncomingMessage.
      req: {} as never,
    });
    expect(res.ok).toBe(true);
  });

  it("reports missing and mismatched token reasons", async () => {
    const missing = await authorizeHttpGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("token_missing");

    const mismatch = await authorizeHttpGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("token_mismatch");
  });

  it("reports missing token config reason", async () => {
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "token", allowTailscale: false },
      connectAuth: { token: "anything" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_missing_config");
  });

  it("allows explicit auth mode none", async () => {
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "none", allowTailscale: false },
      connectAuth: null,
    });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("none");
  });

  it("rejects HTTP requests with disallowed Origin under auth mode none", async () => {
    await expect(
      authorizeHttpGatewayConnect({
        auth: { mode: "none", allowTailscale: false },
        connectAuth: null,
        req: {
          socket: { remoteAddress: "10.0.0.1" },
          headers: {
            host: "gateway.example.com",
            origin: "https://evil.example",
          },
        } as never,
        browserOriginPolicy: {
          requestHost: "gateway.example.com",
          origin: "https://evil.example",
          allowedOrigins: ["https://control.example.com"],
        },
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "origin_not_allowed",
    });
  });

  it("accepts HTTP requests with allowed Origin under auth mode none", async () => {
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "none", allowTailscale: false },
      connectAuth: null,
      req: {
        socket: { remoteAddress: "10.0.0.1" },
        headers: {
          host: "gateway.example.com",
          origin: "https://control.example.com",
        },
      } as never,
      browserOriginPolicy: {
        requestHost: "gateway.example.com",
        origin: "https://control.example.com",
        allowedOrigins: ["https://control.example.com"],
      },
    });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("none");
  });

  it("keeps origin-less HTTP requests working under auth mode none", async () => {
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "none", allowTailscale: false },
      connectAuth: null,
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "localhost" },
      } as never,
      browserOriginPolicy: {
        requestHost: "localhost",
        allowedOrigins: ["https://control.example.com"],
      },
    });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("none");
  });

  it("accepts HTTP requests with local loopback Origin under localDirect auth mode none", async () => {
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "none", allowTailscale: false },
      connectAuth: null,
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "127.0.0.1",
          origin: "http://localhost:5173",
        },
      } as never,
      browserOriginPolicy: {
        requestHost: "127.0.0.1",
        origin: "http://localhost:5173",
      },
    });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("none");
  });

  it("does not apply the none-mode Origin policy to authenticated HTTP clients", async () => {
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "secret" },
      req: {
        socket: { remoteAddress: "10.0.0.1" },
        headers: {
          host: "gateway.example.com",
          origin: "https://app.example",
        },
      } as never,
      browserOriginPolicy: {
        requestHost: "gateway.example.com",
        origin: "https://app.example",
        allowedOrigins: ["https://control.example.com"],
      },
    });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("token");
  });

  it("keeps none mode authoritative even when token is present", async () => {
    const auth = resolveGatewayAuth({
      authConfig: { mode: "none", token: "configured-token" },
      env: {} as NodeJS.ProcessEnv,
    });
    expect(auth.mode).toBe("none");
    expect(auth.modeSource).toBe("config");
    expect(auth.token).toBe("configured-token");

    const res = await authorizeHttpGatewayConnect({
      auth,
      connectAuth: null,
    });
    expect(res.ok).toBe(true);
    expect(res.method).toBe("none");
  });

  it("reports missing and mismatched password reasons", async () => {
    const missing = await authorizeHttpGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("password_missing");

    const mismatch = await authorizeHttpGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("password_mismatch");
  });

  it("reports missing password config reason", async () => {
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "password", allowTailscale: false },
      connectAuth: { password: "secret" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_missing_config");
  });

  it("treats local tailscale serve hostnames as direct", async () => {
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: { token: "secret" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "gateway.tailnet-1234.ts.net:443" },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("token");
  });

  it("does not allow tailscale identity to satisfy token mode auth by default", async () => {
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: createTailscaleWhois(),
      req: createTailscaleForwardedReq(),
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_missing");
  });

  it("allows tailscale identity when header auth is explicitly enabled", async () => {
    const res = await authorizeWsControlUiGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: createTailscaleWhois(),
      req: createTailscaleForwardedReq(),
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("tailscale");
    expect(res.user).toBe("peter@github");
    expect(res.tailscaleIdentity).toEqual({
      login: "peter@github",
      name: "Peter",
      profilePic: "https://avatars.example.test/peter.png",
    });
  });

  it("rejects matching Tailscale-shaped identity without managed Serve provenance", async () => {
    const req = createTailscaleForwardedReq(false);

    const res = await authorizeWsControlUiGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: createTailscaleWhois(),
      req,
    });

    expect(res).toEqual({ ok: false, reason: "proxy_attribution_required" });
  });

  it("keeps externally managed Tailscale ingress on ordinary trusted-proxy auth semantics", async () => {
    const tailscaleWhois = vi.fn(createTailscaleWhois());
    const authorize = (connectAuth: { token: string } | null) =>
      authorizeWsControlUiGatewayConnect({
        auth: { mode: "token", token: "secret", allowTailscale: true },
        connectAuth,
        tailscaleWhois,
        req: createTailscaleForwardedReq(false),
        trustedProxies: ["127.0.0.1"],
      });

    await expect(authorize({ token: "secret" })).resolves.toMatchObject({
      ok: true,
      method: "token",
    });
    await expect(authorize(null)).resolves.toEqual({ ok: false, reason: "token_missing" });
    expect(tailscaleWhois).not.toHaveBeenCalled();
  });

  it("keeps managed Serve shared-secret auth independent of WhoIs availability", async () => {
    const limiter = createAuthRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
      pruneIntervalMs: 0,
    });
    const tailscaleWhois = vi.fn(async () => null);
    const params = {
      auth: { mode: "token" as const, token: "secret", allowTailscale: true },
      tailscaleWhois,
      req: createTailscaleForwardedReq(),
      rateLimiter: limiter,
    };

    try {
      await expect(
        authorizeWsControlUiGatewayConnect({
          ...params,
          connectAuth: { token: "secret" },
        }),
      ).resolves.toMatchObject({ ok: true, method: "token" });
      expect(tailscaleWhois).not.toHaveBeenCalled();

      await expect(
        authorizeWsControlUiGatewayConnect({
          ...params,
          connectAuth: { token: "wrong" },
        }),
      ).resolves.toMatchObject({ ok: false, reason: "token_mismatch" });
      await expect(
        authorizeWsControlUiGatewayConnect({
          ...params,
          connectAuth: { token: "secret" },
        }),
      ).resolves.toMatchObject({ ok: false, reason: "rate_limited" });
    } finally {
      limiter.dispose();
    }
  });

  it("keeps managed Serve failures isolated to each validated source", async () => {
    const limiter = createAuthRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
      pruneIntervalMs: 0,
    });
    const first = createTailscaleForwardedReq();
    const second = createTailscaleForwardedReq();
    second.headers["x-forwarded-for"] = "100.64.0.2";

    try {
      await expect(
        authorizeWsControlUiGatewayConnect({
          auth: { mode: "token", token: "secret", allowTailscale: true },
          connectAuth: { token: "wrong" },
          req: first,
          rateLimiter: limiter,
        }),
      ).resolves.toMatchObject({ ok: false, reason: "token_mismatch" });
      await expect(
        authorizeWsControlUiGatewayConnect({
          auth: { mode: "token", token: "secret", allowTailscale: true },
          connectAuth: { token: "secret" },
          req: second,
          rateLimiter: limiter,
        }),
      ).resolves.toMatchObject({ ok: true, method: "token" });
      await expect(
        authorizeWsControlUiGatewayConnect({
          auth: { mode: "token", token: "secret", allowTailscale: true },
          connectAuth: { token: "secret" },
          req: first,
          rateLimiter: limiter,
        }),
      ).resolves.toMatchObject({ ok: false, reason: "rate_limited" });
    } finally {
      limiter.dispose();
    }
  });

  it("verifies managed Serve identity before a same-source shared-secret lockout", async () => {
    const limiter = createAuthRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
      pruneIntervalMs: 0,
    });
    const auth = { mode: "token" as const, token: "secret", allowTailscale: true };

    try {
      await expect(
        authorizeWsControlUiGatewayConnect({
          auth,
          connectAuth: { token: "wrong" },
          req: createTailscaleForwardedReq(),
          rateLimiter: limiter,
        }),
      ).resolves.toMatchObject({ ok: false, reason: "token_mismatch" });
      expect(limiter.check("100.64.0.1", "shared-secret").allowed).toBe(false);

      await expect(
        authorizeWsControlUiGatewayConnect({
          auth,
          connectAuth: null,
          tailscaleWhois: createTailscaleWhois(),
          req: createTailscaleForwardedReq(),
          rateLimiter: limiter,
        }),
      ).resolves.toMatchObject({ ok: true, method: "tailscale", user: "peter@github" });
      expect(limiter.check("100.64.0.1", "shared-secret").allowed).toBe(true);
    } finally {
      limiter.dispose();
    }
  });

  it("keeps verified managed Serve usable after an unrelated proxy failure", async () => {
    const limiter = createAuthRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
      pruneIntervalMs: 0,
    });

    try {
      await expect(
        authorizeHttpGatewayConnect({
          auth: { mode: "token", token: "secret", allowTailscale: true },
          connectAuth: { token: "wrong" },
          req: {
            socket: { remoteAddress: "127.0.0.1" },
            headers: { "x-forwarded-for": "203.0.113.10" },
          } as never,
          trustedProxies: ["127.0.0.1"],
          rateLimiter: limiter,
        }),
      ).resolves.toMatchObject({ ok: false, reason: "token_mismatch" });

      await expect(
        authorizeWsControlUiGatewayConnect({
          auth: { mode: "token", token: "secret", allowTailscale: true },
          connectAuth: null,
          tailscaleWhois: createTailscaleWhois(),
          req: createTailscaleForwardedReq(),
          rateLimiter: limiter,
        }),
      ).resolves.toMatchObject({ ok: true, method: "tailscale", user: "peter@github" });
      expect(limiter.check("203.0.113.10", "shared-secret").allowed).toBe(false);
    } finally {
      limiter.dispose();
    }
  });

  it("serializes managed Serve auth through the delayed failure write", async () => {
    let locked = false;
    let markFailureStarted!: () => void;
    let releaseFailure!: () => void;
    const failureStarted = new Promise<void>((resolve) => {
      markFailureStarted = resolve;
    });
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const recordFailureAndDelay = vi.fn(async () => {
      markFailureStarted();
      await failureGate;
      locked = true;
    });
    const reset = vi.fn(() => {
      locked = false;
    });
    const limiter: AuthRateLimiter = {
      check: vi.fn(() => ({
        allowed: !locked,
        remaining: locked ? 0 : 1,
        retryAfterMs: locked ? 60_000 : 0,
      })),
      recordFailure: vi.fn(() => {
        locked = true;
      }),
      recordFailureAndDelay,
      reset,
      size: () => Number(locked),
      prune: () => {},
      dispose: () => {},
    };
    const authorize = (token: string) =>
      authorizeWsControlUiGatewayConnect({
        auth: { mode: "token", token: "secret", allowTailscale: true },
        connectAuth: { token },
        req: createTailscaleForwardedReq(),
        rateLimiter: limiter,
      });

    const first = authorize("wrong");
    await failureStarted;
    const second = authorize("secret");
    releaseFailure();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { ok: false, reason: "token_mismatch" },
      { ok: false, reason: "rate_limited" },
    ]);
    expect(recordFailureAndDelay).toHaveBeenCalledOnce();
    expect(reset).not.toHaveBeenCalled();
  });

  it("uses password auth for managed Funnel", async () => {
    const req = createTailscaleForwardedReq(false);
    req.headers["tailscale-funnel-request"] = "?1";
    markGatewayIngressTransport(req, { kind: "managed-tailscale", mode: "funnel" });

    await expect(
      authorizeWsControlUiGatewayConnect({
        auth: { mode: "password", password: "secret", allowTailscale: false },
        connectAuth: { password: "secret" },
        req,
      }),
    ).resolves.toMatchObject({ ok: true, method: "password" });
  });

  it("allows an origin-less same-origin image through the profile avatar surface", async () => {
    const limiter = createLimiterSpy();
    const req = createTailscaleForwardedReq();
    const res = await authorizeUserProfileAvatarHttpGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: createTailscaleWhois(),
      req,
      rateLimiter: limiter,
      browserOriginPolicy: createAvatarBrowserOriginPolicy(req),
    });

    expect(res).toMatchObject({ ok: true, method: "tailscale", user: "peter@github" });
    expect(limiter.check).not.toHaveBeenCalled();
    expect(limiter.reset).toHaveBeenCalledWith("100.64.0.1", "shared-secret");
  });

  it("rejects a cross-origin page before verifying Tailscale avatar identity", async () => {
    const req = createTailscaleForwardedReq();
    req.headers.origin = "https://evil.example";
    req.headers["sec-fetch-site"] = "cross-site";
    const tailscaleWhois = vi.fn(createTailscaleWhois());

    const res = await authorizeUserProfileAvatarHttpGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois,
      req,
      browserOriginPolicy: createAvatarBrowserOriginPolicy(req, ["https://control.example.com"]),
    });

    expect(res).toMatchObject({ ok: false, reason: "origin_not_allowed" });
    expect(tailscaleWhois).not.toHaveBeenCalled();
  });

  it("rejects wildcard origin grants for ambient Tailscale avatar identity", async () => {
    const req = createTailscaleForwardedReq();
    req.headers.origin = "https://evil.example";
    req.headers["sec-fetch-site"] = "cross-site";
    const tailscaleWhois = vi.fn(createTailscaleWhois());

    const res = await authorizeUserProfileAvatarHttpGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois,
      req,
      browserOriginPolicy: createAvatarBrowserOriginPolicy(req, ["*"]),
    });

    expect(res).toMatchObject({ ok: false, reason: "origin_not_allowed" });
    expect(tailscaleWhois).not.toHaveBeenCalled();
  });

  it("allows an approved Control UI origin before verifying Tailscale avatar identity", async () => {
    const req = createTailscaleForwardedReq();
    req.headers.origin = "https://control.example.com";
    req.headers["sec-fetch-site"] = "cross-site";
    const tailscaleWhois = vi.fn(createTailscaleWhois());

    const res = await authorizeUserProfileAvatarHttpGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois,
      req,
      browserOriginPolicy: createAvatarBrowserOriginPolicy(req, ["https://control.example.com"]),
    });

    expect(res).toMatchObject({ ok: true, method: "tailscale", user: "peter@github" });
    expect(tailscaleWhois).toHaveBeenCalledOnce();
  });

  it.each(["cross-site", "same-site", "none", undefined])(
    "rejects an origin-less avatar request with fetch-site %s",
    async (fetchSite) => {
      const req = createTailscaleForwardedReq();
      if (fetchSite === undefined) {
        delete req.headers["sec-fetch-site"];
      } else {
        req.headers["sec-fetch-site"] = fetchSite;
      }
      const tailscaleWhois = vi.fn(createTailscaleWhois());

      const res = await authorizeUserProfileAvatarHttpGatewayConnect({
        auth: { mode: "token", token: "secret", allowTailscale: true },
        connectAuth: null,
        tailscaleWhois,
        req,
        browserOriginPolicy: createAvatarBrowserOriginPolicy(req),
      });

      expect(res).toMatchObject({ ok: false, reason: "origin_not_allowed" });
      expect(tailscaleWhois).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "missing identity",
      mutate: (req: ReturnType<typeof createTailscaleForwardedReq>) => {
        delete req.headers["tailscale-user-login"];
      },
      whois: createTailscaleWhois(),
      expectedReason: "token_missing",
    },
    {
      name: "mismatched identity",
      mutate: () => {},
      whois: async () => ({ login: "mallory", name: "Mallory" }),
      expectedReason: "token_missing",
    },
    {
      name: "non-loopback source",
      mutate: (req: ReturnType<typeof createTailscaleForwardedReq>) => {
        req.socket.remoteAddress = "192.0.2.10";
      },
      whois: createTailscaleWhois(),
      expectedReason: "proxy_attribution_required",
    },
    {
      name: "incomplete forwarded headers",
      mutate: (req: ReturnType<typeof createTailscaleForwardedReq>) => {
        delete req.headers["x-forwarded-host"];
      },
      whois: createTailscaleWhois(),
      expectedReason: "proxy_attribution_required",
    },
  ])(
    "rejects $name on the profile avatar HTTP surface",
    async ({ mutate, whois, expectedReason }) => {
      const req = createTailscaleForwardedReq();
      mutate(req);

      const res = await authorizeUserProfileAvatarHttpGatewayConnect({
        auth: { mode: "token", token: "secret", allowTailscale: true },
        connectAuth: null,
        tailscaleWhois: whois,
        req,
        browserOriginPolicy: createAvatarBrowserOriginPolicy(req),
      });

      expect(res).toMatchObject({ ok: false, reason: expectedReason });
    },
  );

  it.each([
    {
      auth: { mode: "token" as const, token: "secret", allowTailscale: true },
      connectAuth: { token: "secret" },
      tailscaleWhois: createTailscaleWhois(),
      method: "token",
    },
    {
      auth: { mode: "password" as const, password: "secret", allowTailscale: true },
      connectAuth: { password: "secret" },
      tailscaleWhois: createTailscaleWhois(),
      method: "password",
    },
  ])("keeps $method auth on the profile avatar HTTP surface", async (testCase) => {
    const req = createTailscaleForwardedReq();
    req.headers.origin = "https://evil.example";
    req.headers["sec-fetch-site"] = "cross-site";
    const res = await authorizeUserProfileAvatarHttpGatewayConnect({
      ...testCase,
      req,
      browserOriginPolicy: createAvatarBrowserOriginPolicy(req, ["*"]),
    });

    expect(res).toMatchObject({ ok: true, method: testCase.method });
  });

  it("keeps tailscale header auth disabled on HTTP auth wrapper", async () => {
    await expectTailscaleHeaderAuthResult({
      authorize: authorizeHttpGatewayConnect,
      expected: { ok: false, reason: "token_missing" },
    });
  });

  it("enables tailscale header auth on the profile avatar HTTP wrapper", async () => {
    await expectTailscaleHeaderAuthResult({
      authorize: authorizeUserProfileAvatarHttpGatewayConnect,
      expected: { ok: true, method: "tailscale", user: "peter@github" },
    });
  });

  it("enables tailscale header auth on ws control-ui auth wrapper", async () => {
    await expectTailscaleHeaderAuthResult({
      authorize: authorizeWsControlUiGatewayConnect,
      expected: { ok: true, method: "tailscale", user: "peter@github" },
    });
  });

  it("uses proxy-aware request client IP by default for rate-limit checks", async () => {
    const limiter = await expectTokenMismatchWithLimiter({
      reqHeaders: { "x-forwarded-for": "203.0.113.10" },
    });
    expect(limiter.check).toHaveBeenCalledWith("203.0.113.10", "shared-secret");
    expect(limiter.recordFailure).toHaveBeenCalledWith("203.0.113.10", "shared-secret");
  });

  it("rejects unattributable loopback proxy ingress before checking credentials", async () => {
    const limiter = createLimiterSpy();
    const result = await authorizeHttpGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "secret" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { "x-forwarded-for": "203.0.113.10" },
      } as never,
      trustedProxies: [],
      rateLimiter: limiter,
    });

    expect(result).toEqual({ ok: false, reason: "proxy_attribution_required" });
    expect(limiter.check).not.toHaveBeenCalled();
    expect(limiter.recordFailure).not.toHaveBeenCalled();
    expect(limiter.reset).not.toHaveBeenCalled();
  });

  it("accepts attributable loopback proxy ingress after narrow trust configuration", async () => {
    const limiter = createLimiterSpy();
    const result = await authorizeHttpGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "secret" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { "x-forwarded-for": "203.0.113.10" },
      } as never,
      trustedProxies: ["127.0.0.1"],
      rateLimiter: limiter,
    });

    expect(result).toMatchObject({ ok: true, method: "password" });
    expect(limiter.check).toHaveBeenCalledWith("203.0.113.10", "shared-secret");
    expect(limiter.reset).toHaveBeenCalledWith("203.0.113.10", "shared-secret");
  });

  it("keeps trusted-proxy client lockout and reset state isolated by source", async () => {
    const limiter = createAuthRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
      pruneIntervalMs: 0,
    });
    const authorize = async (clientIp: string, password: string) =>
      await authorizeHttpGatewayConnect({
        auth: { mode: "password", password: "secret", allowTailscale: false },
        connectAuth: { password },
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: { "x-forwarded-for": clientIp },
        } as never,
        trustedProxies: ["127.0.0.1"],
        rateLimiter: limiter,
      });

    try {
      await expect(authorize("203.0.113.10", "wrong")).resolves.toMatchObject({
        ok: false,
        reason: "password_mismatch",
      });
      await expect(authorize("203.0.113.11", "secret")).resolves.toMatchObject({
        ok: true,
        method: "password",
      });
      await expect(authorize("203.0.113.10", "secret")).resolves.toMatchObject({
        ok: false,
        reason: "rate_limited",
      });
    } finally {
      limiter.dispose();
    }
  });

  it("keeps genuinely direct loopback requests exempt from lockout", async () => {
    const limiter = createAuthRateLimiter({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
    });
    const params = {
      auth: { mode: "password" as const, password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { host: "127.0.0.1:18789" },
      } as never,
      rateLimiter: limiter,
    };

    try {
      await expect(authorizeHttpGatewayConnect(params)).resolves.toMatchObject({
        ok: false,
        reason: "password_mismatch",
      });
      await expect(authorizeHttpGatewayConnect(params)).resolves.toMatchObject({
        ok: false,
        reason: "password_mismatch",
      });
    } finally {
      limiter.dispose();
    }
  });

  it("rejects X-Real-IP attribution unless fallback is explicitly enabled", async () => {
    const limiter = createLimiterSpy();
    const result = await authorizeWsControlUiGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "secret" },
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: { "x-real-ip": "203.0.113.77" },
      } as never,
      trustedProxies: ["127.0.0.1"],
      rateLimiter: limiter,
    });

    expect(result).toEqual({ ok: false, reason: "proxy_attribution_required" });
    expect(limiter.check).not.toHaveBeenCalled();
    expect(limiter.reset).not.toHaveBeenCalled();
  });

  it("uses X-Real-IP when fallback is explicitly enabled", async () => {
    const limiter = await expectTokenMismatchWithLimiter({
      reqHeaders: { "x-real-ip": "203.0.113.77" },
      allowRealIpFallback: true,
    });
    expect(limiter.check).toHaveBeenCalledWith("203.0.113.77", "shared-secret");
    expect(limiter.recordFailure).toHaveBeenCalledWith("203.0.113.77", "shared-secret");
  });

  it("passes custom rate-limit scope to limiter operations", async () => {
    const limiter = createLimiterSpy();
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
      rateLimiter: limiter,
      rateLimitScope: "custom-scope",
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_mismatch");
    expect(limiter.check).toHaveBeenCalledWith(undefined, "custom-scope");
    expect(limiter.recordFailure).toHaveBeenCalledWith(undefined, "custom-scope");
  });
  it("does not record rate-limit failure for missing token (misconfigured client, not brute-force)", async () => {
    const limiter = createLimiterSpy();
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: null,
      rateLimiter: limiter,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_missing");
    expect(limiter.recordFailure).not.toHaveBeenCalled();
  });

  it("does not record rate-limit failure for missing password (misconfigured client, not brute-force)", async () => {
    const limiter = createLimiterSpy();
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: null,
      rateLimiter: limiter,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_missing");
    expect(limiter.recordFailure).not.toHaveBeenCalled();
  });

  it("still records rate-limit failure for wrong token (brute-force attempt)", async () => {
    const limiter = createLimiterSpy();
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
      rateLimiter: limiter,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_mismatch");
    expect(limiter.recordFailure).toHaveBeenCalled();
  });

  it("still records rate-limit failure for wrong password (brute-force attempt)", async () => {
    const limiter = createLimiterSpy();
    const res = await authorizeHttpGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
      rateLimiter: limiter,
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_mismatch");
    expect(limiter.recordFailure).toHaveBeenCalled();
  });
  it("throws specific error when password is a provider reference object", () => {
    const auth = resolveGatewayAuth({
      authConfig: {
        mode: "password",
        password: { source: "exec", provider: "op", id: "pw" } as never,
      },
    });
    expect(() =>
      assertGatewayAuthConfigured(auth, {
        mode: "password",
        password: { source: "exec", provider: "op", id: "pw" } as never,
      }),
    ).toThrow(/provider reference object/);
  });

  it("accepts password mode when env provides OPENCLAW_GATEWAY_PASSWORD", () => {
    const rawPasswordRef = { source: "exec", provider: "op", id: "pw" } as never;
    const auth = resolveGatewayAuth({
      authConfig: {
        mode: "password",
        password: rawPasswordRef,
      },
      env: {
        OPENCLAW_GATEWAY_PASSWORD: "env-password",
      } as NodeJS.ProcessEnv,
    });

    expect(auth.password).toBe("env-password");
    expect(
      assertGatewayAuthConfigured(auth, {
        mode: "password",
        password: rawPasswordRef,
      }),
    ).toBeUndefined();
  });

  it("throws generic error when password mode has no password at all", () => {
    const auth = resolveGatewayAuth({ authConfig: { mode: "password" } });
    expect(() => assertGatewayAuthConfigured(auth, { mode: "password" })).toThrow(
      "gateway auth mode is password, but no password was configured",
    );
  });
});

describe("trusted-proxy auth", () => {
  function mockLocalInterfaces(nonLoopbackAddress = "10.0.0.2", family: "IPv4" | "IPv6" = "IPv4") {
    const spy = vi.isMockFunction(os.networkInterfaces)
      ? vi.mocked(os.networkInterfaces)
      : vi.spyOn(os, "networkInterfaces");
    spy.mockReturnValue(
      makeNetworkInterfacesSnapshot({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [{ address: nonLoopbackAddress, family }],
      }),
    );
  }

  beforeEach(() => {
    mockLocalInterfaces();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  type GatewayConnectInput = Parameters<typeof authorizeHttpGatewayConnect>[0];
  const trustedProxyConfig = {
    userHeader: "x-forwarded-user",
    requiredHeaders: ["x-forwarded-proto"],
    allowUsers: [],
  };

  function authorizeTrustedProxy(options?: {
    auth?: GatewayConnectInput["auth"];
    trustedProxies?: string[];
    remoteAddress?: string;
    headers?: Record<string, string>;
  }) {
    return authorizeHttpGatewayConnect({
      auth: options?.auth ?? {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: trustedProxyConfig,
      },
      connectAuth: null,
      trustedProxies: options?.trustedProxies ?? ["10.0.0.1"],
      req: {
        socket: { remoteAddress: options?.remoteAddress ?? "10.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-for": "203.0.113.10",
          ...options?.headers,
        },
      } as never,
    });
  }

  it("accepts valid request from trusted proxy", async () => {
    const res = await authorizeTrustedProxy({
      headers: {
        "x-forwarded-user": "nick@example.com",
        "x-forwarded-proto": "https",
      },
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("trusted-proxy");
    expect(res.user).toBe("nick@example.com");
  });

  it("rejects trusted-proxy headers from the host non-loopback interface address", async () => {
    mockLocalInterfaces("10.0.0.1");

    const res = await authorizeTrustedProxy({
      trustedProxies: ["10.0.0.1"],
      remoteAddress: "10.0.0.1",
      headers: {
        "x-forwarded-user": "nick@example.com",
        "x-forwarded-proto": "https",
        "x-openclaw-proxy-auth": "present",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_local_interface_source");
  });

  it("rejects trusted-proxy headers when local interface discovery fails", async () => {
    vi.mocked(os.networkInterfaces).mockImplementation(() => {
      throw new Error("interface discovery failed");
    });

    const res = await authorizeTrustedProxy({
      trustedProxies: ["10.0.0.1"],
      remoteAddress: "10.0.0.1",
      headers: {
        "x-forwarded-user": "nick@example.com",
        "x-forwarded-proto": "https",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_local_interface_check_failed");
  });

  it("rejects trusted-proxy headers from a host IPv6 interface address", async () => {
    mockLocalInterfaces("fd7a:115c:a1e0::1234", "IPv6");

    const res = await authorizeTrustedProxy({
      trustedProxies: ["fd7a:115c:a1e0::1234"],
      remoteAddress: "fd7a:115c:a1e0::1234",
      headers: {
        "x-forwarded-user": "nick@example.com",
        "x-forwarded-proto": "https",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_local_interface_source");
  });

  it("rejects trusted-proxy HTTP requests from origins outside the allowlist", async () => {
    await expect(
      authorizeHttpGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
        },
        connectAuth: null,
        trustedProxies: ["10.0.0.1"],
        req: {
          socket: { remoteAddress: "10.0.0.1" },
          headers: {
            host: "gateway.example.com",
            origin: "https://evil.example",
            "x-forwarded-for": "203.0.113.10",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
          },
        } as never,
        browserOriginPolicy: {
          requestHost: "gateway.example.com",
          origin: "https://evil.example",
          allowedOrigins: ["https://control.example.com"],
        },
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "trusted_proxy_origin_not_allowed",
    });
  });

  it("accepts trusted-proxy HTTP requests from allowed origins", async () => {
    const res = await authorizeHttpGatewayConnect({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: trustedProxyConfig,
      },
      connectAuth: null,
      trustedProxies: ["10.0.0.1"],
      req: {
        socket: { remoteAddress: "10.0.0.1" },
        headers: {
          host: "gateway.example.com",
          origin: "https://control.example.com",
          "x-forwarded-for": "203.0.113.10",
          "x-forwarded-user": "nick@example.com",
          "x-forwarded-proto": "https",
        },
      } as never,
      browserOriginPolicy: {
        requestHost: "gateway.example.com",
        origin: "https://control.example.com",
        allowedOrigins: ["https://control.example.com"],
      },
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("trusted-proxy");
    expect(res.user).toBe("nick@example.com");
  });

  it("keeps origin-less trusted-proxy HTTP requests working", async () => {
    const res = await authorizeHttpGatewayConnect({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: trustedProxyConfig,
      },
      connectAuth: null,
      trustedProxies: ["10.0.0.1"],
      req: {
        socket: { remoteAddress: "10.0.0.1" },
        headers: {
          host: "gateway.example.com",
          "x-forwarded-for": "203.0.113.10",
          "x-forwarded-user": "nick@example.com",
          "x-forwarded-proto": "https",
        },
      } as never,
      browserOriginPolicy: {
        requestHost: "gateway.example.com",
        allowedOrigins: ["https://control.example.com"],
      },
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("trusted-proxy");
    expect(res.user).toBe("nick@example.com");
  });

  it("rejects request from untrusted source", async () => {
    const res = await authorizeTrustedProxy({
      remoteAddress: "192.168.1.100",
      headers: {
        "x-forwarded-user": "attacker@evil.com",
        "x-forwarded-proto": "https",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("proxy_attribution_required");
  });

  it("rejects request with missing user header", async () => {
    const res = await authorizeTrustedProxy({
      headers: {
        "x-forwarded-proto": "https",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_user_missing");
  });

  it("rejects request with missing required headers", async () => {
    const res = await authorizeTrustedProxy({
      headers: {
        "x-forwarded-user": "nick@example.com",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_missing_header_x-forwarded-proto");
  });

  it("rejects user not in allowlist", async () => {
    const res = await authorizeTrustedProxy({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: {
          userHeader: "x-forwarded-user",
          allowUsers: ["admin@example.com", "nick@example.com"],
        },
      },
      headers: {
        "x-forwarded-user": "stranger@other.com",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_user_not_allowed");
  });

  it("accepts user in allowlist", async () => {
    const res = await authorizeTrustedProxy({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: {
          userHeader: "x-forwarded-user",
          allowUsers: ["admin@example.com", "nick@example.com"],
        },
      },
      headers: {
        "x-forwarded-user": "nick@example.com",
      },
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("trusted-proxy");
    expect(res.user).toBe("nick@example.com");
  });

  it("rejects when no trustedProxies configured", async () => {
    const res = await authorizeTrustedProxy({
      trustedProxies: [],
      headers: {
        "x-forwarded-user": "nick@example.com",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_no_proxies_configured");
  });

  it("rejects when trustedProxy config missing", async () => {
    const res = await authorizeTrustedProxy({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
      },
      headers: {
        "x-forwarded-user": "nick@example.com",
      },
    });

    expect(res.ok).toBe(false);
    expect(res.reason).toBe("trusted_proxy_config_missing");
  });

  it.each([
    {
      name: "config token",
      authConfig: {
        mode: "trusted-proxy" as const,
        token: "shared-secret",
        trustedProxy: {
          userHeader: "x-forwarded-user",
        },
      },
      env: undefined,
    },
    {
      name: "environment token",
      authConfig: {
        mode: "trusted-proxy" as const,
        trustedProxy: {
          userHeader: "x-forwarded-user",
        },
      },
      env: {
        OPENCLAW_GATEWAY_TOKEN: "shared-secret",
      } as NodeJS.ProcessEnv,
    },
  ])("rejects trusted-proxy mode when shared token comes from $name", ({ authConfig, env }) => {
    const auth = resolveGatewayAuth({
      authConfig,
      env,
    });

    expect(auth.mode).toBe("trusted-proxy");
    expect(auth.token).toBe("shared-secret");

    expect(() => assertGatewayAuthConfigured(auth, authConfig)).toThrow(/mutually exclusive/);
  });

  it("still requires trustedProxy config before reporting a token conflict", () => {
    const auth = resolveGatewayAuth({
      authConfig: {
        mode: "trusted-proxy",
        token: "shared-secret",
      },
    });

    expect(() =>
      assertGatewayAuthConfigured(auth, {
        mode: "trusted-proxy",
        token: "shared-secret",
      }),
    ).toThrow(/no trustedProxy config was provided/);
  });

  it("supports Pomerium-style headers", async () => {
    const res = await authorizeTrustedProxy({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: {
          userHeader: "x-pomerium-claim-email",
          requiredHeaders: ["x-pomerium-jwt-assertion"],
        },
      },
      trustedProxies: ["172.17.0.1"],
      remoteAddress: "172.17.0.1",
      headers: {
        "x-pomerium-claim-email": "nick@example.com",
        "x-pomerium-jwt-assertion": "eyJ...",
      },
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("trusted-proxy");
    expect(res.user).toBe("nick@example.com");
  });

  it("trims whitespace from user header value", async () => {
    const res = await authorizeTrustedProxy({
      auth: {
        mode: "trusted-proxy",
        allowTailscale: false,
        trustedProxy: {
          userHeader: "x-forwarded-user",
        },
      },
      headers: {
        "x-forwarded-user": "  nick@example.com  ",
      },
    });

    expect(res.ok).toBe(true);
    expect(res.user).toBe("nick@example.com");
  });

  describe("local-direct trusted-proxy requests", () => {
    function authorizeLocalDirect(options?: {
      token?: string;
      connectToken?: string;
      password?: string;
      connectPassword?: string;
      rateLimiter?: AuthRateLimiter;
      trustedProxy?: GatewayConnectInput["auth"]["trustedProxy"];
      trustedProxies?: string[];
    }) {
      return authorizeHttpGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          ...(Object.hasOwn(options ?? {}, "trustedProxy")
            ? { trustedProxy: options?.trustedProxy }
            : { trustedProxy: trustedProxyConfig }),
          token: options?.token,
          password: options?.password, // pragma: allowlist secret
        },
        connectAuth:
          options?.connectToken || options?.connectPassword
            ? { token: options.connectToken, password: options.connectPassword }
            : null,
        rateLimiter: options?.rateLimiter,
        trustedProxies: options?.trustedProxies ?? ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: { host: "localhost" },
        } as never,
      });
    }

    it.each([
      {
        name: "without credentials",
        options: {
          token: "secret",
        },
      },
      {
        name: "with a valid token",
        options: {
          token: "secret",
          connectToken: "secret",
        },
      },
      {
        name: "with a wrong token",
        options: {
          token: "secret",
          connectToken: "wrong",
        },
      },
      {
        name: "when no local token is configured",
        options: {
          connectToken: "secret",
        },
      },
    ])("rejects local-direct request $name", async ({ options }) => {
      const res = await authorizeLocalDirect(options);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_loopback_source");
    });

    it("accepts local-direct password fallback when trusted-proxy auth fails", async () => {
      const limiter = createLimiterSpy();
      const res = await authorizeLocalDirect({
        password: "local-password", // pragma: allowlist secret
        connectPassword: "local-password", // pragma: allowlist secret
        rateLimiter: limiter,
      });

      expect(res).toEqual({ ok: true, method: "password" });
      expect(limiter.check).toHaveBeenCalledWith("127.0.0.1", "shared-secret");
      expect(limiter.reset).toHaveBeenCalledWith("127.0.0.1", "shared-secret");
      expect(limiter.recordFailure).not.toHaveBeenCalled();
    });

    it("rejects wrong local-direct password fallback and records the failure", async () => {
      const limiter = createLimiterSpy();
      const res = await authorizeLocalDirect({
        password: "local-password", // pragma: allowlist secret
        connectPassword: "wrong-password", // pragma: allowlist secret
        rateLimiter: limiter,
      });

      expect(res).toEqual({ ok: false, reason: "password_mismatch" });
      expect(limiter.check).toHaveBeenCalledWith("127.0.0.1", "shared-secret");
      expect(limiter.recordFailure).toHaveBeenCalledWith("127.0.0.1", "shared-secret");
      expect(limiter.reset).not.toHaveBeenCalled();
    });

    it("enforces rate-limit lockout before local-direct password fallback", async () => {
      const limiter = createLimiterSpy();
      limiter.check.mockReturnValueOnce({
        allowed: false,
        remaining: 0,
        retryAfterMs: 2500,
      });

      const res = await authorizeLocalDirect({
        password: "local-password", // pragma: allowlist secret
        connectPassword: "local-password", // pragma: allowlist secret
        rateLimiter: limiter,
      });

      expect(res).toEqual({
        ok: false,
        reason: "rate_limited",
        rateLimited: true,
        retryAfterMs: 2500,
      });
      expect(limiter.recordFailure).not.toHaveBeenCalled();
      expect(limiter.reset).not.toHaveBeenCalled();
    });

    it("accepts local-direct password fallback before required-header failure", async () => {
      const res = await authorizeLocalDirect({
        password: "local-password", // pragma: allowlist secret
        connectPassword: "local-password", // pragma: allowlist secret
        trustedProxy: {
          ...trustedProxyConfig,
          allowLoopback: true,
        },
      });

      expect(res).toEqual({ ok: true, method: "password" });
    });

    it("keeps local-direct trusted-proxy on proxy failure when no password is supplied", async () => {
      const res = await authorizeLocalDirect({
        password: "local-password", // pragma: allowlist secret
      });

      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_loopback_source");
    });

    it("rejects trusted-proxy identity headers from loopback sources", async () => {
      const res = await authorizeHttpGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
        },
        connectAuth: null,
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-for": "203.0.113.10",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
          },
        } as never,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_loopback_source");
    });

    it("accepts same-host trusted-proxy identity headers when loopback is explicitly allowed", async () => {
      const res = await authorizeHttpGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: {
            ...trustedProxyConfig,
            allowLoopback: true,
          },
        },
        connectAuth: null,
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-for": "203.0.113.10",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
          },
        } as never,
      });

      expect(res).toEqual({
        ok: true,
        method: "trusted-proxy",
        user: "nick@example.com",
      });
    });

    it("keeps required header checks for explicitly allowed loopback proxies", async () => {
      const res = await authorizeHttpGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: {
            ...trustedProxyConfig,
            allowLoopback: true,
          },
        },
        connectAuth: null,
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-for": "203.0.113.10",
            "x-forwarded-user": "nick@example.com",
          },
        } as never,
      });

      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_missing_header_x-forwarded-proto");
    });

    it("keeps allowUsers checks for explicitly allowed loopback proxies", async () => {
      const res = await authorizeHttpGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: {
            userHeader: "x-forwarded-user",
            requiredHeaders: ["x-forwarded-proto"],
            allowUsers: ["admin@example.com"],
            allowLoopback: true,
          },
        },
        connectAuth: null,
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-for": "203.0.113.10",
            "x-forwarded-user": "nick@example.com",
            "x-forwarded-proto": "https",
          },
        } as never,
      });

      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_user_not_allowed");
    });

    it("fails closed when forwarded headers are present but the client chain resolves to loopback", async () => {
      const res = await authorizeHttpGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
          password: "secret", // pragma: allowlist secret
        },
        connectAuth: { password: "secret" },
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-for": "127.0.0.1",
            "x-forwarded-proto": "https",
          },
        } as never,
      });

      expect(res.ok).toBe(false);
      expect(res.reason).toBe("proxy_attribution_required");
    });

    it("rejects direct loopback even when Host is not localish", async () => {
      const res = await authorizeHttpGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
          token: "secret",
        },
        connectAuth: { token: "secret" },
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "evil.example",
          },
        } as never,
      });

      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_loopback_source");
    });

    it("rejects same-host proxy request with missing required header", async () => {
      const res = await authorizeHttpGatewayConnect({
        auth: {
          mode: "trusted-proxy",
          allowTailscale: false,
          trustedProxy: trustedProxyConfig,
        },
        connectAuth: null,
        trustedProxies: ["127.0.0.1"],
        req: {
          socket: { remoteAddress: "127.0.0.1" },
          headers: {
            host: "localhost",
            "x-forwarded-user": "nick@example.com",
            // missing x-forwarded-proto (requiredHeader)
          },
        } as never,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("proxy_attribution_required");
    });

    it("still fails closed when trusted-proxy config is missing", async () => {
      const res = await authorizeLocalDirect({
        password: "secret", // pragma: allowlist secret
        connectPassword: "secret", // pragma: allowlist secret
        trustedProxy: undefined,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_config_missing");
    });

    it("still fails closed when trusted proxies are not configured", async () => {
      const res = await authorizeLocalDirect({
        password: "secret", // pragma: allowlist secret
        connectPassword: "secret", // pragma: allowlist secret
        trustedProxies: [],
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("trusted_proxy_no_proxies_configured");
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
