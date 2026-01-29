import { describe, expect, it, beforeEach } from "vitest";

import {
  authorizeGatewayConnect,
  checkRateLimit,
  recordAuthFailure,
  resetRateLimiter,
} from "./auth.js";

describe("gateway auth", () => {
  it("does not throw when req is missing socket", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "secret" },
      // Regression: avoid crashing on req.socket.remoteAddress when callers pass a non-IncomingMessage.
      req: {} as never,
    });
    expect(res.ok).toBe(true);
  });

  it("reports missing and mismatched token reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("token_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("token_mismatch");
  });

  it("reports missing token config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", allowTailscale: false },
      connectAuth: { token: "anything" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("token_missing_config");
  });

  it("reports missing and mismatched password reasons", async () => {
    const missing = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: null,
    });
    expect(missing.ok).toBe(false);
    expect(missing.reason).toBe("password_missing");

    const mismatch = await authorizeGatewayConnect({
      auth: { mode: "password", password: "secret", allowTailscale: false },
      connectAuth: { password: "wrong" },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toBe("password_mismatch");
  });

  it("reports missing password config reason", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "password", allowTailscale: false },
      connectAuth: { password: "secret" },
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("password_missing_config");
  });

  it("treats local tailscale serve hostnames as direct", async () => {
    const res = await authorizeGatewayConnect({
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

  it("allows tailscale identity to satisfy token mode auth", async () => {
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: true },
      connectAuth: null,
      tailscaleWhois: async () => ({ login: "peter", name: "Peter" }),
      req: {
        socket: { remoteAddress: "127.0.0.1" },
        headers: {
          host: "gateway.local",
          "x-forwarded-for": "100.64.0.1",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "ai-hub.bone-egret.ts.net",
          "tailscale-user-login": "peter",
          "tailscale-user-name": "Peter",
        },
      } as never,
    });

    expect(res.ok).toBe(true);
    expect(res.method).toBe("tailscale");
    expect(res.user).toBe("peter");
  });
});

describe("rate limiting", () => {
  const mockReq = (ip: string) => ({ socket: { remoteAddress: ip } }) as never;

  beforeEach(() => {
    resetRateLimiter();
  });

  it("allows requests initially", () => {
    const result = checkRateLimit(mockReq("192.0.2.1"));
    expect(result.allowed).toBe(true);
    expect(result.retryAfterMs).toBeUndefined();
  });

  it("allows requests after fewer than 5 failures", () => {
    const req = mockReq("192.0.2.2");
    for (let i = 0; i < 4; i++) {
      recordAuthFailure(req);
    }
    const result = checkRateLimit(req);
    expect(result.allowed).toBe(true);
  });

  it("blocks requests after 5 failures", () => {
    const req = mockReq("192.0.2.3");
    for (let i = 0; i < 5; i++) {
      recordAuthFailure(req);
    }
    const result = checkRateLimit(req);
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.retryAfterMs).toBeLessThanOrEqual(60000);
  });

  it("tracks different IPs independently", () => {
    const req1 = mockReq("192.0.2.10");
    const req2 = mockReq("192.0.2.20");

    // Exhaust rate limit for req1
    for (let i = 0; i < 5; i++) {
      recordAuthFailure(req1);
    }

    // req1 should be blocked
    expect(checkRateLimit(req1).allowed).toBe(false);

    // req2 should still be allowed
    expect(checkRateLimit(req2).allowed).toBe(true);
  });

  it("uses 'unknown' key when socket is missing", () => {
    const reqWithoutSocket = {} as never;
    for (let i = 0; i < 5; i++) {
      recordAuthFailure(reqWithoutSocket);
    }
    expect(checkRateLimit(reqWithoutSocket).allowed).toBe(false);
  });

  it("integrates with authorizeGatewayConnect", async () => {
    const req = mockReq("192.0.2.100");

    // Fail auth 5 times
    for (let i = 0; i < 5; i++) {
      const res = await authorizeGatewayConnect({
        auth: { mode: "token", token: "secret", allowTailscale: false },
        connectAuth: { token: "wrong" },
        req,
      });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("token_mismatch");
    }

    // 6th attempt should be rate limited
    const res = await authorizeGatewayConnect({
      auth: { mode: "token", token: "secret", allowTailscale: false },
      connectAuth: { token: "correct" }, // Even correct token should be blocked
      req,
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("rate_limited");
  });
});
